// Minimal IMAP4rev1 client for Cloudflare Workers / Durable Objects.
// Transport-agnostic: give it a readable + writable byte stream (e.g. from
// `connect()` in `cloudflare:sockets` with secureTransport "on").
//
// Only the small command subset the unified inbox needs is implemented:
// LOGIN, LIST, SELECT, UID SEARCH, UID FETCH, UID STORE, UID MOVE, LOGOUT.

export interface ImapResponse {
	/** Response text with literals replaced by \u0000<index>\u0000 markers. */
	text: string;
	literals: Uint8Array[];
}

export interface ImapResult {
	status: "OK" | "NO" | "BAD";
	statusText: string;
	untagged: ImapResponse[];
}

export class ImapError extends Error {
	constructor(message: string, public result?: ImapResult) {
		super(message);
	}
}

const CRLF = new Uint8Array([13, 10]);

function bytesToBinaryString(b: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < b.length; i += CHUNK) {
		s += String.fromCharCode(...b.subarray(i, i + CHUNK));
	}
	return s;
}

function binaryStringToBytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
	return out;
}

/** Quote a string for use as an IMAP quoted-string argument. */
export function quote(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Format a date as IMAP search date: 1-Jan-2026 */
export function imapDate(d: Date): string {
	return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export class ImapClient {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private buf: Uint8Array = new Uint8Array(0);
	private tagCounter = 0;
	private closed = false;
	capabilities = new Set<string>();

	constructor(
		readable: ReadableStream<Uint8Array>,
		writable: WritableStream<Uint8Array>,
		private timeoutMs = 30_000,
	) {
		this.reader = readable.getReader();
		this.writer = writable.getWriter();
	}

	// ── low-level reading ─────────────────────────────────────────

	private async fill(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, rej) => {
			timer = setTimeout(() => rej(new ImapError("IMAP read timeout")), this.timeoutMs);
		});
		try {
			const { done, value } = await Promise.race([this.reader.read(), timeout]);
			if (done || !value) {
				this.closed = true;
				throw new ImapError("IMAP connection closed");
			}
			const merged = new Uint8Array(this.buf.length + value.length);
			merged.set(this.buf, 0);
			merged.set(value, this.buf.length);
			this.buf = merged;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Read one line (without CRLF) as a binary string. */
	private async readLine(): Promise<string> {
		let searchFrom = 0;
		while (true) {
			for (let i = searchFrom; i + 1 < this.buf.length; i++) {
				if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
					const line = bytesToBinaryString(this.buf.subarray(0, i));
					this.buf = this.buf.slice(i + 2);
					return line;
				}
			}
			searchFrom = Math.max(0, this.buf.length - 1);
			await this.fill();
		}
	}

	private async readBytes(n: number): Promise<Uint8Array> {
		while (this.buf.length < n) await this.fill();
		const out = this.buf.slice(0, n);
		this.buf = this.buf.slice(n);
		return out;
	}

	/** Read one complete server response, following literals {n}. */
	private async readResponse(): Promise<ImapResponse> {
		let text = "";
		const literals: Uint8Array[] = [];
		while (true) {
			const line = await this.readLine();
			const m = line.match(/\{(\d+)\+?\}$/);
			if (m) {
				const n = Number(m[1]);
				text += line.slice(0, line.length - m[0].length) + `\u0000${literals.length}\u0000`;
				literals.push(await this.readBytes(n));
				continue; // rest of the response continues on the next line
			}
			text += line;
			return { text, literals };
		}
	}

	private async write(s: string): Promise<void> {
		const bytes = binaryStringToBytes(s);
		const out = new Uint8Array(bytes.length + 2);
		out.set(bytes, 0);
		out.set(CRLF, bytes.length);
		await this.writer.write(out);
	}

	// ── protocol ──────────────────────────────────────────────────

	async greeting(): Promise<void> {
		const r = await this.readResponse();
		if (!/^\* (OK|PREAUTH)/i.test(r.text)) throw new ImapError(`Bad greeting: ${r.text}`);
		this.parseCapabilities(r.text);
	}

	private parseCapabilities(text: string) {
		const m = text.match(/\[CAPABILITY ([^\]]+)\]/i) || text.match(/^\* CAPABILITY (.+)$/i);
		if (m) {
			this.capabilities = new Set(m[1].toUpperCase().split(/\s+/));
		}
	}

	async command(cmd: string, logAs?: string): Promise<ImapResult> {
		if (this.closed) throw new ImapError("IMAP connection closed");
		const tag = `A${++this.tagCounter}`;
		await this.write(`${tag} ${cmd}`);
		const untagged: ImapResponse[] = [];
		while (true) {
			const r = await this.readResponse();
			if (r.text.startsWith(`${tag} `)) {
				const rest = r.text.slice(tag.length + 1);
				const sm = rest.match(/^(OK|NO|BAD)\s?(.*)$/i);
				const status = (sm?.[1].toUpperCase() ?? "BAD") as ImapResult["status"];
				const result: ImapResult = { status, statusText: sm?.[2] ?? rest, untagged };
				this.parseCapabilities(rest);
				if (status !== "OK") {
					throw new ImapError(`IMAP ${logAs ?? cmd.split(" ")[0]} failed: ${status} ${result.statusText}`, result);
				}
				return result;
			}
			if (r.text.startsWith("+")) {
				// We never send literals; a continuation request is unexpected.
				throw new ImapError(`Unexpected continuation for ${logAs ?? cmd.split(" ")[0]}`);
			}
			if (r.text.startsWith("* ")) {
				this.parseCapabilities(r.text);
				untagged.push(r);
			}
		}
	}

	async login(user: string, pass: string): Promise<void> {
		await this.command(`LOGIN ${quote(user)} ${quote(pass)}`, "LOGIN");
		if (this.capabilities.size === 0 || !this.capabilities.has("IMAP4REV1")) {
			const r = await this.command("CAPABILITY");
			for (const u of r.untagged) this.parseCapabilities(u.text);
		}
	}

	/** LIST "" "*" → [{ attrs, name }] where name is the raw (quoted) mailbox token. */
	async list(): Promise<{ attrs: string[]; name: string }[]> {
		const r = await this.command(`LIST "" "*"`);
		const out: { attrs: string[]; name: string }[] = [];
		for (const u of r.untagged) {
			const m = u.text.match(/^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$/i);
			if (!m) continue;
			let name = m[2];
			const lit = name.match(/^\u0000(\d+)\u0000$/);
			if (lit) name = quote(bytesToBinaryString(u.literals[Number(lit[1])]));
			out.push({ attrs: m[1].split(/\s+/).filter(Boolean), name });
		}
		return out;
	}

	/** SELECT a mailbox (name must already be an IMAP token, e.g. "INBOX" or a quoted string). */
	async select(name: string): Promise<{ uidValidity: number; uidNext: number; exists: number }> {
		const r = await this.command(`SELECT ${name}`);
		let uidValidity = 0, uidNext = 0, exists = 0;
		for (const u of r.untagged) {
			const v = u.text.match(/\[UIDVALIDITY (\d+)\]/i);
			if (v) uidValidity = Number(v[1]);
			const n = u.text.match(/\[UIDNEXT (\d+)\]/i);
			if (n) uidNext = Number(n[1]);
			const e = u.text.match(/^\* (\d+) EXISTS/i);
			if (e) exists = Number(e[1]);
		}
		return { uidValidity, uidNext, exists };
	}

	async uidSearch(criteria: string): Promise<number[]> {
		const r = await this.command(`UID SEARCH ${criteria}`);
		const uids: number[] = [];
		for (const u of r.untagged) {
			const m = u.text.match(/^\* SEARCH ?(.*)$/i);
			if (!m) continue;
			for (const t of m[1].trim().split(/\s+/)) {
				if (/^\d+$/.test(t)) uids.push(Number(t));
			}
		}
		return uids.sort((a, b) => a - b);
	}

	/**
	 * UID FETCH. Returns one entry per FETCH response with parsed common items.
	 * `body` is the first literal (BODY[] / BODY.PEEK[]) when requested.
	 */
	async uidFetch(uidSet: string, items: string): Promise<FetchedMessage[]> {
		const r = await this.command(`UID FETCH ${uidSet} (${items})`, "UID FETCH");
		const out: FetchedMessage[] = [];
		for (const u of r.untagged) {
			if (!/^\* \d+ FETCH /i.test(u.text)) continue;
			const uid = u.text.match(/\bUID (\d+)/i);
			if (!uid) continue;
			const gm = u.text.match(/\bX-GM-MSGID (\d+)/i);
			const size = u.text.match(/\bRFC822\.SIZE (\d+)/i);
			const idate = u.text.match(/\bINTERNALDATE "([^"]+)"/i);
			const flags = u.text.match(/\bFLAGS \(([^)]*)\)/i);
			const bodyMarker = u.text.match(/BODY\[\]\s*\u0000(\d+)\u0000/i);
			out.push({
				uid: Number(uid[1]),
				gmMsgId: gm ? gm[1] : null,
				size: size ? Number(size[1]) : null,
				internalDate: idate ? parseImapDateTime(idate[1]) : null,
				flags: flags ? flags[1].split(/\s+/).filter(Boolean) : [],
				body: bodyMarker ? u.literals[Number(bodyMarker[1])] : null,
			});
		}
		return out;
	}

	async uidStore(uidSet: string, item: string): Promise<void> {
		await this.command(`UID STORE ${uidSet} ${item}`, "UID STORE");
	}

	async uidMove(uidSet: string, dest: string): Promise<void> {
		if (this.capabilities.has("MOVE")) {
			await this.command(`UID MOVE ${uidSet} ${dest}`, "UID MOVE");
		} else {
			await this.command(`UID COPY ${uidSet} ${dest}`, "UID COPY");
			await this.uidStore(uidSet, "+FLAGS.SILENT (\\Deleted)");
			await this.command(`UID EXPUNGE ${uidSet}`, "UID EXPUNGE");
		}
	}

	async logout(): Promise<void> {
		try {
			if (!this.closed) await this.command("LOGOUT");
		} catch {
			/* ignore */
		}
		try { await this.writer.close(); } catch { /* ignore */ }
		try { this.reader.releaseLock(); } catch { /* ignore */ }
	}
}

export interface FetchedMessage {
	uid: number;
	gmMsgId: string | null;
	size: number | null;
	internalDate: string | null;
	flags: string[];
	body: Uint8Array | null;
}

/** "14-Oct-2026 07:31:02 +0000" → ISO string */
export function parseImapDateTime(s: string): string | null {
	const m = s.trim().match(/^(\d{1,2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
	if (!m) return null;
	const mon = MONTHS.indexOf(m[2]);
	if (mon < 0) return null;
	const sign = m[7] === "-" ? -1 : 1;
	const offsetMin = sign * (Number(m[8]) * 60 + Number(m[9]));
	const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offsetMin * 60_000;
	return new Date(utc).toISOString();
}
