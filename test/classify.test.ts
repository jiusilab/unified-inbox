import assert from "node:assert/strict";
const describe = (_: string, fn: () => void) => fn();
const it = (name: string, fn: () => void) => { fn(); console.log("ok", name); };
const expect = (a: unknown) => ({ toBe: (b: unknown) => assert.equal(a, b), toBeNull: () => assert.equal(a, null), toEqual: (b: unknown) => assert.deepEqual(a, b) });
import { heuristics, heuristicVerdict, normalizePattern, senderPatterns, chatCompletionsUrl } from "../workers/classify";

const H = (pairs: [string, string][]) => pairs.map(([key, value]) => ({ key, value }));

describe("classify", () => {
	it("normalizes patterns", () => {
		expect(normalizePattern("Foo <A@B.com>")).toBe("a@b.com");
		expect(normalizePattern("example.com")).toBe("@example.com");
		expect(normalizePattern("@mail.example.com")).toBe("@mail.example.com");
		expect(normalizePattern("nope")).toBeNull();
	});
	it("sender patterns go from specific to broad", () => {
		expect(senderPatterns("x@news.shop.com")).toEqual(["x@news.shop.com", "@news.shop.com", "@shop.com"]);
	});
	it("marketing mail goes to promotions", () => {
		const v = heuristicVerdict(heuristics({
			from: "news@shop.com", fromName: "Shop", subject: "Black Friday: 40% off",
			text: "Huge sale, limited time. Unsubscribe", headers: H([["list-unsubscribe", "<mailto:u@shop.com>"], ["precedence", "bulk"]]),
		}));
		expect(v.folder).toBe("promotions");
	});
	it("billing mail with list-unsubscribe stays in inbox", () => {
		const v = heuristicVerdict(heuristics({
			from: "billing@azure.com", fromName: "Azure", subject: "Your Azure invoice is ready",
			text: "Your invoice. Unsubscribe", headers: H([["list-unsubscribe", "<mailto:u@x.com>"], ["precedence", "bulk"], ["x-mc-user", "1"]]),
		}));
		expect(v.folder).toBe("inbox");
	});
	it("dmarc fail plus spoof goes to spam", () => {
		const v = heuristicVerdict(heuristics({
			from: "a@evil.ru", fromName: "support@paypal.com", subject: "Account", text: "hi",
			headers: H([["authentication-results", "mx.cloudflare.net; dmarc=fail; spf=fail"]]),
		}));
		expect(v.folder).toBe("spam");
	});
	it("plain personal mail stays", () => {
		expect(heuristicVerdict(heuristics({ from: "a@b.com", fromName: "A", subject: "lunch?", text: "tomorrow?", headers: [] })).folder).toBe("inbox");
	});
	it("endpoint url", () => {
		expect(chatCompletionsUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(chatCompletionsUrl("https://x/v1/chat/completions")).toBe("https://x/v1/chat/completions");
	});
});
