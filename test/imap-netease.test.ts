// Run: npx tsx test/imap-netease.test.ts — non-Gmail IMAP (NetEase-style: ID required before SELECT)
import net from "node:net";
import { Duplex } from "node:stream";
import assert from "node:assert/strict";
import { syncAccount, testLogin, type SyncStore } from "../workers/imap/sync";

const raw = (i: number) => [`Message-ID: <n${i}@163.com>`, `From: a@163.com`, `To: me@163.com`, `Subject: hi ${i}`,
	`Date: ${new Date().toUTCString()}`, ``, `body ${i}`, ``].join("\r\n");
const msgs = [1, 2, 3].map((i) => ({ uid: i, raw: raw(i) }));
const server = net.createServer((sock) => {
	let ided = false; let buf = "";
	const send = (s: string) => sock.write(s + "\r\n");
	send("* OK Coremail System IMap Server Ready");
	sock.on("data", (d) => {
		buf += d.toString("latin1"); let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 2);
			const [tag, ...rest] = line.split(" "); const cmd = rest.join(" ");
			if (/^LOGIN/i.test(cmd)) send(cmd.includes('"code"') ? `${tag} OK [CAPABILITY IMAP4rev1 ID UIDPLUS] LOGIN completed` : `${tag} NO LOGIN Login error password error`);
			else if (/^CAPABILITY/i.test(cmd)) { send("* CAPABILITY IMAP4rev1 ID UIDPLUS"); send(`${tag} OK`); }
			else if (/^ID /i.test(cmd)) { ided = true; send(`* ID ("name" "Coremail")`); send(`${tag} OK ID completed`); }
			else if (/^LIST/i.test(cmd)) { send(`* LIST () "/" "INBOX"`); send(`${tag} OK`); }
			else if (/^SELECT/i.test(cmd)) {
				if (!ided) { send(`${tag} NO SELECT Unsafe Login. Please contact kefu@188.com for help`); continue; }
				send(`* ${msgs.length} EXISTS`); send(`* OK [UIDVALIDITY 1] x`); send(`* OK [UIDNEXT 4] x`); send(`${tag} OK [READ-WRITE] SELECT completed`);
			} else if (/^UID SEARCH/i.test(cmd)) {
				const m = cmd.match(/UID (\d+):\*/); const from = m ? +m[1] : 1;
				send(`* SEARCH ${msgs.filter((x) => x.uid >= from).map((x) => x.uid).join(" ")}`.trimEnd()); send(`${tag} OK`);
			} else if (/^UID FETCH/i.test(cmd)) {
				const set = cmd.split(" ")[2]; const want = new Set(set.split(",").flatMap((r) => { const [a, b] = r.split(":"); const out = []; for (let u = +a; u <= (b ? (b === "*" ? 99 : +b) : +a); u++) out.push(u); return out; }));
				for (const x of msgs.filter((m) => want.has(m.uid))) {
					if (/BODY\.PEEK\[\]/i.test(cmd)) send(`* ${x.uid} FETCH (UID ${x.uid} FLAGS () BODY[] {${x.raw.length}}\r\n${x.raw})`);
					else send(`* ${x.uid} FETCH (UID ${x.uid} FLAGS () INTERNALDATE "14-Oct-2026 10:00:00 +0800" RFC822.SIZE ${x.raw.length})`);
				}
				send(`${tag} OK`);
			} else if (/^LOGOUT/i.test(cmd)) { send("* BYE"); send(`${tag} OK`); sock.end(); }
			else send(`${tag} BAD ${cmd}`);
		}
	});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as net.AddressInfo).port;
const open = () => { const s = net.connect(port, "127.0.0.1"); return Duplex.toWeb(s) as any; };
const acct = { name: "imap:me@163.com", host: "127.0.0.1", port, user: "me@163.com", pass: "code" };

await assert.rejects(testLogin({ ...acct, pass: "bad" }, open), /LOGIN failed/);
await testLogin(acct, open);
console.log("✓ testLogin: bad code rejected, good code + ID passes SELECT");

const ingested: string[] = []; let state: any = null;
const store: SyncStore = {
	getState: () => state, setState: (_a, s) => { state = s; },
	ingest: async (r) => { ingested.push(new TextDecoder().decode(r).match(/Subject: (.*)/)![1]); return "new"; },
	pendingOps: () => [], finishOp: () => {}, trackedInbox: () => [], sourceLeftInbox: () => {}, resetTracking: () => {},
};
let s = await syncAccount(acct, store, { open, maxMessages: 10 });
assert.equal(s.error, undefined, s.error); assert.equal(ingested.length, 3);
msgs.push({ uid: 4, raw: raw(4) });
s = await syncAccount(acct, store, { open, maxMessages: 10 });
assert.equal(s.error, undefined); assert.deepEqual(ingested, ["hi 1", "hi 2", "hi 3", "hi 4"]);
console.log("✓ non-Gmail import + incremental");
server.close();
console.log("ALL TESTS PASSED");
