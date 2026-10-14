// Run: npx tsx test/imap-sync.test.ts
// End-to-end test of the IMAP client + sync logic against a fake Gmail IMAP server.
import net from "node:net";
import { Duplex } from "node:stream";
import assert from "node:assert/strict";
import { syncAccount, type SyncStore, type IngestMeta, type OpKind } from "../workers/imap/sync";
import { parseImapDateTime } from "../workers/imap/client";

// ── fake Gmail ─────────────────────────────────────────────────────
interface Msg { gmId: string; labels: Set<string>; trash: boolean; raw: string; date: Date; seen: boolean; uids: Record<string, number> }
const gmail = {
	uidValidity: 7,
	nextUid: { INBOX: 1, ALL: 1, TRASH: 1 } as Record<string, number>,
	msgs: [] as Msg[],
	add(subject: string, daysAgo = 0, opts: { inbox?: boolean; body?: string } = {}) {
		const gmId = String(1800000000000000000n + BigInt(this.msgs.length + 1));
		const date = new Date(Date.now() - daysAgo * 86400000);
		const body = opts.body ?? `Hello ${subject}`;
		const raw = [`Message-ID: <${gmId}@mail.example>`, `From: Alice <alice@example.com>`, `To: me@gmail.com`,
			`Subject: ${subject}`, `Date: ${date.toUTCString()}`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, body, ``].join("\r\n");
		const m: Msg = { gmId, labels: new Set(opts.inbox === false ? [] : ["\\Inbox"]), trash: false, raw, date, seen: false, uids: {} };
		this.msgs.push(m);
		this.assign(m);
		return m;
	},
	assign(m: Msg) {
		for (const box of ["INBOX", "ALL", "TRASH"]) if (this.inBox(m, box) && !m.uids[box]) m.uids[box] = this.nextUid[box]++;
		for (const box of ["INBOX", "ALL", "TRASH"]) if (!this.inBox(m, box)) delete m.uids[box];
	},
	inBox(m: Msg, box: string) {
		if (box === "TRASH") return m.trash;
		if (m.trash) return false;
		if (box === "ALL") return true;
		return m.labels.has("\\Inbox");
	},
};
const BOXNAME: Record<string, string> = { INBOX: "INBOX", '"[Gmail]/All Mail"': "ALL", '"[Gmail]/Trash"': "TRASH" };
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const idate = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;
let commandsSeen: string[] = [];

