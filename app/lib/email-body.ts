// Turns an email body into HTML suitable for EmailIframe.
//
// Bodies are stored as `parsed.html || parsed.text`, so plain-text mail
// (and mail whose text part is Markdown — agents, CI bots, GitHub-style
// notifications) reaches the viewer as raw text. Dropped into HTML as-is,
// its newlines collapse and Markdown markup shows up literally. Here we:
//   - leave real HTML mail alone;
//   - render text that looks like Markdown with GFM (tables, lists, code);
//   - show any other plain text with its line breaks kept and URLs linked.
// The result is still sanitised by DOMPurify inside EmailIframe.

import { Marked } from "marked";

const HTML_TAG =
	/<(?:!doctype|html|head|body|div|p|br|table|tr|td|span|a|img|font|b|i|u|strong|em|ul|ol|li|h[1-6]|center|meta|style|blockquote|pre|hr|section)\b[^>]*>/i;

// Tags a "Markdown pasted into a plain HTML wrapper" message may contain
// (e.g. Gmail's <div dir="ltr">…<br>…</div>). Anything richer is real HTML.
const TRIVIAL_TAGS = /^(?:div|p|br|span|font|pre|wbr)$/i;

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
	// Plain-text mail often indents paragraphs by 4+ spaces; don't turn those
	// into code blocks. Fenced ``` blocks still work.
	tokenizer: {
		code() {
			return undefined;
		},
	},
	renderer: {
		link({ href, title, tokens }) {
			const text = this.parser.parseInline(tokens);
			const t = title ? ` title="${escapeAttr(title)}"` : "";
			return `<a href="${escapeAttr(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
		},
	},
});

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/'/g, "&#39;");
}

export function looksLikeHtml(body: string): boolean {
	return HTML_TAG.test(body);
}

/** Heuristic: does this plain text use Markdown markup? */
export function looksLikeMarkdown(text: string): boolean {
	let score = 0;
	if (/^#{1,6}\s+\S/m.test(text)) score += 2; // heading
	if (/^\s{0,3}(```|~~~)/m.test(text)) score += 2; // fenced code
	if (/^\s*\|.+\|\s*$/m.test(text) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)) score += 2; // table
	if (/\[[^\]\n]+\]\((https?:|mailto:)[^)\s]+\)/.test(text)) score += 2; // [text](url)
	if (/(\*\*|__)[^\s*_][^\n]*?\1/.test(text)) score += 1; // bold
	if (/`[^`\n]+`/.test(text)) score += 1; // inline code
	if ((text.match(/^\s{0,3}[-*+]\s+\S/gm) || []).length >= 2) score += 1; // bullet list
	if ((text.match(/^\s{0,3}\d+[.)]\s+\S/gm) || []).length >= 2) score += 1; // numbered list
	if (/^\s{0,3}>\s?\S/m.test(text)) score += 1; // quote
	if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/m.test(text)) score += 1; // rule
	return score >= 2;
}

function linkify(escaped: string): string {
	return escaped.replace(
		/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
		(url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
	);
}

function plainTextToHtml(text: string): string {
	return `<div class="__plain">${linkify(escapeHtml(text))}</div>`;
}

function markdownToHtml(text: string): string {
	const html = marked.parse(text, { async: false }) as string;
	return `<div class="__md">${html}</div>`;
}

/** Extract text from an HTML body that only wraps plain text in trivial tags. */
function trivialHtmlToText(html: string): string | null {
	const tags = html.match(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi) || [];
	for (const tag of tags) {
		const name = tag.replace(/^<\/?/, "").match(/^[a-z][a-z0-9]*/i)?.[0] || "";
		if (!TRIVIAL_TAGS.test(name)) return null;
	}
	const text = html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(div|p)>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
	return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function emailBodyToHtml(body: string): string {
	if (!body) return body;
	if (looksLikeHtml(body)) {
		const text = trivialHtmlToText(body);
		if (text && looksLikeMarkdown(text)) return markdownToHtml(text);
		return body;
	}
	const text = body.replace(/\r\n?/g, "\n");
	return looksLikeMarkdown(text) ? markdownToHtml(text) : plainTextToHtml(text);
}
