// Gmail → unified inbox sync over IMAP.
//
// One run:
//   1. push pending local actions (trash / archive / back-to-inbox) to Gmail
//   2. pull new INBOX messages (first run: last N days only), a few per run
//   3. detect messages that left the Gmail INBOX: archived → local Archive,
//      gone from All Mail (trash / spam / deleted) → local Trash
//
// Everything is bounded (message count + wall time) so a run always finishes;
// whatever is left is picked up by the next run.

import { ImapClient, imapDate, quote, type FetchedMessage } from "./client";

export interface ImapAccount {
	name: string; // e.g. "gmail"
	host: string;
	port: number;
	user: string;
	pass?: string;
	/** Returns a fresh OAuth access token (XOAUTH2) instead of a password. */
	accessToken?: () => Promise<string>;
}

export interface SyncState {
	uidValidity: number;
	lastUid: number;
	/** false while the first (last-N-days) import is still running */
	initialDone: boolean;
}

export type OpKind = "trash" | "archive" | "inbox";

export interface SyncStore {
	getState(account: string): SyncState | null;
	setState(account: string, state: SyncState): void;
	ingest(raw: Uint8Array, meta: IngestMeta): Promise<"new" | "dup" | "skipped">;
	pendingOps(account: string, limit: number): { id: number; op: OpKind; gmMsgId: string }[];
	finishOp(id: number, error?: string): void;
	trackedInbox(account: string): { emailId: string; uid: number; gmMsgId: string | null }[];
	sourceLeftInbox(emailId: string, where: "archive" | "trash"): void;
	/** UIDVALIDITY changed: stored UIDs are meaningless, stop tracking them (rescan re-links). */
	resetTracking(account: string): void;
}

export interface IngestMeta {
	source: string;
	sourceUid?: number;
	sourceFolder?: string;
	gmMsgId?: string | null;
	internalDate?: string | null;
	seen?: boolean;
	envelopeTo?: string | null;
}

export interface SyncOptions {
	open: () => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
	maxMessages?: number;
	maxBodyBytes?: number;
	budgetMs?: number;
	initialDays?: number;
	log?: (msg: string) => void;
}

export interface SyncSummary {
	account: string;
	opsDone: number;
	opsFailed: number;
	fetched: number;
	duplicates: number;
	tooLarge: number;
	movedToArchive: number;
	movedToTrash: number;
	remaining: number;
	error?: string;
}

interface Mailboxes {
	inbox: string;
	all: string | null;
	trash: string | null;
}

async function findMailboxes(c: ImapClient): Promise<Mailboxes> {
	const boxes = await c.list();
	const find = (attr: string) => boxes.find((b) => b.attrs.some((a) => a.toLowerCase() === attr.toLowerCase()))?.name ?? null;
	return { inbox: "INBOX", all: find("\\All"), trash: find("\\Trash") };
}

