// Post-build: embed build/client into the Worker bundle instead of using
// Workers Static Assets (whose upload API cannot be used from this deploy
// environment). Generates build/server/static-assets.js + entry.js and
// rewrites build/server/wrangler.json to use them.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const clientDir = path.join(root, "build/client");
const serverDir = path.join(root, "build/server");
const TYPES = {
	".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
	".ico": "image/x-icon", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
	".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8",
};

const files = {};
(function walk(dir) {
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		if (fs.statSync(p).isDirectory()) walk(p);
		else if (!f.startsWith(".")) {
			const rel = "/" + path.relative(clientDir, p).split(path.sep).join("/");
			files[rel] = { t: TYPES[path.extname(f)] || "application/octet-stream", b: fs.readFileSync(p).toString("base64") };
		}
	}
})(clientDir);

fs.writeFileSync(path.join(serverDir, "static-assets.js"), `export default ${JSON.stringify(files)};\n`);
fs.writeFileSync(path.join(serverDir, "entry.js"), `import worker from "./index.js";
import assets from "./static-assets.js";
export * from "./index.js";
const cache = new Map();
function body(p) {
	let b = cache.get(p);
	if (!b) { const s = atob(assets[p].b); b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); cache.set(p, b); }
	return b;
}
export default {
	...worker,
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if ((request.method === "GET" || request.method === "HEAD") && Object.prototype.hasOwnProperty.call(assets, url.pathname)) {
			const immutable = url.pathname.startsWith("/assets/");
			return new Response(request.method === "HEAD" ? null : body(url.pathname), { headers: {
				"content-type": assets[url.pathname].t,
				"cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
			} });
		}
		return worker.fetch(request, env, ctx);
	},
};
`);
const cfgPath = path.join(serverDir, "wrangler.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
delete cfg.assets;
cfg.main = "entry.js";
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`embedded ${Object.keys(files).length} client files`);
