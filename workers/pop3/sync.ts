// POP3 → unified inbox (pull only; nothing is deleted on the server).
//
// Seen messages are remembered by UIDL. First run imports the newest messages
// back to N days (checked with TOP n 0), then follows new UIDLs only.

import { Pop3Client, headerDate } from "./client";
import type { IngestMeta, SyncSummary } from "../imap/sync";

export interface Pop3Account {
	name: string;
	host: string;
	port: number;
	user: string;
	pass: string;
}

export interface Pop3Store {
	isInitialDone(account: string): boolean;
	setInitialDone(account: string): void;
	seen(account: string): Set<string>;
	markSeen(account: string, uids: string[]): void;
	ingest(raw: Uint8Array, meta: IngestMeta): Promise<"new" | "dup" | "skipped">;
}

export interface Pop3Options {
	open: () => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
	maxMessages?: number;
	maxBodyBytes?: number;
	budgetMs?: number;
	initialDays?: number;
}

export async function testPop3Login(acct: Pop3Account, open: Pop3Options["open"]) {
	const { readable, writable } = open();
	const c = new Pop3Client(readable, writable);
	try {
		await c.greeting();
		await c.login(acct.user, acct.pass);
		await c.uidl();
	} finally {
		await c.quit();
	}
}

export async function syncPop3(acct: Pop3Account, store: Pop3Store, opts: Pop3Options): Promise<SyncSummary> {
	const started = Date.now();
	const budgetMs = opts.budgetMs ?? 20_000;
	const maxMessages = opts.maxMessages ?? 15;
	const maxBodyBytes = opts.maxBodyBytes ?? 20 * 1024 * 1024;
	const cutoff = Date.now() - (opts.initialDays ?? 90) * 86_400_000;
	const outOfTime = () => Date.now() - started > budgetMs;
	const summary: SyncSummary = {
		account: acct.name, opsDone: 0, opsFailed: 0, fetched: 0, duplicates: 0, tooLarge: 0,
		movedToArchive: 0, movedToTrash: 0, remaining: 0,
	};

	const { readable, writable } = opts.open();
	const c = new Pop3Client(readable, writable);
	try {
		await c.greeting();
		await c.login(acct.user, acct.pass);
		const all = await c.uidl();
		const seen = store.seen(acct.name);
		const initial = !store.isInitialDone(acct.name);
		let todo = all.filter((m) => !seen.has(m.uid));
		// initial: newest first, stop at the cutoff; afterwards: oldest first
		if (initial) todo = todo.reverse();

		let processed = 0;
		let reachedCutoff = false;
		for (let i = 0; i < todo.length; i++) {
			const m = todo[i];
			if (processed >= maxMessages || outOfTime()) break;
			if (initial) {
				const d = headerDate(await c.top(m.n));
				if (d !== null && d < cutoff) {
					// everything older than this is outside the import window
					store.markSeen(acct.name, todo.slice(i).map((x) => x.uid));
					reachedCutoff = true;
					break;
				}
			}
			const raw = await c.retr(m.n, maxBodyBytes);
			processed++;
			if (!raw) {
				summary.tooLarge++;
			} else {
				const r = await store.ingest(raw, { source: acct.name, envelopeTo: acct.user, seen: false });
				if (r === "dup") summary.duplicates++;
				else if (r === "new") summary.fetched++;
			}
			store.markSeen(acct.name, [m.uid]);
		}
		const left = reachedCutoff ? 0 : Math.max(0, todo.length - processed);
		summary.remaining = left;
		if (initial && left === 0) store.setInitialDone(acct.name);
	} catch (e) {
		summary.error = (e as Error).message;
	} finally {
		await c.quit();
	}
	return summary;
}
