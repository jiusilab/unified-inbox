// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// Receive-only deployment: refuse anything that would send mail.
const sendBlocked = (c: Context) => c.json({ error: "Sending is disabled on this unified inbox (receive-only)." }, 403);
app.post("/api/v1/mailboxes/:mailboxId/emails", sendBlocked);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", sendBlocked);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", sendBlocked);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/version", async (c: AppContext) => {
	const version = await (c.var.mailboxStub as any).getEmailsVersion();
	return c.json({ version });
});

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/batch", async (c: AppContext) => {
	const { ids, action, folder } = (await c.req.json()) as { ids: string[]; action: string; folder?: string };
	if (!Array.isArray(ids) || !["read", "unread", "archive", "trash", "delete"].includes(action))
		return c.json({ error: "Bad request" }, 400);
	const res = await (c.var.mailboxStub as any).batchAction(ids, action, folder);
	const keys = res.removed.flatMap((r: any) => r.attachments.map((att: any) => `attachments/${r.id}/${att.id}/${att.filename}`));
	for (let i = 0; i < keys.length; i += 1000) await c.env.BUCKET.delete(keys.slice(i, i + 1000));
	return c.json({ count: res.count });
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

/** The single mailbox everything is collected into (unified inbox). */
export function unifiedMailboxId(env: Env): string {
	const v = ((env as any).UNIFIED_MAILBOX as string | undefined)?.trim().toLowerCase();
	if (v) return v;
	const domain = (env.DOMAINS || "").split(",")[0]?.trim() || "example.com";
	return `inbox@${domain}`;
}

/** Make sure the unified mailbox exists (settings file in R2 + DO initialised). */
export async function ensureUnifiedMailbox(env: Env) {
	const id = unifiedMailboxId(env);
	const key = `mailboxes/${id}.json`;
	if (!(await env.BUCKET.head(key))) {
		await env.BUCKET.put(key, JSON.stringify({
			fromName: "Unified Inbox", forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" },
		}));
	}
	return env.MAILBOX.get(env.MAILBOX.idFromName(id));
}

/**
 * Inbound mail from Email Routing. Everything (own domain, Hotmail / forum
 * forwards) lands in the unified mailbox. The Worker only buffers the bytes;
 * parsing happens inside the Durable Object to stay within the Free plan's
 * 10 ms Worker CPU limit.
 */
async function receiveEmail(event: { raw: ReadableStream; rawSize: number; to?: string; from?: string }, env: Env, _ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const stub = await ensureUnifiedMailbox(env);
	await (stub as any).ingestRaw(rawEmail, { source: "routing", envelopeTo: event.to ?? null });
}

// -- Sync (manual trigger + status) ----------------------------------

app.post("/api/v1/sync", async (c) => {
	const stub = await ensureUnifiedMailbox(c.env);
	const results = await (stub as any).syncImap();
	return c.json({ results });
});

app.get("/api/v1/sync", async (c) => {
	const stub = await ensureUnifiedMailbox(c.env);
	return c.json(await (stub as any).getSyncStatus());
});

// -- Connected source accounts ("Sign in with Google") ---------------

// Verification codes → Telegram
const uStub = (c: Context) => c.env.MAILBOX.get(c.env.MAILBOX.idFromName(unifiedMailboxId(c.env))) as any;
app.get("/api/v1/otp", async (c) => c.json(await uStub(c).otpSettings()));
app.post("/api/v1/otp/token", async (c) => {
	const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
	return c.json(await uStub(c).otpSetToken(token || ""));
});
app.post("/api/v1/otp/bind", async (c) => c.json(await uStub(c).otpBind()));
app.post("/api/v1/otp/enabled", async (c) => {
	const { enabled } = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
	return c.json(await uStub(c).otpSetEnabled(!!enabled));
});

// Agent API tokens (managed from Settings, behind Access)
app.get("/api/v1/agent-tokens", async (c) =>
	c.json(await (c.env.MAILBOX.get(c.env.MAILBOX.idFromName(unifiedMailboxId(c.env))) as any).agentTokenList()));
app.post("/api/v1/agent-tokens", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { name?: string; sources?: string[] | string };
	const name = String(body.name || "").trim() || "agent";
	const list = Array.isArray(body.sources) ? body.sources : String(body.sources || "").split(/[,，\s]+/);
	const sources = list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(unifiedMailboxId(c.env))) as any;
	return c.json(await stub.agentTokenCreate(name, sources));
});
app.delete("/api/v1/agent-tokens/:id", async (c) =>
	c.json(await (c.env.MAILBOX.get(c.env.MAILBOX.idFromName(unifiedMailboxId(c.env))) as any).agentTokenDelete(c.req.param("id"))));

app.get("/api/v1/accounts", async (c) => {
	const stub = await ensureUnifiedMailbox(c.env);
	return c.json({
		accounts: await (stub as any).listAccounts(),
		googleConfigured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
	});
});

