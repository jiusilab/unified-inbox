// Incoming-mail classification: inbox / promotions / spam.
//
// Order of decisions:
//   1. sender rules (allow / spam / promo), learned from the user's moves or
//      added in Settings — exact address first, then @domain
//   2. replies to the user's own mail and verification codes stay in the inbox
//   3. optional LLM (OpenAI-compatible endpoint configured in Settings)
//   4. header heuristics (authentication results, bulk-mail markers)
//
// Everything here is pure except the LLM call, so it is easy to test.

export type MailClass = "inbox" | "promotions" | "spam";
export type RuleKind = "allow" | "spam" | "promo";

export interface Header {
	key: string;
	value: string;
}

export interface MailFacts {
	from: string; // address, lowercase
	fromName: string;
	subject: string;
	text: string; // plain text body (may be truncated)
	headers: Header[];
}

export interface Verdict {
	folder: MailClass;
	reason: string;
}

export interface LlmConfig {
	enabled: boolean;
	endpoint: string;
	model: string;
	apiKey: string;
}

export const ruleKindToFolder: Record<RuleKind, MailClass> = {
	allow: "inbox",
	spam: "spam",
	promo: "promotions",
};

/** Normalize what the user typed into a rule pattern: "a@b.com" or "@b.com". */
export function normalizePattern(input: string): string | null {
	let p = String(input || "").trim().toLowerCase();
	const m = p.match(/<([^>]+)>/);
	if (m) p = m[1];
	if (!p) return null;
	if (!p.includes("@")) p = "@" + p; // bare domain
	if (p.startsWith("@")) return /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(p) ? p : null;
	return /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(p) ? p : null;
}

export function domainOf(address: string): string {
	const i = address.lastIndexOf("@");
	return i >= 0 ? address.slice(i + 1).toLowerCase() : "";
}

/** Candidate patterns for a sender, most specific first. */
export function senderPatterns(address: string): string[] {
	const addr = address.toLowerCase();
	const dom = domainOf(addr);
	const out = [addr];
	if (dom) {
		const parts = dom.split(".");
		// @mail.example.com, then @example.com
		for (let i = 0; i < parts.length - 1; i++) out.push("@" + parts.slice(i).join("."));
	}
	return out;
}

function header(headers: Header[], name: string): string | null {
	const h = headers.find((x) => x.key?.toLowerCase() === name);
	return h ? String(h.value ?? "") : null;
}

function allHeaders(headers: Header[], name: string): string[] {
	return headers.filter((x) => x.key?.toLowerCase() === name).map((x) => String(x.value ?? ""));
}

// Mail that carries one of these is about money, accounts or security: never
// treat it as promotions on header evidence alone.
const TRANSACTIONAL = [
	"invoice", "receipt", "payment", "billing", "bill ", "statement", "order", "shipped", "delivery",
	"security alert", "sign-in", "sign in", "login", "password", "verify", "verification", "suspended",
	"overdue", "refund", "subscription", "renewal", "your account",
	"账单", "发票", "收据", "付款", "支付", "扣款", "退款", "订单", "发货", "物流", "密码", "登录", "安全",
	"验证", "账户", "账号", "续费", "到期", "欠费",
];

const PROMO_WORDS = [
	"unsubscribe", "newsletter", "% off", "sale", "deal", "discount", "coupon", "promo", "limited time",
	"webinar", "don't miss", "last chance", "special offer", "black friday", "cyber monday",
	"退订", "优惠", "折扣", "促销", "限时", "特惠", "大促", "活动", "福利", "领取", "订阅",
];

const SPAM_WORDS = [
	"lottery", "winner", "you have won", "claim your prize", "inheritance", "bitcoin investment",
	"crypto giveaway", "wire transfer", "beneficiary", "viagra", "casino", "loan approved",
	"中奖", "彩票", "博彩", "赌场", "代开发票", "贷款", "刷单", "兼职日结",
];

export interface HeuristicResult {
	spamScore: number;
	promo: boolean;
	transactional: boolean;
	hints: string[];
}