const server = net.createServer((sock) => {
	let box = "";
	let buf = "";
	let pendingSaslFail = "";
	const send = (s: string) => sock.write(s + "\r\n");
	send("* OK [CAPABILITY IMAP4rev1 X-GM-EXT-1 MOVE UIDPLUS] Gimap ready");
	sock.on("data", (d) => {
		buf += d.toString("latin1");
		let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 2);
			const [tag, ...rest] = line.split(" ");
			const cmd = rest.join(" ");
			commandsSeen.push(cmd);
			const inbox = () => gmail.msgs.filter((m) => gmail.inBox(m, box)).sort((a, b) => a.uids[box] - b.uids[box]);
			if (/^AUTHENTICATE XOAUTH2 /i.test(cmd)) {
				const dec = Buffer.from(cmd.split(" ")[2], "base64").toString();
				if (dec === "user=me@gmail.com\x01auth=Bearer good-token\x01\x01") send(`${tag} OK [CAPABILITY IMAP4rev1 X-GM-EXT-1 MOVE UIDPLUS] me authenticated`);
				else { send(`+ eyJzdGF0dXMiOiI0MDAifQ==`); pendingSaslFail = tag; }
			} else if (pendingSaslFail && line === "") {
				send(`${pendingSaslFail} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`); pendingSaslFail = "";
			} else if (/^LOGIN /i.test(cmd)) {
				if (cmd.includes('"secret"')) send(`${tag} OK [CAPABILITY IMAP4rev1 X-GM-EXT-1 MOVE UIDPLUS] me authenticated`);
				else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
			} else if (/^LIST /i.test(cmd)) {
				send(`* LIST (\\HasNoChildren) "/" "INBOX"`);
				send(`* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"`);
				send(`* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"`);
				send(`${tag} OK Success`);
			} else if (/^SELECT /i.test(cmd)) {
				box = BOXNAME[cmd.slice(7)];
				send(`* ${inbox().length} EXISTS`);
				send(`* OK [UIDVALIDITY ${gmail.uidValidity}] UIDs valid.`);
				send(`* OK [UIDNEXT ${gmail.nextUid[box]}] Predicted next UID.`);
				send(`${tag} OK [READ-WRITE] Success`);
			} else if (/^UID SEARCH /i.test(cmd)) {
				const crit = cmd.slice(11);
				let res: Msg[] = inbox();
				let m;
				if ((m = crit.match(/^SINCE (\d+)-(\w+)-(\d+)/))) {
					const since = Date.UTC(+m[3], MON.indexOf(m[2]), +m[1]);
					res = res.filter((x) => x.date.getTime() >= since);
				} else if ((m = crit.match(/^UID (\d+):\*/))) {
					res = res.filter((x) => x.uids[box] >= +m![1]);
					if (res.length === 0 && inbox().length) res = [inbox()[inbox().length - 1]]; // RFC quirk
				} else if ((m = crit.match(/^X-GM-MSGID (\d+)/))) {
					res = res.filter((x) => x.gmId === m![1]);
				}
				send(`* SEARCH ${res.map((x) => x.uids[box]).join(" ")}`.trimEnd());
				send(`${tag} OK SEARCH completed`);
			} else if (/^UID FETCH /i.test(cmd)) {
				const m = cmd.match(/^UID FETCH ([\d,]+) \((.*)\)$/)!;
				const want = new Set(m[1].split(",").map(Number));
				inbox().forEach((x, idx) => {
					if (!want.has(x.uids[box])) return;
					if (m[2].includes("BODY.PEEK[]")) {
						const bytes = Buffer.from(x.raw, "utf8");
						sock.write(`* ${idx + 1} FETCH (UID ${x.uids[box]} BODY[] {${bytes.length}}\r\n`);
						sock.write(bytes);
						sock.write(`)\r\n`);
					} else {
						send(`* ${idx + 1} FETCH (X-GM-MSGID ${x.gmId} UID ${x.uids[box]} RFC822.SIZE ${x.raw.length} INTERNALDATE "${idate(x.date)}" FLAGS (${x.seen ? "\\Seen" : ""}))`);
					}
				});
				send(`${tag} OK Success`);
			} else if (/^UID STORE /i.test(cmd)) {
				const m = cmd.match(/^UID STORE (\d+) ([+-])X-GM-LABELS \((.*)\)$/)!;
				const x = inbox().find((y) => y.uids[box] === +m[1])!;
				if (m[2] === "+") x.labels.add(m[3]); else x.labels.delete(m[3]);
				gmail.assign(x);
				send(`${tag} OK Success`);
			} else if (/^UID MOVE /i.test(cmd)) {
				const m = cmd.match(/^UID MOVE (\d+) (.+)$/)!;
				const x = inbox().find((y) => y.uids[box] === +m[1])!;
				const dest = BOXNAME[m[2]];
				if (dest === "TRASH") x.trash = true;
				if (dest === "INBOX") { x.trash = false; x.labels.add("\\Inbox"); }
				gmail.assign(x);
				send(`${tag} OK Success`);
			} else if (/^LOGOUT/i.test(cmd)) {
				send(`* BYE`); send(`${tag} OK`); sock.end();
			} else if (/^CAPABILITY/i.test(cmd)) {
				send(`* CAPABILITY IMAP4rev1 X-GM-EXT-1 MOVE`); send(`${tag} OK`);
			} else send(`${tag} BAD unknown`);
		}
	});
});

// ── in-memory store (mirrors MailboxDO semantics) ──────────────────
interface Row { id: string; folder: string; msgId: string; source?: string; uid?: number; sourceFolder?: string; gm?: string | null; read: boolean; date: string }
const rows: Row[] = [];
let state: { uidValidity: number; lastUid: number; initialDone: boolean } | null = null;
const ops: { id: number; op: OpKind; gmMsgId: string }[] = [];
let opSeq = 0;
const store: SyncStore = {
	getState: () => state,
	setState: (_a, st) => { state = { ...st }; },
	ingest: async (raw: Uint8Array, meta: IngestMeta) => {
		const text = Buffer.from(raw).toString("utf8");
		const msgId = text.match(/Message-ID: <([^>]+)>/)![1];
		const ex = rows.find((r) => r.msgId === msgId);
		if (ex) { ex.uid = meta.sourceUid; ex.sourceFolder = "INBOX"; return "dup"; }
		rows.push({ id: `e${rows.length + 1}`, folder: "inbox", msgId, source: meta.source, uid: meta.sourceUid, sourceFolder: "INBOX", gm: meta.gmMsgId, read: !!meta.seen, date: meta.internalDate! });
		return "new";
	},
	pendingOps: () => ops.slice(),
	finishOp: (id, err) => { if (err) throw new Error("op failed: " + err); ops.splice(ops.findIndex((o) => o.id === id), 1); },
	trackedInbox: () => rows.filter((r) => r.sourceFolder === "INBOX").map((r) => ({ emailId: r.id, uid: r.uid!, gmMsgId: r.gm ?? null })),
	resetTracking: () => { rows.forEach((r) => { if (r.sourceFolder === "INBOX") r.sourceFolder = "STALE"; }); },
	sourceLeftInbox: (id, where) => { const r = rows.find((x) => x.id === id)!; r.sourceFolder = where.toUpperCase(); if (r.folder === "inbox" || where === "trash") r.folder = where; },
};
const localMove = (r: Row, op: OpKind) => { ops.push({ id: ++opSeq, op, gmMsgId: r.gm! }); r.sourceFolder = op === "trash" ? "TRASH" : op === "archive" ? "ARCHIVE" : "RESTORING"; r.folder = op === "inbox" ? "inbox" : op; };

