// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** send_email binding removed (receive-only deployment); kept optional for legacy code paths. */
	EMAIL?: any;
	IMAP_GMAIL_USER?: string;
	IMAP_GMAIL_PASS?: string;
	/** Google OAuth client for "Sign in with Google" Gmail accounts. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}