export function heuristics(f: MailFacts): HeuristicResult {
	const hints: string[] = [];
	let spamScore = 0;
	const hay = `${f.subject}\n${f.text.slice(0, 4000)}`.toLowerCase();

	// Authentication (Cloudflare Email Routing / the source provider add these)
	const auth = allHeaders(f.headers, "authentication-results").join(" ; ").toLowerCase()
		+ " " + (header(f.headers, "arc-authentication-results") || "").toLowerCase();
	if (/\bdmarc=fail\b/.test(auth)) { spamScore += 3; hints.push("dmarc=fail"); }
	const spfFail = /\bspf=(fail|softfail)\b/.test(auth);
	const dkimPass = /\bdkim=pass\b/.test(auth);
	if (spfFail && !dkimPass) { spamScore += 2; hints.push("spf fail, no dkim"); }

	// Display name pretends to be another address
	const nameAddr = f.fromName.toLowerCase().match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
	if (nameAddr && domainOf(f.from) && nameAddr[1] !== domainOf(f.from)) {
		spamScore += 2; hints.push("display-name spoof");
	}

	// Reply-To on a different domain
	const replyTo = (header(f.headers, "reply-to") || "").toLowerCase().match(/[a-z0-9._%+-]+@([a-z0-9.-]+)/);
	if (replyTo && domainOf(f.from) && !replyTo[1].endsWith(domainOf(f.from)) && !domainOf(f.from).endsWith(replyTo[1])) {
		spamScore += 1; hints.push("reply-to other domain");
	}

	const spamWords = SPAM_WORDS.filter((w) => hay.includes(w));
	if (spamWords.length) { spamScore += Math.min(3, spamWords.length); hints.push(`spam words: ${spamWords.slice(0, 3).join(", ")}`); }

	// Bulk / marketing markers
	const listUnsub = !!header(f.headers, "list-unsubscribe");
	const precedence = (header(f.headers, "precedence") || "").toLowerCase();
	const esp = f.headers.some((h) => /^(x-mailgun|x-sg-|x-mc-|x-mailchimp|x-campaign|x-sfmc|x-marketo|x-hubspot|x-ems|x-mailer-recptid|x-cm-)/i.test(h.key || ""));
	const promoWords = PROMO_WORDS.filter((w) => hay.includes(w)).length;
	let bulk = 0;
	if (listUnsub) { bulk += 2; hints.push("list-unsubscribe"); }
	if (precedence === "bulk") { bulk += 1; hints.push("precedence: bulk"); }
	if (esp) { bulk += 1; hints.push("marketing sender"); }
	if (promoWords >= 2) { bulk += 1; hints.push("promo words"); }

	const transactional = TRANSACTIONAL.some((w) => f.subject.toLowerCase().includes(w));
	if (transactional) hints.push("transactional subject");
	const promo = bulk >= 3 && !transactional;

	return { spamScore, promo, transactional, hints };
}

export const SPAM_THRESHOLD = 4;

/** Decide from heuristics alone. */
export function heuristicVerdict(h: HeuristicResult): Verdict {
	if (h.spamScore >= SPAM_THRESHOLD) return { folder: "spam", reason: `heuristic: ${h.hints.join("; ")}` };
	if (h.promo) return { folder: "promotions", reason: `heuristic: ${h.hints.join("; ")}` };
	return { folder: "inbox", reason: "heuristic: clean" };
}

export function chatCompletionsUrl(endpoint: string): string {
	const e = endpoint.trim().replace(/\/+$/, "");
	if (/\/chat\/completions$/.test(e)) return e;
	return e + "/chat/completions";
}

const SYSTEM_PROMPT = `You sort incoming email for one person into exactly one category:
- "inbox": personal or work mail, replies, anything about their accounts, money, orders, security, deadlines, applications, or anything they would want to see.
- "promotions": legitimate marketing, newsletters, product announcements, sales, event invitations, digests they subscribed to.
- "spam": unsolicited junk, scams, phishing, impersonation, mail they never asked for.
When unsure between inbox and anything else, choose inbox.
Answer with JSON only: {"category":"inbox|promotions|spam"}`;

/** Ask an OpenAI-compatible chat endpoint. Throws on any failure. */
export async function llmClassify(cfg: LlmConfig, f: MailFacts, h: HeuristicResult, timeoutMs = 15000): Promise<MailClass> {
	const user = [
		`From: ${f.fromName ? `${f.fromName} ` : ""}<${f.from}>`,
		`Subject: ${f.subject}`,
		h.hints.length ? `Header signals: ${h.hints.join("; ")}` : "",
		"",
		f.text.replace(/\s+/g, " ").slice(0, 1500),
	].filter((x) => x !== "").join("\n");

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(chatCompletionsUrl(cfg.endpoint), {
			method: "POST",
			signal: ctrl.signal,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.apiKey}`,
			},
			body: JSON.stringify({
				model: cfg.model,
				temperature: 0,
				max_tokens: 20,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: user },
				],
			}),
		});
		if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const data = (await res.json()) as any;
		const content = String(data?.choices?.[0]?.message?.content ?? "").toLowerCase();
		const m = content.match(/"category"\s*:\s*"(inbox|promotions|spam)"/) || content.match(/\b(inbox|promotions|spam)\b/);
		if (!m) throw new Error(`LLM answer not understood: ${content.slice(0, 100)}`);
		return m[1] as MailClass;
	} finally {
		clearTimeout(timer);
	}
}

export function htmlToPlain(html: string): string {
	return html
		.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|td|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ")
		.replace(/[ \t]+/g, " ");
}
