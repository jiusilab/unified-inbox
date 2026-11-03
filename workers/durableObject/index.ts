// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import PostalMime from "postal-mime";
import { connect } from "cloudflare:sockets";
import { detectOtp, sendTelegram, escapeHtml } from "../otp";
import { syncPop3, testPop3Login, type Pop3Account, type Pop3Store } from "../pop3/sync";
import { syncAccount, testLogin, type IngestMeta, type OpKind, type SyncStore, type SyncSummary, type ImapAccount } from "../imap/sync";

async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function htmlToText(html: string): string {
	if (!/<[a-z!/][^>]*>/i.test(html)) return html.trim();
	return html
		.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	/** Counter bumped by triggers on every write to emails (one-row read). */
	async getEmailsVersion(): Promise<number> {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT value FROM meta WHERE key = 'emails_version'`,
		)][0] as { value: number } | undefined;
		return row?.value ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS MATERIALIZED (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS MATERIALIZED (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			-- Only emails that belong to a conversation present in this folder.
			-- Split on thread_id so both branches can use an index instead of
			-- scanning the whole emails table.
			all_emails_with_conversation AS MATERIALIZED (
				SELECT e.*, tc.conversation_id
				FROM thread_to_conversation tc
				JOIN emails e ON e.thread_id = tc.raw_thread_id
				UNION ALL
				SELECT e.*, tc.conversation_id
				FROM thread_to_conversation tc
				JOIN emails e ON e.id = tc.raw_thread_id AND e.thread_id IS NULL
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		// permanent delete here → make sure it is in the source mailbox's trash too
		this.#queueSourceOp(id, "trash");

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		if (folderId === Folders.TRASH || folderId === "spam") this.#queueSourceOp(id, "trash");
		else if (folderId === Folders.ARCHIVE) this.#queueSourceOp(id, "archive");
		else if (folderId === Folders.INBOX) this.#queueSourceOp(id, "inbox");

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	/**
	 * Bulk action on list rows. Each id is a conversation's representative
	 * email; it expands to every message of that thread in `folder` (or the
	 * whole thread for read/unread), so the whole row is affected.
	 */
	async batchAction(
		ids: string[],
		action: "read" | "unread" | "archive" | "trash" | "delete",
		folder?: string,
	) {
		const targets = new Set<string>();
		for (const id of ids.slice(0, 500)) {
			const row = [...this.ctx.storage.sql.exec(
				`SELECT id, thread_id FROM emails WHERE id = ?`, id,
			)][0] as { id: string; thread_id: string | null } | undefined;
			if (!row) continue;
			targets.add(row.id);
			if (!row.thread_id) continue;
			const sibs = action === "read" || action === "unread" || !folder
				? this.ctx.storage.sql.exec(`SELECT id FROM emails WHERE thread_id = ?`, row.thread_id)
				: this.ctx.storage.sql.exec(`SELECT id FROM emails WHERE thread_id = ? AND folder_id = ?`, row.thread_id, folder);
			for (const s of sibs) targets.add(s.id as string);
		}

		const removed: { id: string; attachments: { id: string; filename: string }[] }[] = [];
		for (const id of targets) {
			if (action === "read" || action === "unread") {
				await this.updateEmail(id, { read: action === "read" });
			} else if (action === "archive") {
				await this.moveEmail(id, Folders.ARCHIVE);
			} else if (action === "trash") {
				await this.moveEmail(id, Folders.TRASH);
			} else {
				const atts = await this.deleteEmail(id);
				if (atts) removed.push({ id, attachments: atts as any });
			}
		}
		return { count: targets.size, removed };
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}

	// ── Unified inbox: raw ingest + IMAP source sync ───────────────

	/**
	 * Parse a raw RFC822 message and store it in the Inbox.
	 * Runs inside the Durable Object so MIME parsing does not count against the
	 * calling Worker's (Free plan: 10 ms) CPU budget.
	 */
	async ingestRaw(raw: Uint8Array, meta: IngestMeta): Promise<"new" | "dup" | "skipped"> {
		const parsed = await new PostalMime().parse(raw);
		const extractMsgId = (v: string) => { const m = v.match(/<([^>]+)>/); return m ? m[1] : v.trim().split(/\s+/)[0]; };
		const originalMessageId = parsed.messageId ? extractMsgId(parsed.messageId) : null;

		// Dedup by Message-ID (forwarding + IMAP during migration, rescans, restores)
		if (originalMessageId) {
			const existing = [...this.ctx.storage.sql.exec(
				`SELECT id, source FROM emails WHERE message_id = ? LIMIT 1`, originalMessageId,
			)][0] as { id: string; source: string | null } | undefined;
			if (existing) {
				if (meta.sourceUid !== undefined && (existing.source === null || existing.source === meta.source)) {
					this.ctx.storage.sql.exec(
						`UPDATE emails SET source = ?, source_uid = ?, source_folder = ?, source_msgid = COALESCE(?, source_msgid) WHERE id = ?`,
						meta.source, meta.sourceUid, meta.sourceFolder ?? "INBOX", meta.gmMsgId ?? null, existing.id,
					);
				}
				return "dup";
			}
		}

		const messageId = crypto.randomUUID();
		const attachmentData: { id: string; email_id: string; filename: string; mimetype: string; size: number; content_id: string | null; disposition: string }[] = [];
		for (const att of parsed.attachments || []) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await this.env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({
				id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment",
			});
		}

		const inReplyTo = parsed.inReplyTo ? extractMsgId(parsed.inReplyTo) : null;
		const references = parsed.references ? parsed.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
		let threadId = references[0] || inReplyTo || messageId;
		if (!inReplyTo && references.length === 0) {
			const t = await this.findThreadBySubject(parsed.subject || "", parsed.from?.address || undefined);
			if (t) threadId = t;
		}

		const lower = (list?: { address?: string }[]) =>
			(list || []).map((a) => a.address?.toLowerCase()).filter(Boolean).join(", ");
		let recipient = lower(parsed.to as any);
		if (meta.envelopeTo && !recipient.includes(meta.envelopeTo.toLowerCase())) {
			recipient = recipient ? `${recipient}, ${meta.envelopeTo.toLowerCase()}` : meta.envelopeTo.toLowerCase();
		}

		let date = meta.internalDate || null;
		if (!date && parsed.date) {
			const d = new Date(parsed.date);
			if (!Number.isNaN(d.getTime())) date = d.toISOString();
		}
		if (!date) date = new Date().toISOString();

		await this.createEmail(Folders.INBOX, {
			id: messageId,
			subject: parsed.subject || "",
			sender: (parsed.from?.address || "").toLowerCase(),
			recipient,
			cc: lower(parsed.cc as any) || null,
			bcc: lower(parsed.bcc as any) || null,
			date,
			read: meta.seen ? 1 : 0,
			body: parsed.html || parsed.text || "",
			in_reply_to: inReplyTo,
			email_references: references.length ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: originalMessageId,
			raw_headers: JSON.stringify(parsed.headers),
		} as any, attachmentData);

		if (meta.sourceUid !== undefined) {
			this.ctx.storage.sql.exec(
				`UPDATE emails SET source = ?, source_uid = ?, source_folder = ?, source_msgid = ? WHERE id = ?`,
				meta.source, meta.sourceUid, meta.sourceFolder ?? "INBOX", meta.gmMsgId ?? null, messageId,
			);
		}
		try {
			await this.#maybeOtp(messageId, parsed.subject || "", parsed.text || parsed.html || "",
				(parsed.from?.name || parsed.from?.address || "").trim(), date, !!meta.seen);
		} catch (e) {
			console.error("otp push failed", (e as Error).message);
		}
		return "new";
	}

	// ── Verification codes → Telegram ─────────────────────────────

	async otpSettings() {
		const s = ((await this.ctx.storage.get("otp")) as { enabled?: boolean; chatId?: string; chatName?: string; lastPush?: string }) || {};
		return { enabled: !!s.enabled, chatId: s.chatId || null, chatName: s.chatName || null, lastPush: s.lastPush || null,
			hasToken: !!(await this.#tgToken()) };
	}

	async #tgToken(): Promise<string | undefined> {
		return ((await this.ctx.storage.get("tg_token")) as string | undefined) || (this.env as any).TELEGRAM_BOT_TOKEN;
	}

	async otpSetToken(token: string) {
		token = token.trim();
		if (!/^\d+:[\w-]{30,}$/.test(token)) return { ok: false, error: "格式不对，应该像 123456:ABC-xyz…" };
		const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
		const j = (await r.json().catch(() => ({}))) as any;
		if (!j.ok) return { ok: false, error: "Telegram 不认这个 token" };
		await this.ctx.storage.put("tg_token", token);
		return { ok: true, bot: j.result?.username };
	}

	async otpSetEnabled(enabled: boolean) {
		const s = ((await this.ctx.storage.get("otp")) as any) || {};
		if (enabled && !s.chatId) return { ok: false, error: "先绑定 Telegram" };
		await this.ctx.storage.put("otp", { ...s, enabled });
		return { ok: true };
	}

	async otpBind() {
		const token = await this.#tgToken();
		if (!token) return { ok: false, error: "先填机器人 token" };
		const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
		const j = (await r.json()) as any;
		if (!j.ok) return { ok: false, error: `Telegram: ${j.description || r.status}` };
		const msgs = (j.result || []).map((u: any) => u.message || u.channel_post).filter(Boolean);
		const last = msgs[msgs.length - 1];
		if (!last) return { ok: false, error: "没找到消息。先在 Telegram 里给你的机器人发一句话，再点绑定" };
		const chat = last.chat;
		const s = ((await this.ctx.storage.get("otp")) as any) || {};
		const chatName = chat.username ? `@${chat.username}` : [chat.first_name, chat.last_name, chat.title].filter(Boolean).join(" ");
		await this.ctx.storage.put("otp", { ...s, chatId: String(chat.id), chatName });
		await sendTelegram(token, String(chat.id), "✅ 已绑定统一收件箱，验证码会推到这里。");
		return { ok: true, chatName };
	}

	async #maybeOtp(emailId: string, subject: string, body: string, from: string, date: string, seen: boolean) {
		if (seen) return;
		// only fresh mail: never replay old codes during an initial import
		if (Date.now() - Date.parse(date) > 15 * 60_000) return;
		const s = ((await this.ctx.storage.get("otp")) as any) || {};
		const token = await this.#tgToken();
		if (!s.enabled || !s.chatId || !token) return;
		const hit = detectOtp(subject, body);
		if (!hit) return;
		const text = `<code>${escapeHtml(hit.code)}</code>\n${escapeHtml(from)} · ${escapeHtml(subject).slice(0, 80)}`;
		if (!(await sendTelegram(token, s.chatId, text))) return; // keep it in the inbox if Telegram failed
		this.ctx.storage.sql.exec(`UPDATE emails SET folder_id = 'otp', read = 1 WHERE id = ?`, emailId);
		await this.ctx.storage.put("otp", { ...s, lastPush: new Date().toISOString() });
	}

	/** Remove verification-code mail older than 24h. */
	async #purgeOtp() {
		const ids = ([...this.ctx.storage.sql.exec(
			`SELECT id FROM emails WHERE folder_id = 'otp' AND received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') LIMIT 50`,
		)] as any[]).map((r) => String(r.id));
		for (const id of ids) {
			const atts = await this.deleteEmail(id);
			if (atts?.length) {
				await this.env.BUCKET.delete(atts.map((a: any) => `attachments/${id}/${a.id}/${a.filename}`)).catch(() => {});
			}
		}
	}

	// ── Agent API (read-only, scoped tokens) ─────────────────────────

	async agentTokenCreate(name: string, sources: string[]) {
		const raw = new Uint8Array(32);
		crypto.getRandomValues(raw);
		const token = "ev_" + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			`INSERT INTO agent_tokens (id, name, token_hash, sources) VALUES (?, ?, ?, ?)`,
			id, name, await sha256Hex(token), sources.length ? JSON.stringify(sources) : null,
		);
		return { id, token };
	}

	async agentTokenList() {
		return ([...this.ctx.storage.sql.exec(
			`SELECT id, name, sources, created_at, last_used_at FROM agent_tokens ORDER BY created_at`,
		)] as any[]).map((r) => ({ ...r, sources: r.sources ? JSON.parse(r.sources) : [] }));
	}

	async agentTokenDelete(id: string) {
		this.ctx.storage.sql.exec(`DELETE FROM agent_tokens WHERE id = ?`, id);
		return { ok: true };
	}

	async agentAuth(token: string): Promise<{ id: string; sources: string[] } | null> {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT id, sources FROM agent_tokens WHERE token_hash = ?`, await sha256Hex(token),
		)][0] as any;
		if (!row) return null;
		this.ctx.storage.sql.exec(`UPDATE agent_tokens SET last_used_at = datetime('now') WHERE id = ?`, row.id);
		return { id: String(row.id), sources: row.sources ? JSON.parse(row.sources) : [] };
	}

	#agentScope(sources: string[], params: (string | number)[]): string {
		if (!sources.length) return "1=1";
		const parts = sources.map((addr) => {
			params.push(`%${addr.toLowerCase()}`, `%${addr.toLowerCase()}%`);
			return `(LOWER(COALESCE(e.source,'')) LIKE ? OR LOWER(COALESCE(e.recipient,'')) LIKE ?)`;
		});
		return `(${parts.join(" OR ")})`;
	}

	#agentRows(where: string, params: (string | number)[], order: string, limit: number) {
		const rows = [...this.ctx.storage.sql.exec(
			`SELECT e.id, e.received_at, e.date, e.sender, e.recipient, e.cc, e.subject, e.source, e.folder_id,
			        SUBSTR(e.body, 1, 2000) as body_head
			 FROM emails e WHERE ${where} ORDER BY ${order} LIMIT ?`,
			...params, limit,
		)] as any[];
		return rows.map((r) => ({
			id: r.id,
			received_at: r.received_at,
			date: r.date,
			from: r.sender,
			to: r.recipient,
			cc: r.cc || undefined,
			subject: r.subject,
			snippet: htmlToText(r.body_head || "").slice(0, 280),
			source: r.source || "routing",
			folder: r.folder_id,
		}));
	}

	async agentInbox(sources: string[], since: string | null, limit: number) {
		const params: (string | number)[] = [];
		let where = this.#agentScope(sources, params);
		if (since) { where += ` AND e.received_at > ?`; params.push(since); }
		const emails = this.#agentRows(where, params, "e.received_at ASC", limit);
		const next = emails.length ? emails[emails.length - 1].received_at : since;
		return { emails, next_since: next, has_more: emails.length === limit };
	}

	async agentSearch(sources: string[], q: string | null, from: string | null, since: string | null, limit: number) {
		const params: (string | number)[] = [];
		let where = this.#agentScope(sources, params);
		if (q) { where += ` AND (e.subject LIKE ? OR e.body LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
		if (from) { where += ` AND e.sender LIKE ?`; params.push(`%${from}%`); }
		if (since) { where += ` AND e.received_at > ?`; params.push(since); }
		return { emails: this.#agentRows(where, params, "e.received_at DESC", limit) };
	}

	async agentMail(sources: string[], id: string) {
		const params: (string | number)[] = [];
		const where = this.#agentScope(sources, params) + ` AND e.id = ?`;
		params.push(id);
		const row = [...this.ctx.storage.sql.exec(
			`SELECT e.id, e.received_at, e.date, e.sender, e.recipient, e.cc, e.subject, e.source, e.folder_id, e.body,
			        e.message_id, e.thread_id
			 FROM emails e WHERE ${where}`, ...params,
		)][0] as any;
		if (!row) return null;
		const attachments = ([...this.ctx.storage.sql.exec(
			`SELECT filename, mimetype, size FROM attachments WHERE email_id = ?`, id,
		)] as any[]).map((a) => ({ filename: a.filename, mimetype: a.mimetype, size: a.size }));
		return {
			id: row.id, received_at: row.received_at, date: row.date, from: row.sender, to: row.recipient,
			cc: row.cc || undefined, subject: row.subject, source: row.source || "routing", folder: row.folder_id,
			message_id: row.message_id, thread_id: row.thread_id,
			text: htmlToText(row.body || ""), attachments,
		};
	}

	/** Queue a Gmail-side action for an email that came from an IMAP source. */
	#queueSourceOp(emailId: string, op: OpKind) {
		const row = [...this.ctx.storage.sql.exec(
			`SELECT source, source_msgid, source_folder FROM emails WHERE id = ?`, emailId,
		)][0] as { source: string | null; source_msgid: string | null; source_folder: string | null } | undefined;
		if (!row?.source || !row.source_msgid) return;
		const target = op === "trash" ? "TRASH" : op === "archive" ? "ARCHIVE" : "RESTORING";
		if (row.source_folder === target || (op === "inbox" && row.source_folder === "INBOX")) return;
		this.ctx.storage.sql.exec(
			`INSERT INTO imap_ops (account, op, gm_msgid) VALUES (?, ?, ?)`, row.source, op, row.source_msgid,
		);
		this.ctx.storage.sql.exec(`UPDATE emails SET source_folder = ? WHERE id = ?`, target, emailId);
		// Push it to Gmail shortly instead of waiting for the next cron run.
		this.ctx.storage.setAlarm(Date.now() + 2_000);
	}

	async alarm() {
		await this.syncImap();
	}

	#syncing: Promise<SyncSummary[]> | null = null;

	/** Run one bounded sync pass for every configured IMAP account. */
	async syncImap(): Promise<SyncSummary[]> {
		await this.#purgeOtp().catch((e) => console.error("otp purge", (e as Error).message));
		if (this.#syncing) return this.#syncing;
		this.#syncing = this.#runSync().finally(() => { this.#syncing = null; });
		return this.#syncing;
	}

	#accounts(): ImapAccount[] {
		const env = this.env as unknown as Record<string, string | undefined>;
		const names = (env.IMAP_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean);
		const out: ImapAccount[] = [];
		for (const name of names) {
			const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
			const user = env[`IMAP_${key}_USER`];
			const pass = env[`IMAP_${key}_PASS`];
			if (!user || !pass) continue;
			out.push({
				name: name.toLowerCase(),
				host: env[`IMAP_${key}_HOST`] || "imap.gmail.com",
				port: Number(env[`IMAP_${key}_PORT`] || 993),
				user,
				pass: pass.replace(/\s+/g, ""),
			});
		}
		return out;
	}

	async #runSync(): Promise<SyncSummary[]> {
		const sqlx = this.ctx.storage.sql;
		const store: SyncStore = {
			getState: (account) => {
				const r = [...sqlx.exec(`SELECT uid_validity, last_uid, initial_done FROM imap_state WHERE account = ?`, account)][0] as any;
				return r ? { uidValidity: Number(r.uid_validity), lastUid: Number(r.last_uid), initialDone: Number(r.initial_done) === 1 } : null;
			},
			setState: (account, st) => {
				sqlx.exec(
					`INSERT INTO imap_state (account, uid_validity, last_uid, initial_done) VALUES (?, ?, ?, ?)
					 ON CONFLICT(account) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, initial_done = excluded.initial_done`,
					account, st.uidValidity, st.lastUid, st.initialDone ? 1 : 0,
				);
			},
			ingest: (raw, meta) => this.ingestRaw(raw, meta),
			pendingOps: (account, limit) =>
				[...sqlx.exec(
					`SELECT id, op, gm_msgid FROM imap_ops WHERE account = ? AND attempts < 5 ORDER BY id LIMIT ?`, account, limit,
				)].map((r: any) => ({ id: Number(r.id), op: r.op as OpKind, gmMsgId: String(r.gm_msgid) })),
			finishOp: (id, error) => {
				if (!error) sqlx.exec(`DELETE FROM imap_ops WHERE id = ?`, id);
				else sqlx.exec(`UPDATE imap_ops SET attempts = attempts + 1, last_error = ? WHERE id = ?`, error.slice(0, 500), id);
			},
			trackedInbox: (account) =>
				[...sqlx.exec(
					`SELECT id, source_uid, source_msgid FROM emails WHERE source = ? AND source_folder = 'INBOX'`, account,
				)].map((r: any) => ({ emailId: String(r.id), uid: Number(r.source_uid), gmMsgId: r.source_msgid ? String(r.source_msgid) : null })),
			resetTracking: (account) => {
				sqlx.exec(`UPDATE emails SET source_folder = 'STALE' WHERE source = ? AND source_folder = 'INBOX'`, account);
			},
			sourceLeftInbox: (emailId, where) => {
				const folder = where === "archive" ? Folders.ARCHIVE : Folders.TRASH;
				sqlx.exec(
					`UPDATE emails SET source_folder = ?, folder_id = CASE WHEN folder_id = 'inbox' OR ? = 'trash' THEN ? ELSE folder_id END WHERE id = ?`,
					where === "archive" ? "ARCHIVE" : "TRASH", folder, folder, emailId,
				);
			},
		};

		const results: SyncSummary[] = [];
		for (const acct of [...this.#accounts(), ...this.#oauthAccounts(), ...this.#storedImapAccounts()]) {
			const summary = await syncAccount(acct, store, {
				open: () => {
					const socket = connect({ hostname: acct.host, port: acct.port }, { secureTransport: "on", allowHalfOpen: false });
					return { readable: socket.readable, writable: socket.writable };
				},
				initialDays: Number((this.env as any).IMAP_INITIAL_DAYS || 90),
				maxMessages: 15,
				budgetMs: 25_000,
				// Sync runs every minute for fast OTP delivery; the full-inbox
				// comparison is the costly part, so only do it on 5-minute marks.
				reconcile: new Date().getUTCMinutes() % 5 === 0,
				log: (m) => console.log(`[imap ${acct.name}] ${m}`),
			});
			sqlx.exec(
				`UPDATE imap_state SET last_run_at = ?, last_summary = ? WHERE account = ?`,
				new Date().toISOString(), JSON.stringify(summary), acct.name,
			);
			results.push(summary);
			// More to do (initial import, or ops left)? Keep going soon via alarm.
			if (!summary.error && summary.remaining > 0) this.ctx.storage.setAlarm(Date.now() + 15_000);
		}

		const popStore: Pop3Store = {
			isInitialDone: (account) =>
				([...sqlx.exec(`SELECT initial_done FROM imap_state WHERE account = ?`, account)][0] as any)?.initial_done == 1,
			setInitialDone: (account) =>
				sqlx.exec(
					`INSERT INTO imap_state (account, uid_validity, last_uid, initial_done) VALUES (?, 0, 0, 1)
					 ON CONFLICT(account) DO UPDATE SET initial_done = 1`, account,
				),
			seen: (account) => new Set(([...sqlx.exec(`SELECT uid FROM pop3_seen WHERE account = ?`, account)] as any[]).map((r) => String(r.uid))),
			markSeen: (account, uids) => {
				for (const u of uids) sqlx.exec(`INSERT OR IGNORE INTO pop3_seen (account, uid) VALUES (?, ?)`, account, u);
			},
			ingest: (raw, meta) => this.ingestRaw(raw, meta),
		};
		for (const acct of this.#pop3Accounts()) {
			const summary = await syncPop3(acct, popStore, {
				open: () => {
					const socket = connect({ hostname: acct.host, port: acct.port }, { secureTransport: "on", allowHalfOpen: false });
					return { readable: socket.readable, writable: socket.writable };
				},
				initialDays: Number((this.env as any).IMAP_INITIAL_DAYS || 90),
				maxMessages: 15,
				budgetMs: 25_000,
			});
			sqlx.exec(
				`INSERT INTO imap_state (account, uid_validity, last_uid, initial_done, last_run_at, last_summary) VALUES (?, 0, 0, 0, ?, ?)
				 ON CONFLICT(account) DO UPDATE SET last_run_at = excluded.last_run_at, last_summary = excluded.last_summary`,
				acct.name, new Date().toISOString(), JSON.stringify(summary),
			);
			results.push(summary);
			if (!summary.error && summary.remaining > 0) this.ctx.storage.setAlarm(Date.now() + 15_000);
		}
		return results;
	}

	// ── "Sign in with Google" accounts ───────────────────────────

	#oauthAccounts(): ImapAccount[] {
		const rows = [...this.ctx.storage.sql.exec(`SELECT account, email FROM oauth_accounts WHERE provider = 'google'`)] as any[];
		return rows.map((r) => ({
			name: String(r.account),
			host: "imap.gmail.com",
			port: 993,
			user: String(r.email),
			accessToken: () => this.#googleAccessToken(String(r.account)),
		}));
	}

	async #googleAccessToken(account: string): Promise<string> {
		const sqlx = this.ctx.storage.sql;
		const r = [...sqlx.exec(`SELECT refresh_token, access_token, expires_at FROM oauth_accounts WHERE account = ?`, account)][0] as any;
		if (!r) throw new Error(`unknown account ${account}`);
		if (r.access_token && Number(r.expires_at) > Date.now() + 60_000) return String(r.access_token);
		const env = this.env as any;
		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: env.GOOGLE_CLIENT_ID || "",
				client_secret: env.GOOGLE_CLIENT_SECRET || "",
				refresh_token: String(r.refresh_token),
				grant_type: "refresh_token",
			}),
		});
		const j = (await res.json()) as any;
		if (!res.ok || !j.access_token) {
			const err = `token refresh failed: ${j.error || res.status} ${j.error_description || ""}`.trim();
			sqlx.exec(`UPDATE oauth_accounts SET last_error = ? WHERE account = ?`, err, account);
			throw new Error(err);
		}
		sqlx.exec(
			`UPDATE oauth_accounts SET access_token = ?, expires_at = ?, last_error = NULL WHERE account = ?`,
			j.access_token, Date.now() + Number(j.expires_in || 3600) * 1000, account,
		);
		return String(j.access_token);
	}

	async addOAuthAccount(a: { email: string; refreshToken: string; accessToken: string; expiresIn: number }) {
		const account = `gmail:${a.email.toLowerCase()}`;
		this.ctx.storage.sql.exec(
			`INSERT INTO oauth_accounts (account, provider, email, refresh_token, access_token, expires_at)
			 VALUES (?, 'google', ?, ?, ?, ?)
			 ON CONFLICT(account) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
			   expires_at = excluded.expires_at, last_error = NULL`,
			account, a.email.toLowerCase(), a.refreshToken, a.accessToken, Date.now() + a.expiresIn * 1000,
		);
		// Start the first import right away.
		this.ctx.storage.setAlarm(Date.now() + 1_000);
		return account;
	}

	#storedImapAccounts(): ImapAccount[] {
		return ([...this.ctx.storage.sql.exec(`SELECT account, email, host, port, password FROM imap_accounts WHERE protocol = 'imap'`)] as any[]).map((r) => ({
			name: String(r.account), host: String(r.host), port: Number(r.port), user: String(r.email), pass: String(r.password),
		}));
	}

	#pop3Accounts(): Pop3Account[] {
		return ([...this.ctx.storage.sql.exec(`SELECT account, email, host, port, password FROM imap_accounts WHERE protocol = 'pop3'`)] as any[]).map((r) => ({
			name: String(r.account), host: String(r.host), port: Number(r.port), user: String(r.email), pass: String(r.password),
		}));
	}

	async addImapAccount(a: { email: string; password: string; host: string; port: number; protocol?: "imap" | "pop3" }) {
		const email = a.email.trim().toLowerCase();
		const protocol = a.protocol === "pop3" ? "pop3" : "imap";
		const port = a.port || (protocol === "pop3" ? 995 : 993);
		const acct = { name: `${protocol}:${email}`, host: a.host.trim(), port, user: email, pass: a.password.replace(/\s+/g, "") };
		const open = () => {
			const socket = connect({ hostname: acct.host, port: acct.port }, { secureTransport: "on", allowHalfOpen: false });
			return { readable: socket.readable, writable: socket.writable };
		};
		try {
			if (protocol === "pop3") await testPop3Login(acct, open);
			else await testLogin(acct, open);
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO imap_accounts (account, email, host, port, password, protocol) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(account) DO UPDATE SET host = excluded.host, port = excluded.port, password = excluded.password`,
			acct.name, email, acct.host, acct.port, acct.pass, protocol,
		);
		this.ctx.storage.setAlarm(Date.now() + 1_000);
		return { ok: true, account: acct.name };
	}

	async removeOAuthAccount(account: string) {
		const sqlx = this.ctx.storage.sql;
		const r = [...sqlx.exec(`SELECT refresh_token FROM oauth_accounts WHERE account = ?`, account)][0] as any;
		sqlx.exec(`DELETE FROM oauth_accounts WHERE account = ?`, account);
		sqlx.exec(`DELETE FROM imap_accounts WHERE account = ?`, account);
		sqlx.exec(`DELETE FROM pop3_seen WHERE account = ?`, account);
		sqlx.exec(`DELETE FROM imap_state WHERE account = ?`, account);
		sqlx.exec(`DELETE FROM imap_ops WHERE account = ?`, account);
		// Emails already imported stay; they just stop syncing.
		sqlx.exec(`UPDATE emails SET source_folder = 'DISCONNECTED' WHERE source = ?`, account);
		if (r?.refresh_token) {
			try {
				await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(String(r.refresh_token))}`, { method: "POST" });
			} catch {}
		}
		return { ok: true };
	}

	async listAccounts() {
		const sqlx = this.ctx.storage.sql;
		const state = new Map(
			([...sqlx.exec(`SELECT account, initial_done, last_run_at, last_summary FROM imap_state`)] as any[]).map((r) => [String(r.account), r]),
		);
		const view = (account: string, email: string, kind: string, lastError?: string | null) => {
			const st = state.get(account);
			let summary: any = null;
			try { summary = st?.last_summary ? JSON.parse(st.last_summary) : null; } catch {}
			return {
				account, email, kind,
				initialDone: st ? Number(st.initial_done) === 1 : false,
				lastRunAt: st?.last_run_at ?? null,
				error: lastError || summary?.error || null,
			};
		};
		const out = this.#accounts().map((a) => view(a.name, a.user, "password"));
		for (const r of [...sqlx.exec(`SELECT account, email, last_error FROM oauth_accounts ORDER BY created_at`)] as any[]) {
			out.push(view(String(r.account), String(r.email), "google", r.last_error));
		}
		for (const r of [...sqlx.exec(`SELECT account, email, protocol FROM imap_accounts ORDER BY created_at`)] as any[]) {
			out.push(view(String(r.account), String(r.email), String(r.protocol)));
		}
		return out;
	}

	async getSyncStatus() {
		return {
			accounts: [...this.ctx.storage.sql.exec(`SELECT account, uid_validity, last_uid, initial_done, last_run_at, last_summary FROM imap_state`)],
			pendingOps: [...this.ctx.storage.sql.exec(`SELECT id, account, op, attempts, last_error, created_at FROM imap_ops ORDER BY id`)],
		};
	}
}
