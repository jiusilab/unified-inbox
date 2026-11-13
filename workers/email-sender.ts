// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound email via the Resend HTTP API.
 *
 * The Resend API key is set by the user in Settings → Sending and stored in the
 * unified mailbox Durable Object's storage; it never leaves the server.
 *
 * See: https://resend.com/docs/api-reference/emails/send-email
 */
import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

/** Error thrown when sending fails; `status` is the HTTP status to return to the client. */
export class SendEmailError extends Error {
	status: 400 | 502;
	constructor(message: string, status: 400 | 502 = 502) {
		super(message);
		this.name = "SendEmailError";
		this.status = status;
	}
}

function unifiedId(env: Env): string {
	const v = ((env as any).UNIFIED_MAILBOX as string | undefined)?.trim().toLowerCase();
	if (v) return v;
	const domain = (env.DOMAINS || "").split(",")[0]?.trim() || "example.com";
	return `inbox@${domain}`;
}

/** Read the Resend API key from the unified mailbox DO (or a RESEND_API_KEY secret as fallback). */
export async function getResendKey(env: Env): Promise<string | null> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(unifiedId(env))) as any;
	const k = (await stub.sendingGetKey()) as string | null;
	return k || ((env as any).RESEND_API_KEY as string | undefined) || null;
}

function addr(a: string | { email: string; name: string }): string {
	if (typeof a === "string") return a;
	const name = a.name?.replace(/["\r\n]/g, "").trim();
	return name ? `"${name}" <${a.email}>` : a.email;
}

/**
 * Send an email through Resend. Resolves only after Resend accepted the message.
 *
 * @throws SendEmailError (status 400 when no key is configured, 502 when Resend rejects)
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const apiKey = await getResendKey(env);
	if (!apiKey) throw new SendEmailError("Resend API key not configured (Settings → Sending)", 400);

	const body: Record<string, unknown> = {
		from: addr(params.from),
		to: params.to,
		subject: params.subject,
	};
	if (params.html) body.html = params.html;
	if (params.text) body.text = params.text;
	if (params.cc && (Array.isArray(params.cc) ? params.cc.length : params.cc)) body.cc = params.cc;
	if (params.bcc && (Array.isArray(params.bcc) ? params.bcc.length : params.bcc)) body.bcc = params.bcc;
	if (params.replyTo) body.reply_to = addr(params.replyTo);
	if (params.headers && Object.keys(params.headers).length > 0) body.headers = params.headers;
	if (params.attachments && params.attachments.length > 0) {
		body.attachments = params.attachments.map((att) => ({
			filename: att.filename,
			content: att.content,
			...(att.type ? { content_type: att.type } : {}),
			...(att.disposition === "inline" && att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	let res: Response;
	try {
		res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (e) {
		throw new SendEmailError(`Could not reach Resend: ${(e as Error).message}`);
	}

	const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
	if (!res.ok || !data.id) {
		const msg = data.message || data.name || `HTTP ${res.status}`;
		throw new SendEmailError(`Resend rejected the message: ${msg}`);
	}
	return { messageId: data.id };
}