export async function syncAccount(acct: ImapAccount, store: SyncStore, opts: SyncOptions): Promise<SyncSummary> {
	const started = Date.now();
	const budgetMs = opts.budgetMs ?? 20_000;
	const maxMessages = opts.maxMessages ?? 15;
	const maxBodyBytes = opts.maxBodyBytes ?? 20 * 1024 * 1024;
	const initialDays = opts.initialDays ?? 90;
	const log = opts.log ?? (() => {});
	const outOfTime = () => Date.now() - started > budgetMs;

	const summary: SyncSummary = {
		account: acct.name, opsDone: 0, opsFailed: 0, fetched: 0, duplicates: 0, tooLarge: 0,
		movedToArchive: 0, movedToTrash: 0, remaining: 0,
	};

	const { readable, writable } = opts.open();
	const c = new ImapClient(readable, writable);
	try {
		await c.greeting();
		if (acct.accessToken) await c.authenticateXOAuth2(acct.user, await acct.accessToken());
		else await c.login(acct.user, acct.pass ?? "");
		const isGmail = c.capabilities.has("X-GM-EXT-1");
		const boxes = await findMailboxes(c);

		// Helper: locate a Gmail message by X-GM-MSGID in a mailbox; returns its UID there.
		let selected = "";
		const selectBox = async (name: string) => {
			if (selected !== name) {
				await c.select(name);
				selected = name;
			}
		};
		const findIn = async (box: string | null, gmMsgId: string): Promise<number | null> => {
			if (!box) return null;
			await selectBox(box);
			const uids = await c.uidSearch(`X-GM-MSGID ${gmMsgId}`);
			return uids[0] ?? null;
		};

		// ── 1. push local actions ────────────────────────────────
		if (isGmail) {
			for (const op of store.pendingOps(acct.name, 25)) {
				if (outOfTime()) break;
				try {
					if (op.op === "trash") {
						const uid = await findIn(boxes.all, op.gmMsgId);
						if (uid && boxes.trash) await c.uidMove(String(uid), boxes.trash);
					} else if (op.op === "archive") {
						const uid = await findIn(boxes.all, op.gmMsgId);
						if (uid) await c.uidStore(String(uid), "-X-GM-LABELS (\\Inbox)");
					} else if (op.op === "inbox") {
						const uid = await findIn(boxes.all, op.gmMsgId);
						if (uid) {
							await c.uidStore(String(uid), "+X-GM-LABELS (\\Inbox)");
						} else {
							const tuid = await findIn(boxes.trash, op.gmMsgId);
							if (tuid) await c.uidMove(String(tuid), "INBOX");
						}
					}
					store.finishOp(op.id);
					summary.opsDone++;
				} catch (e) {
					store.finishOp(op.id, (e as Error).message);
					summary.opsFailed++;
					log(`op ${op.id} ${op.op} failed: ${(e as Error).message}`);
				}
			}
		}

		// ── 2. pull new INBOX messages ───────────────────────────
		// always (re-)SELECT INBOX here to get fresh UIDVALIDITY
		const inbox = await c.select(boxes.inbox);
		selected = boxes.inbox;
		let state = store.getState(acct.name);
		if (!state || state.uidValidity !== inbox.uidValidity) {
			if (state) {
				log(`UIDVALIDITY changed ${state.uidValidity} → ${inbox.uidValidity}; rescanning (dedup by Message-ID)`);
				store.resetTracking(acct.name);
			}
			state = { uidValidity: inbox.uidValidity, lastUid: 0, initialDone: false };
			store.setState(acct.name, state);
		}

		let candidates: number[];
		if (!state.initialDone) {
			const since = new Date(Date.now() - initialDays * 86_400_000);
			candidates = (await c.uidSearch(`SINCE ${imapDate(since)}`)).filter((u) => u > state!.lastUid);
		} else {
			candidates = (await c.uidSearch(`UID ${state.lastUid + 1}:*`)).filter((u) => u > state!.lastUid);
		}
		const batch = candidates.slice(0, maxMessages);
		summary.remaining = candidates.length - batch.length;
		const finishesInitial = !state.initialDone && summary.remaining === 0;

		if (batch.length > 0) {
			const metaItems = isGmail ? "UID FLAGS INTERNALDATE RFC822.SIZE X-GM-MSGID" : "UID FLAGS INTERNALDATE RFC822.SIZE";
			const metas = await c.uidFetch(batch.join(","), metaItems);
			const byUid = new Map<number, FetchedMessage>(metas.map((m) => [m.uid, m]));
			for (const uid of batch) {
				if (outOfTime()) {
					summary.remaining += batch.length - batch.indexOf(uid);
					break;
				}
				const meta = byUid.get(uid);
				if (!meta) {
					// expunged between SEARCH and FETCH
					state.lastUid = uid;
					store.setState(acct.name, state);
					continue;
				}
				if (meta.size !== null && meta.size > maxBodyBytes) {
					log(`uid ${uid} too large (${meta.size} bytes), skipped`);
					summary.tooLarge++;
				} else {
					const [full] = await c.uidFetch(String(uid), "UID BODY.PEEK[]");
					if (full?.body) {
						const res = await store.ingest(full.body, {
							source: acct.name,
							sourceUid: uid,
							sourceFolder: "INBOX",
							gmMsgId: meta.gmMsgId,
							internalDate: meta.internalDate,
							seen: meta.flags.some((f) => f.toLowerCase() === "\\seen"),
						});
						if (res === "new") summary.fetched++;
						else summary.duplicates++;
					}
				}
				state.lastUid = uid;
				store.setState(acct.name, state);
			}
		}

		if (finishesInitial && summary.remaining === 0) {
			// From now on follow UIDs; anything that later lands in INBOX
			// (new mail, or old mail moved back to INBOX) gets a higher UID.
			state.initialDone = true;
			state.lastUid = Math.max(state.lastUid, inbox.uidNext - 1);
			store.setState(acct.name, state);
		}

		// ── 3. detect messages that left the Gmail INBOX ─────────
		if (isGmail && !outOfTime()) {
			await selectBox(boxes.inbox);
			const present = new Set(await c.uidSearch("ALL"));
			const gone = store
				.trackedInbox(acct.name)
				.filter((t) => t.uid <= state!.lastUid && !present.has(t.uid))
				.slice(0, 25);
			for (const t of gone) {
				if (outOfTime()) break;
				const stillExists = t.gmMsgId ? await findIn(boxes.all, t.gmMsgId) : null;
				if (stillExists) {
					store.sourceLeftInbox(t.emailId, "archive");
					summary.movedToArchive++;
				} else {
					store.sourceLeftInbox(t.emailId, "trash");
					summary.movedToTrash++;
				}
			}
		}
	} catch (e) {
		summary.error = (e as Error).message;
		log(`sync ${acct.name} failed: ${summary.error}`);
	} finally {
		await c.logout();
	}
	return summary;
}

export { quote };
