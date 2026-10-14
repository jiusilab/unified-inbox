// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail, ensureUnifiedMailbox, unifiedMailboxId } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// ── Read-only agent API (bearer token, no Access) ─────────────────
// Served on the dedicated AGENT_API_HOST; that host serves nothing else.
const agentApi = new Hono<{ Bindings: Env }>();
agentApi.use("*", async (c, next) => {
	const auth = c.req.header("authorization") || "";
	const token = auth.replace(/^Bearer\s+/i, "").trim();
	if (!token) return c.json({ error: "missing bearer token" }, 401);
	const stub = unifiedStub(c.env) as any;
	const scope = await stub.agentAuth(token);
	if (!scope) return c.json({ error: "invalid token" }, 401);
	c.set("scope" as never, scope as never);
	await next();
});
const clampLimit = (v: string | undefined, d: number) => Math.min(Math.max(Number(v) || d, 1), 100);
function parseSince(v: string | undefined): string | null | undefined {
	if (!v) return null;
	if (/^\d+$/.test(v)) {
		const n = Number(v);
		return new Date(n < 1e12 ? n * 1000 : n).toISOString();
	}
	const t = Date.parse(v);
	return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
agentApi.get("/api/everest/inbox", async (c) => {
	const since = parseSince(c.req.query("since"));
	if (since === undefined) return c.json({ error: "bad since (unix seconds, ms, or ISO time)" }, 400);
	const scope = c.get("scope" as never) as any;
	return c.json(await (unifiedStub(c.env) as any).agentInbox(scope.sources, since, clampLimit(c.req.query("limit"), 50)));
});
agentApi.get("/api/everest/search", async (c) => {
	const q = c.req.query("q") || null;
	const from = c.req.query("from") || null;
	if (!q && !from) return c.json({ error: "need q and/or from" }, 400);
	const since = parseSince(c.req.query("since"));
	if (since === undefined) return c.json({ error: "bad since" }, 400);
	const scope = c.get("scope" as never) as any;
	return c.json(await (unifiedStub(c.env) as any).agentSearch(scope.sources, q, from, since, clampLimit(c.req.query("limit"), 20)));
});
agentApi.get("/api/everest/mail", async (c) => {
	const id = c.req.query("id");
	if (!id) return c.json({ error: "need id" }, 400);
	const scope = c.get("scope" as never) as any;
	const mail = await (unifiedStub(c.env) as any).agentMail(scope.sources, id);
	return mail ? c.json(mail) : c.json({ error: "not found" }, 404);
});
agentApi.all("*", (c) => c.json({ error: "not found" }, 404));

function unifiedStub(env: Env) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(unifiedMailboxId(env)));
}

app.use("*", async (c, next) => {
	const host = new URL(c.req.url).hostname;
	const agentHost = (c.env as any).AGENT_API_HOST as string | undefined;
	if ((agentHost && host === agentHost) || c.req.path.startsWith("/api/everest/")) {
		return agentApi.fetch(c.req.raw, c.env, c.executionCtx);
	}
	await next();
});

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
// MCP endpoint disabled for the unified inbox (receive-only, no external agents).

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		// Hand the whole IMAP sync to the Durable Object (its own CPU budget).
		const stub = await ensureUnifiedMailbox(env);
		const results = await (stub as any).syncImap();
		console.log("imap sync", JSON.stringify(results));
	},
	async email(
		event: { raw: ReadableStream; rawSize: number; to?: string; from?: string },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
