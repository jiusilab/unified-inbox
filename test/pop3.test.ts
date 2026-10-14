// Run: npx tsx test/pop3.test.ts
import net from "node:net";
import { Duplex } from "node:stream";
import assert from "node:assert/strict";
import { syncPop3, testPop3Login, type Pop3Store } from "../workers/pop3/sync";

const mk = (i: number, daysAgo: number) => [`Message-ID: <p${i}@x>`, `Subject: m${i}`, `Date: ${new Date(Date.now() - daysAgo * 864e5).toUTCString()}`, ``, `.leading dot line`, `body ${i}`].join("\r\n");
const msgs = [{ uid: "u1", raw: mk(1, 200) }, { uid: "u2", raw: mk(2, 100) }, { uid: "u3", raw: mk(3, 5) }, { uid: "u4", raw: mk(4, 1) }];
const stuff = (r: string) => r.split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
const server = net.createServer((sock) => {
	let buf = ""; let authed = false;
	const send = (s: string) => sock.write(s + "\r\n");
	send("+OK POP3 ready");
	sock.on("data", (d) => {
		buf += d.toString("latin1"); let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 2);
			const [cmd, a] = line.split(" ");
			if (cmd === "USER") send("+OK");
			else if (cmd === "PASS") { if (a === "code") { authed = true; send("+OK"); } else send("-ERR authorization failed"); }
			else if (!authed) send("-ERR");
			else if (cmd === "UIDL") { send("+OK"); msgs.forEach((m, k) => send(`${k + 1} ${m.uid}`)); send("."); }
			else if (cmd === "TOP") { const m = msgs[+a - 1]; send("+OK"); send(stuff(m.raw.split("\r\n\r\n")[0])); send(""); send("."); }
			else if (cmd === "RETR") { const m = msgs[+a - 1]; send("+OK"); send(stuff(m.raw)); send("."); }
			else if (cmd === "QUIT") { send("+OK bye"); sock.end(); }
			else send("-ERR unknown");
		}
	});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as net.AddressInfo).port;
const open = () => Duplex.toWeb(net.connect(port, "127.0.0.1")) as any;
const acct = { name: "pop3:me@163.com", host: "127.0.0.1", port, user: "me@163.com", pass: "code" };

await assert.rejects(testPop3Login({ ...acct, pass: "x" }, open), /PASS failed/);
await testPop3Login(acct, open);
console.log("✓ login check");

const got: string[] = []; const seen = new Set<string>(); let init = false;
const store: Pop3Store = {
	isInitialDone: () => init, setInitialDone: () => { init = true; },
	seen: () => new Set(seen), markSeen: (_a, u) => u.forEach((x) => seen.add(x)),
	ingest: async (raw) => { const t = new TextDecoder().decode(raw); assert.ok(t.includes("\r\n.leading dot line\r\n")); got.push(t.match(/Subject: (.*)/)![1]); return "new"; },
};
let s = await syncPop3(acct, store, { open, maxMessages: 1 });
assert.equal(s.error, undefined, s.error); assert.deepEqual(got, ["m4"]); assert.equal(init, false);
s = await syncPop3(acct, store, { open, maxMessages: 5 });
assert.deepEqual(got, ["m4", "m3"]); assert.equal(init, true, "stops at 90-day cutoff");
assert.ok(seen.has("u1") && seen.has("u2"));
msgs.push({ uid: "u5", raw: mk(5, 0) });
s = await syncPop3(acct, store, { open });
assert.deepEqual(got, ["m4", "m3", "m5"]);
s = await syncPop3(acct, store, { open });
assert.equal(s.fetched, 0);
console.log("✓ initial newest-first to cutoff, dot-unstuffing, incremental, idle");
server.close();
console.log("ALL TESTS PASSED");