const IMAP_PRESETS: Record<string, string> = {
	"163.com": "imap.163.com", "126.com": "imap.126.com", "yeah.net": "imap.yeah.net",
	"qq.com": "imap.qq.com", "foxmail.com": "imap.qq.com", "sina.com": "imap.sina.com",
	"aliyun.com": "imap.aliyun.com", "139.com": "imap.139.com", "icloud.com": "imap.mail.me.com",
	"yahoo.com": "imap.mail.yahoo.com",
};

const POP3_PRESETS: Record<string, string> = {
	"163.com": "pop.163.com", "126.com": "pop.126.com", "yeah.net": "pop.yeah.net",
	"qq.com": "pop.qq.com", "foxmail.com": "pop.qq.com", "sina.com": "pop.sina.com",
	"aliyun.com": "pop3.aliyun.com", "139.com": "pop.139.com", "yahoo.com": "pop.mail.yahoo.com",
};

app.post("/api/v1/accounts/imap", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; host?: string; port?: number; protocol?: string };
	const protocol = body.protocol === "pop3" ? "pop3" : "imap";
	const email = String(body.email || "").trim();
	const password = String(body.password || "");
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) return c.json({ ok: false, error: "请填写邮箱地址和授权码" }, 400);
	const preset = IMAP_PRESETS[email.split("@")[1].toLowerCase()];
	const presetHost = preset && protocol === "pop3" ? POP3_PRESETS[email.split("@")[1].toLowerCase()] : preset;
	const host = String(body.host || "").trim() || presetHost;
	if (!host) return c.json({ ok: false, error: `不认识这个邮箱的 ${protocol.toUpperCase()} 服务器，请手动填写` }, 400);
	const stub = await ensureUnifiedMailbox(c.env);
	const r = await (stub as any).addImapAccount({ email, password, host, port: Number(body.port) || 0, protocol });
	return c.json(r, r.ok ? 200 : 400);
});

app.delete("/api/v1/accounts/:account", async (c) => {
	const stub = await ensureUnifiedMailbox(c.env);
	return c.json(await (stub as any).removeOAuthAccount(decodeURIComponent(c.req.param("account"))));
});

const GOOGLE_SCOPE = "https://mail.google.com/ openid email";

function oauthRedirectUri(c: Context) {
	return `${new URL(c.req.url).origin}/oauth/google/callback`;
}

function settingsUrl(env: Env, query: string) {
	return `/mailbox/${encodeURIComponent(unifiedMailboxId(env))}/settings?${query}`;
}

app.get("/oauth/google/start", (c) => {
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		return c.text("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on this Worker.", 500);
	}
	const state = crypto.randomUUID();
	const params = new URLSearchParams({
		client_id: c.env.GOOGLE_CLIENT_ID,
		redirect_uri: oauthRedirectUri(c),
		response_type: "code",
		scope: GOOGLE_SCOPE,
		access_type: "offline",
		prompt: "consent select_account",
		include_granted_scopes: "true",
		state,
	});
	c.header("Set-Cookie", `oauth_state=${state}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
	return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/oauth/google/callback", async (c) => {
	const url = new URL(c.req.url);
	const cookieState = (c.req.header("cookie") || "").match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
	const clear = "oauth_state=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
	if (url.searchParams.get("error")) {
		c.header("Set-Cookie", clear);
		return c.redirect(settingsUrl(c.env, `connect_error=${encodeURIComponent(url.searchParams.get("error")!)}`));
	}
	const code = url.searchParams.get("code");
	if (!code || !cookieState || cookieState !== url.searchParams.get("state")) {
		return c.text("Invalid OAuth state. Start again from Settings.", 400);
	}
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: c.env.GOOGLE_CLIENT_ID || "",
			client_secret: c.env.GOOGLE_CLIENT_SECRET || "",
			redirect_uri: oauthRedirectUri(c),
			grant_type: "authorization_code",
		}),
	});
	const tok = (await res.json()) as any;
	c.header("Set-Cookie", clear);
	if (!res.ok || !tok.access_token) {
		return c.redirect(settingsUrl(c.env, `connect_error=${encodeURIComponent(tok.error || "token_exchange_failed")}`));
	}
	if (!String(tok.scope || "").includes("https://mail.google.com/")) {
		return c.redirect(settingsUrl(c.env, "connect_error=mail_scope_not_granted"));
	}
	if (!tok.refresh_token) {
		return c.redirect(settingsUrl(c.env, "connect_error=no_refresh_token"));
	}
	let email = "";
	try {
		const payload = JSON.parse(atob(String(tok.id_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
		email = String(payload.email || "");
	} catch {}
	if (!email) return c.redirect(settingsUrl(c.env, "connect_error=no_email"));
	const stub = await ensureUnifiedMailbox(c.env);
	await (stub as any).addOAuthAccount({
		email,
		refreshToken: tok.refresh_token,
		accessToken: tok.access_token,
		expiresIn: Number(tok.expires_in || 3600),
	});
	return c.redirect(settingsUrl(c.env, `connected=${encodeURIComponent(email)}`));
});

export { app, receiveEmail };
