import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config as defaultConfig } from "./config.mjs";
import { createLlm, LlmError } from "./llm.mjs";
import { analyzeMessages, editMessages, generateMessages, repairMessages, suggestMessages } from "./prompts.mjs";
import { extractJson, normalizeAnalysis, normalizeSuggestions } from "./json.mjs";
import { clientIp, createRateLimiter } from "./rate-limit.mjs";
import { diagramKind, sanitizeMermaid, stripFences } from "../shared/sanitize.js";

const root = fileURLToPath(new URL("..", import.meta.url));
// URL prefix → directory. Only these are served; nothing else in the project is reachable.
const STATIC = [
  ["/vendor/mermaid/", join(root, "node_modules/mermaid/dist")],
  ["/vendor/dompurify/", join(root, "node_modules/dompurify/dist")],
  ["/vendor/lucide/", join(root, "node_modules/lucide/dist/umd")],
  ["/vendor/space-grotesk/", join(root, "node_modules/@fontsource-variable/space-grotesk")],
  ["/shared/", join(root, "shared")],
  ["/", join(root, "public")],
];
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

// Mermaid injects <style> into its SVG output, so styles need 'unsafe-inline'. Scripts stay 'self' only.
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const USER_KEY_HEADER = "x-user-api-key";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req, maxBytes) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON (content-type: application/json).");
  if (Number(req.headers["content-length"]) > maxBytes) throw new HttpError(413, "Request is too large.");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, "Request is too large.");
    chunks.push(c);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "Body is not valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object.");
  return body;
}

export function requireText(body, field, max) {
  const v = body?.[field];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `"${field}" is required.`);
  if (v.length > max) throw new HttpError(413, `"${field}" is too long (max ${max} characters).`);
  return v.trim();
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

