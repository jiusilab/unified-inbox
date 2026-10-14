// Detect verification-code emails and pull the code out.

const KEYWORDS = [
	"验证码", "校验码", "动态码", "动态密码", "确认码", "安全码", "登录码", "授权码",
	"verification code", "verify code", "security code", "one-time", "one time", "otp",
	"login code", "sign-in code", "sign in code", "your code", "confirmation code", "passcode", "access code",
	"código", "認証コード", "確認コード", "인증",
];

// Mail that may contain those words but should never be swallowed.
const EXCLUDE = [
	"重置密码", "找回密码", "reset your password", "password reset", "reset password",
	"账单", "扣款", "invoice", "receipt", "payment", "statement",
];

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|td|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ")
		.replace(/[ \t]+/g, " ");
}

export interface OtpHit {
	code: string;
}

export function detectOtp(subject: string, body: string): OtpHit | null {
	const text = htmlToText(body || "");
	const hay = `${subject}\n${text}`;
	const low = hay.toLowerCase();
	if (!KEYWORDS.some((k) => low.includes(k))) return null;
	if (EXCLUDE.some((k) => low.includes(k))) return null;

	// Look for a code close to a keyword first (within ~80 chars after it), then anywhere.
	const codeRe = /(?<![\w./:@#-])([0-9]{4,8}|(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![\w./:@-])/g;
	const isNoise = (c: string) =>
		/^(19|20)\d{2}$/.test(c) || // a year
		/^0+$/.test(c);
	for (const k of KEYWORDS) {
		let idx = low.indexOf(k);
		while (idx >= 0) {
			const win = hay.slice(Math.max(0, idx - 40), idx + k.length + 80);
			for (const m of win.matchAll(codeRe)) {
				if (!isNoise(m[1])) return { code: m[1] };
			}
			idx = low.indexOf(k, idx + 1);
		}
	}
	return null;
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
	const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
	});
	return r.ok;
}

export function escapeHtml(s: string) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