// ── run ────────────────────────────────────────────────────────────
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as net.AddressInfo).port;
const open = () => {
	const s = net.connect(port, "127.0.0.1");
	const { readable, writable } = Duplex.toWeb(s) as any;
	return { readable, writable };
};
const acct = { name: "gmail", host: "127.0.0.1", port, user: "me@gmail.com", pass: "secret" };
const run = (o: Partial<Parameters<typeof syncAccount>[2]> = {}) => syncAccount(acct, store, { open, maxMessages: 3, log: (m) => console.log("   log:", m), ...o });

assert.equal(parseImapDateTime("14-Oct-2026 07:31:02 +0800"), "2026-10-13T23:31:02.000Z");

// seed: 5 recent inbox, 1 old (outside 90 days), 1 archived
for (let i = 1; i <= 5; i++) gmail.add(`recent ${i}`, i);
gmail.add("old mail", 200);
gmail.add("archived already", 1, { inbox: false });
gmail.msgs[0].seen = true;

// 1. wrong password
let s = await syncAccount({ ...acct, pass: "nope" }, store, { open });
assert.match(s.error!, /LOGIN failed: NO/);
console.log("✓ bad password reported:", s.error);

// 1b. XOAUTH2: bad token → clean NO (continuation answered), good token → works
s = await syncAccount({ ...acct, pass: undefined, accessToken: async () => "expired" }, store, { open, maxMessages: 0 });
assert.match(s.error!, /AUTHENTICATE failed: NO/);
s = await syncAccount({ ...acct, name: "oauth-probe", pass: undefined, accessToken: async () => "good-token" }, store, { open, maxMessages: 0 });
assert.equal(s.error, undefined);
console.log("✓ XOAUTH2 bad token reported, good token authenticates");

// 2. initial import in batches of 3
s = await run();
assert.equal(s.fetched, 3); assert.equal(s.remaining, 2);
s = await run();
assert.equal(s.fetched, 2); assert.equal(s.remaining, 0);
assert.equal(rows.length, 5);
assert.ok(!rows.some((r) => r.msgId.startsWith(gmail.msgs[5].gmId)), "old mail outside window not imported");
assert.equal(rows.find((r) => r.gm === gmail.msgs[0].gmId)!.read, true, "\\Seen carried over");
assert.ok(!commandsSeen.some((c) => /BODY\[\]/.test(c) && !/PEEK/.test(c)), "never marks read on Gmail");
console.log("✓ initial 90-day import, batched, \\Seen preserved, BODY.PEEK used");

// 3. nothing new → no fetch (handles the UID n:* quirk)
s = await run();
assert.equal(s.fetched + s.duplicates, 0);
console.log("✓ idle run fetches nothing");

// 4. new mail arrives
gmail.add("brand new", 0, { body: "中文内容 ✓" });
s = await run();
assert.equal(s.fetched, 1);
console.log("✓ new mail picked up");

// 5. local trash → Gmail trash
const r1 = rows.find((r) => r.msgId.startsWith(gmail.msgs[1].gmId))!;
localMove(r1, "trash");
s = await run();
assert.equal(s.opsDone, 1);
assert.equal(gmail.msgs[1].trash, true);
console.log("✓ local delete → Gmail Trash");

// 6. local archive → Gmail archive (Inbox label removed)
const r2 = rows.find((r) => r.msgId.startsWith(gmail.msgs[2].gmId))!;
localMove(r2, "archive");
s = await run();
assert.equal(gmail.msgs[2].labels.has("\\Inbox"), false);
assert.equal(gmail.msgs[2].trash, false);
console.log("✓ local archive → Gmail archive");

// 7. Gmail-side: archive one on the phone, delete another
gmail.msgs[3].labels.delete("\\Inbox"); gmail.assign(gmail.msgs[3]);
gmail.msgs[4].trash = true; gmail.assign(gmail.msgs[4]);
s = await run();
assert.equal(s.movedToArchive, 1); assert.equal(s.movedToTrash, 1);
assert.equal(rows.find((r) => r.gm === gmail.msgs[3].gmId)!.folder, "archive");
assert.equal(rows.find((r) => r.gm === gmail.msgs[4].gmId)!.folder, "trash");
console.log("✓ Gmail archive → local Archive, Gmail delete → local Trash");

// 8. restore from local trash → back in Gmail inbox, re-linked via dedup
localMove(r1, "inbox");
s = await run();
assert.equal(gmail.msgs[1].trash, false); assert.ok(gmail.msgs[1].labels.has("\\Inbox"));
s = await run();
assert.equal(r1.sourceFolder, "INBOX"); assert.equal(r1.uid, gmail.msgs[1].uids.INBOX);
assert.equal(rows.length, 6, "no duplicate row");
console.log("✓ restore → Gmail Inbox, re-linked without duplicate");

// 9. UIDVALIDITY change → rescan, dedup keeps rows unique
gmail.uidValidity = 8;
s = await run({ maxMessages: 50 });
assert.equal(rows.length, 6);
assert.equal(s.movedToTrash + s.movedToArchive, 0, "no false deletions after reset");
console.log("✓ UIDVALIDITY reset handled, no duplicates");

server.close();
console.log("\nALL TESTS PASSED");