/** Map any error to a safe client response. Never includes stack traces or provider internals. */
function errorBody(err) {
  if (err instanceof LlmError) return { status: err.status ?? 502, body: { error: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  if (err?.name === "TimeoutError") return { status: 504, body: { error: "The model took too long to respond. Try a shorter request." } };
  console.error("unexpected error:", err?.message ?? err);
  return { status: 500, body: { error: "Something went wrong on the server." } };
}

export function createApp({ cfg = defaultConfig, llm = createLlm(cfg), makeUserLlm } = {}) {
  const limiter = createRateLimiter({ windowMs: cfg.rateLimitWindowMs, max: cfg.rateLimitMax });
  makeUserLlm ??= (apiKey) => createLlm({ ...cfg, apiKey });
  let statusCache = { at: 0, value: null };

  /** The LLM for this request: the server's, or (when enabled) one using the visitor's own key. Keys are never logged. */
  function llmFor(req) {
    const key = req.headers[USER_KEY_HEADER];
    if (typeof key !== "string" || !key) return llm;
    if (!cfg.allowUserKeys || cfg.provider !== "openai") throw new HttpError(400, "This server does not accept user API keys.");
    if (key.length > 300 || /\s/.test(key)) throw new HttpError(400, "That API key doesn't look valid.");
    return makeUserLlm(key);
  }

  /** Abort LLM work when the client disconnects or the configured timeout passes. */
  function requestSignal(res) {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    return AbortSignal.any([ac.signal, AbortSignal.timeout(cfg.llmTimeoutMs)]);
  }

  /** Stream model output as SSE `code` events (sanitized, cumulative), then one `done` (or `error`) event. */
  async function streamDiagram(res, model, messages, { fallbackHeader } = {}) {
    const signal = requestSignal(res);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let raw = "";
    let lastSent = "";
    try {
      for await (const delta of model.stream(messages, { signal })) {
        raw += delta;
        if (raw.length > cfg.maxCodeChars * 2) break; // runaway output guard
        const code = sanitizeMermaid(raw);
        if (diagramKind(code) && code !== lastSent) {
          send("code", { code });
          lastSent = code;
        }
      }
      let code = sanitizeMermaid(raw);
      // Small models sometimes drop the header line on edits; restore it and re-run the fixes.
      if (!diagramKind(code) && fallbackHeader && code) code = sanitizeMermaid(`${fallbackHeader}\n${stripFences(raw)}`);
      if (!diagramKind(code)) send("error", { error: "The model did not return a diagram. Try rephrasing the request." });
      else send("done", { code });
    } catch (err) {
      if (!res.destroyed) send("error", errorBody(err).body);
    }
    res.end();
  }

  const logPrompt = (route, text) => { if (cfg.logPrompts) console.log(`  ${route} prompt: ${JSON.stringify(text.slice(0, 500))}`); };

  const api = {
    "GET /api/status": async () => {
      // Cached so page loads don't hammer the provider.
      if (!statusCache.value || Date.now() - statusCache.at > 15_000) statusCache = { at: Date.now(), value: await llm.health() };
      return { provider: cfg.provider, model: cfg.model, allowUserKeys: cfg.allowUserKeys && cfg.provider === "openai", ...statusCache.value };
    },

    "POST /api/analyze": async (req, res) => {
      const model = llmFor(req);
      const prompt = requireText(await readJson(req, cfg.maxBodyBytes), "prompt", cfg.maxPromptChars);
      logPrompt("analyze", prompt);
      let raw = null;
      try {
        raw = extractJson(await model.complete(analyzeMessages(prompt), { json: true, signal: requestSignal(res) }));
      } catch (err) {
        if (err instanceof LlmError || err?.name === "TimeoutError") throw err; // provider down: surface it instead of guessing
      }
      return normalizeAnalysis(raw, prompt);
    },

    "POST /api/generate": async (req, res) => {
      const model = llmFor(req);
      const body = await readJson(req, cfg.maxBodyBytes);
      const prompt = requireText(body, "prompt", cfg.maxPromptChars);
      const answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 5)
        .filter((a) => typeof a?.question === "string" && typeof a?.answer === "string")
        .map((a) => ({ question: a.question.slice(0, 200), answer: a.answer.slice(0, 300) }));
      logPrompt("generate", prompt);
      await streamDiagram(res, model, generateMessages(prompt, body.diagramType, answers));
    },

    "POST /api/edit": async (req, res) => {
      const model = llmFor(req);
      const body = await readJson(req, cfg.maxBodyBytes);
      const code = requireText(body, "code", cfg.maxCodeChars);
      const instruction = requireText(body, "instruction", cfg.maxPromptChars);
      logPrompt("edit", instruction);
      await streamDiagram(res, model, editMessages(code, instruction), { fallbackHeader: code.split("\n")[0].trim() });
    },

    "POST /api/repair": async (req, res) => {
      const model = llmFor(req);
      const body = await readJson(req, cfg.maxBodyBytes);
      const code = requireText(body, "code", cfg.maxCodeChars);
      const error = requireText(body, "error", 2000);
      const fixed = sanitizeMermaid(await model.complete(repairMessages(code, error), { signal: requestSignal(res) }));
      return { code: diagramKind(fixed) ? fixed : code };
    },

    "POST /api/suggest": async (req, res) => {
      const model = llmFor(req);
      const code = requireText(await readJson(req, cfg.maxBodyBytes), "code", cfg.maxCodeChars);
      let raw = null;
      try {
        raw = extractJson(await model.complete(suggestMessages(code), { json: true, signal: requestSignal(res) }));
      } catch (err) {
        console.warn("suggest failed:", err.message);
      }
      return { suggestions: normalizeSuggestions(raw) };
    },
  };

  async function serveStatic(pathname, res, head) {
    let path;
    try { path = decodeURIComponent(pathname === "/" ? "/index.html" : pathname); } catch { path = ""; }
    for (const [prefix, dir] of STATIC) {
      if (!path || path.includes("\0") || !path.startsWith(prefix)) continue;
      const file = normalize(join(dir, path.slice(prefix.length)));
      if (!file.startsWith(dir + sep)) break;
      try {
        if (!(await stat(file)).isFile()) continue;
        const cache = prefix.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache";
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache });
        res.end(head ? undefined : await readFile(file));
        return;
      } catch { /* try next mount */ }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return sendJson(res, 400, { error: "Bad request." }); }

    if (pathname === "/healthz") return sendJson(res, 200, { status: "ok" });

    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });
      return serveStatic(pathname, res, req.method === "HEAD");
    }

    res.on("finish", () => console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
    const route = api[`${req.method} ${pathname}`];
    if (!route) return sendJson(res, 404, { error: "Unknown endpoint." });

    if (req.method === "POST") {
      const verdict = limiter.hit(clientIp(req, cfg.trustProxy));
      if (!verdict.ok) {
        return sendJson(res, 429, { error: "Too many requests. Please wait a moment and try again." }, { "retry-after": String(verdict.retryAfterSec) });
      }
    }
    try {
      const out = await route(req, res);
      if (!res.headersSent) sendJson(res, 200, out);
    } catch (err) {
      const { status, body } = errorBody(err);
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = cfg.llmTimeoutMs + 15_000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = defaultConfig;
  const llm = createLlm(cfg);
  const server = createApp({ cfg, llm });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") console.error(`Port ${cfg.port} is already in use. Set PORT in .env or stop the other process (lsof -i :${cfg.port}).`);
    else console.error(err.message);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, async () => {
    console.log(`Diagram Studio running at http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${cfg.port}`);
    console.log(`Provider: ${cfg.provider}  model: ${cfg.model}  rate limit: ${cfg.rateLimitMax || "off"}/${cfg.rateLimitWindowMs / 1000}s  user keys: ${cfg.allowUserKeys ? "on" : "off"}`);
    const h = await llm.health();
    if (!h.ok) console.warn(`\n!  ${h.message}\n   ${h.hint}\n`);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)).closeAllConnections?.());
}
