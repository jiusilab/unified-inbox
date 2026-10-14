// Minimal POP3 client for Workers TCP sockets (implicit TLS, port 995).
// USER/PASS, STAT, UIDL, TOP, RETR, QUIT. Messages are never deleted on the server.

const CRLF = new Uint8Array([13, 10]);

export class Pop3Error extends Error {}

function binaryStringToBytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
	return out;
}

export class Pop3Client {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private buf: Uint8Array = new Uint8Array(0);
	private closed = false;

	constructor(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, private timeoutMs = 30_000) {
		this.reader = readable.getReader();
		this.writer = writable.getWriter();
	}

	private async fill(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, rej) => {
			timer = setTimeout(() => rej(new Pop3Error("POP3 read timeout")), this.timeoutMs);
		});
		try {
			const { done, value } = await Promise.race([this.reader.read(), timeout]);
			if (done || !value) {
				this.closed = true;
				throw new Pop3Error("POP3 connection closed");
			}
			const merged = new Uint8Array(this.buf.length + value.length);
			merged.set(this.buf, 0);
			merged.set(value, this.buf.length);
			this.buf = merged;
		} finally {
			clearTimeout(timer);
		}
	}

	/** One line as raw bytes, without CRLF. */
	private async readLineBytes(): Promise<Uint8Array> {
		let from = 0;
		while (true) {
			for (let i = from; i + 1 < this.buf.length; i++) {
				if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
					const line = this.buf.slice(0, i);
					this.buf = this.buf.slice(i + 2);
					return line;
				}
			}
			from = Math.max(0, this.buf.length - 1);
			await this.fill();
		}
	}

	private async readLine(): Promise<string> {
		const b = await this.readLineBytes();
		let s = "";
		for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return s;
	}

	private async write(s: string) {
		const bytes = binaryStringToBytes(s);
		const out = new Uint8Array(bytes.length + 2);
		out.set(bytes, 0);
		out.set(CRLF, bytes.length);
		await this.writer.write(out);
	}

	private async status(what: string): Promise<string> {
		const line = await this.readLine();
		if (line.startsWith("+OK")) return line.slice(3).trim();
		throw new Pop3Error(`POP3 ${what} failed: ${line}`);
	}

	/** Multi-line response body as bytes (dot-unstuffed, CRLF line endings). */
	private async multiline(maxBytes = Infinity): Promise<Uint8Array | null> {
		const parts: Uint8Array[] = [];
		let size = 0;
		let tooBig = false;
		while (true) {
			let line = await this.readLineBytes();
			if (line.length === 1 && line[0] === 46) break; // "."
			if (line.length > 0 && line[0] === 46) line = line.slice(1);
			if (tooBig) continue;
			size += line.length + 2;
			if (size > maxBytes) { tooBig = true; parts.length = 0; continue; }
			parts.push(line, CRLF);
		}
		if (tooBig) return null;
		const out = new Uint8Array(size);
		let o = 0;
		for (const p of parts) { out.set(p, o); o += p.length; }
		return out;
	}

	async greeting() { await this.status("greeting"); }

	async login(user: string, pass: string) {
		await this.write(`USER ${user}`);
		await this.status("USER");
		await this.write(`PASS ${pass}`);
		await this.status("PASS");
	}

	/** msg number → UIDL, in server order (oldest first). */
	async uidl(): Promise<{ n: number; uid: string }[]> {
		await this.write("UIDL");
		await this.status("UIDL");
		const body = await this.multiline();
		const text = new TextDecoder("latin1").decode(body!);
		return text.split("\r\n").filter(Boolean).map((l) => {
			const [n, uid] = l.trim().split(/\s+/);
			return { n: Number(n), uid };
		});
	}

	async list(): Promise<Map<number, number>> {
		await this.write("LIST");
		await this.status("LIST");
		const text = new TextDecoder("latin1").decode((await this.multiline())!);
		const m = new Map<number, number>();
		for (const l of text.split("\r\n").filter(Boolean)) {
			const [n, size] = l.trim().split(/\s+/);
			m.set(Number(n), Number(size));
		}
		return m;
	}

	/** Headers only. */
	async top(n: number): Promise<string> {
		await this.write(`TOP ${n} 0`);
		await this.status("TOP");
		return new TextDecoder("latin1").decode((await this.multiline())!);
	}

	async retr(n: number, maxBytes?: number): Promise<Uint8Array | null> {
		await this.write(`RETR ${n}`);
		await this.status("RETR");
		return this.multiline(maxBytes);
	}

	async quit() {
		try {
			if (!this.closed) {
				await this.write("QUIT");
				await this.readLine();
			}
		} catch { /* ignore */ }
		try { await this.writer.close(); } catch { /* ignore */ }
		try { this.reader.releaseLock(); } catch { /* ignore */ }
	}
}

/** Date: header from a raw header block → ms, or null. */
export function headerDate(headers: string): number | null {
	const m = headers.match(/^Date:\s*(.+(?:\r\n[ \t].+)*)/im);
	if (!m) return null;
	const t = Date.parse(m[1].replace(/\r\n[ \t]+/g, " ").replace(/\s*\([^)]*\)\s*$/, ""));
	return Number.isFinite(t) ? t : null;
}
