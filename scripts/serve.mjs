// Dev harness server: builds the extension, then serves the repo on
// http://localhost:5180/dev/harness.html with a mock Marinara API
// (dev/mock-api.mjs), including a fake vision model. Nothing here talks to a
// real Marinara install or a real model.
//
// Usage: node scripts/serve.mjs [port] [cardCount]
//   POST /__mock/reset?count=N&delay=ms&rateLimit=N&fail=all   rebuild the mock (smoke tests)
//   GET  /__mock/stats                                          request counters
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockApi } from "../dev/mock-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 5180;
const COUNT = Number(process.argv[3]) || 300;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const build = () => execFileSync(process.execPath, [join(ROOT, "scripts/build.mjs")], { stdio: "inherit" });
build();
const api = createMockApi({ count: COUNT });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(302, { Location: "/dev/harness.html" });
    return res.end();
  }
  if (url.pathname === "/__mock/reset" && req.method === "POST") {
    const num = (k, d) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : d);
    api.reset({ count: num("count", COUNT), delay: num("delay", 60), rateLimit: num("rateLimit", 0), fail: url.searchParams.get("fail") ?? "" });
    return sendJson(res, 200, { count: api.rows.length });
  }
  if (url.pathname === "/__mock/stats") return sendJson(res, 200, api.stats);
  if (url.pathname.startsWith("/api/avatars/file/")) {
    const bytes = api.avatar(decodeURIComponent(url.pathname.slice("/api/avatars/file/".length)));
    if (!bytes) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    return res.end(bytes);
  }
  if (url.pathname.startsWith("/api/")) {
    const body = req.method === "GET" ? null : await readBody(req);
    if (req.method !== "GET" && req.headers["x-marinara-csrf"] !== "1") return sendJson(res, 403, { error: "missing CSRF header" });
    const result = await api.handle(req.method, url, body);
    if (!result) return sendJson(res, 404, { error: "Mock route not found" });
    return sendJson(res, result[0], result[1]);
  }
  if (url.pathname === "/dev/harness.html") {
    try {
      build();
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(String(error));
    }
  }
  const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// A test that fails mid-run closes its page with requests in flight; keep serving.
createServer((req, res) =>
  handle(req, res).catch((error) => {
    if (error.code !== "ECONNRESET") console.error(error);
    if (!res.headersSent && !res.destroyed) sendJson(res, 500, { error: String(error) });
  }),
).listen(PORT, "127.0.0.1", () => console.log(`Harness: http://localhost:${PORT}/dev/harness.html (${COUNT} mock cards)`));
