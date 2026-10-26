import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/server.mjs";
import { loadConfig } from "../server/config.mjs";
import { LlmError } from "../server/llm.mjs";

// Fake provider: each test sets `reply` (string, chunk array, or Error) and inspects `calls`.
let reply = "";
const calls = [];
function fakeLlm(tag) {
  return {
    async *stream(messages, opts) {
      calls.push({ tag, messages, opts });
      if (reply instanceof Error) throw reply;
      for (const c of Array.isArray(reply) ? reply : [reply]) yield c;
    },
    async complete(messages, opts) {
      let out = "";
      for await (const d of this.stream(messages, opts)) out += d;
      return out;
    },
    async health() { return { ok: true }; },
  };
}

const userKeys = [];
async function startApp(env = {}) {
  const cfg = loadConfig({ RATE_LIMIT_MAX: "1000", ...env });
  const server = createApp({ cfg, llm: fakeLlm("server"), makeUserLlm: (key) => { userKeys.push(key); return fakeLlm("user"); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let app;
before(async () => { app = await startApp(); });
after(() => app.server.close());

const post = (path, body, { base = app.base, headers = {} } = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

function parseSse(text) {
  return text.trim().split("\n\n").map((block) => ({
    event: block.match(/^event: (.*)$/m)[1],
    data: JSON.parse(block.match(/^data: (.*)$/m)[1]),
  }));
}

/* ---------- static, health, headers ---------- */

test("serves the app shell, shared modules and vendored assets; blocks traversal", async () => {
  const html = await (await fetch(app.base + "/")).text();
  assert.match(html, /<title>Diagram Studio<\/title>/);
  for (const p of ["/shared/sanitize.js", "/vendor/mermaid/mermaid.esm.min.mjs", "/vendor/dompurify/purify.es.mjs", "/vendor/lucide/lucide.min.js", "/vendor/space-grotesk/wght.css", "/favicon.svg"]) {
    assert.equal((await fetch(app.base + p)).status, 200, p);
  }
  assert.equal((await fetch(app.base + "/..%2Fpackage.json")).status, 404);
  assert.equal((await fetch(app.base + "/%2e%2e/.env")).status, 404);
  assert.equal((await fetch(app.base + "/%E0%A4%A")).status, 404);
});

test("no pricing, account or usage-limit UI in the shell", async () => {
  const html = await (await fetch(app.base + "/")).text();
  assert.doesNotMatch(html, /pricing|try it free|sign ?in|log ?in|sign ?up|upgrade|subscription|credits/i);
  assert.match(html, /may contain errors/);
});

test("/healthz is a cheap liveness check", async () => {
  const res = await fetch(app.base + "/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("security headers are set on pages and API responses", async () => {
  for (const path of ["/", "/healthz", "/api/status"]) {
    const h = (await fetch(app.base + path)).headers;
    assert.match(h.get("content-security-policy"), /default-src 'self'/);
    assert.match(h.get("content-security-policy"), /script-src 'self';/);
    assert.match(h.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(h.get("x-content-type-options"), "nosniff");
    assert.equal(h.get("referrer-policy"), "no-referrer");
    assert.equal(h.get("x-frame-options"), "DENY");
  }
});

test("/api/status reports provider and model, never secrets", async () => {
  const s = await (await fetch(app.base + "/api/status")).json();
  assert.deepEqual(s, { provider: "ollama", model: "qwen2.5-coder:7b", allowUserKeys: false, ok: true });
});

/* ---------- input validation ---------- */

test("rejects non-JSON, malformed JSON, non-objects and missing fields", async () => {
  const text = await fetch(app.base + "/api/analyze", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
  assert.equal(text.status, 415);
  assert.equal((await post("/api/analyze", "{bad")).status, 400);
  assert.equal((await post("/api/analyze", "[1,2]")).status, 400);
  const missing = await post("/api/analyze", {});
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: '"prompt" is required.' });
  assert.equal((await post("/api/analyze", { prompt: 42 })).status, 400);
});

test("enforces prompt length and body size limits", async () => {
  const long = await post("/api/analyze", { prompt: "x".repeat(2001) });
  assert.equal(long.status, 413);
  assert.match((await long.json()).error, /too long/);
  const huge = await post("/api/edit", { code: "flowchart TD\n" + "a-->b\n".repeat(20_000), instruction: "x" });
  assert.equal(huge.status, 413);
});

test("unknown API routes and methods get JSON errors", async () => {
  assert.equal((await fetch(app.base + "/api/nope")).status, 404);
  assert.equal((await fetch(app.base + "/", { method: "DELETE" })).status, 405);
});

/* ---------- endpoints ---------- */

test("/api/analyze asks for JSON and returns the strict shape", async () => {
  reply = 'Sure: {"needsClarification": false, "diagramType": "sequence", "questions": []}';
  const res = await post("/api/analyze", { prompt: "token refresh between app and server" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { needsClarification: false, diagramType: "sequence", questions: [] });
  assert.equal(calls.at(-1).opts.json, true);
});

test("/api/analyze falls back instead of crashing on non-JSON", async () => {
  reply = "I think this is a flowchart!";
  assert.deepEqual(await (await post("/api/analyze", { prompt: "login flow" })).json(), { needsClarification: false, diagramType: "flowchart", questions: [] });
});

test("/api/generate streams sanitized code over SSE and ends with done", async () => {
  reply = ["Here is ", "the diagram:\n```mermaid\nflowchart TD\n", "  A[Login (SSO)] --> B\n", "```\nHope it helps!"];
  const res = await post("/api/generate", { prompt: "login", diagramType: "flowchart" });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const events = parseSse(await res.text());
  assert.ok(events.some((e) => e.event === "code"));
  for (const e of events) assert.doesNotMatch(e.data.code ?? "", /```|Here is|Hope/);
  assert.deepEqual(events.at(-1), { event: "done", data: { code: 'flowchart TD\n  A["Login (SSO)"] --> B' } });
  const [system, , example, user] = calls.at(-1).messages;
  assert.match(system.content, /Never use end as a node ID/);
  assert.match(example.content, /^flowchart TD/);
  assert.equal(user.content, "login");
});

test("/api/generate uses the few-shot for the requested type and includes answers", async () => {
  reply = "erDiagram\n  A ||--o{ B : has";
  await (await post("/api/generate", { prompt: "shop", diagramType: "er", answers: [{ question: "Payments?", answer: "Yes" }, { bogus: true }] })).text();
  const msgs = calls.at(-1).messages;
  assert.match(msgs[2].content, /^erDiagram/);
  assert.match(msgs[3].content, /Payments\? Yes/);
});

test("/api/generate reports a friendly error when the model returns no diagram", async () => {
  reply = "Sorry, I can't help with that.";
  const events = parseSse(await (await post("/api/generate", { prompt: "x" })).text());
  assert.equal(events.at(-1).event, "error");
});

test("/api/generate surfaces provider hints (e.g. ollama pull)", async () => {
  reply = new LlmError('Model "m" was not found in Ollama.', { hint: "Run:  ollama pull m", status: 503 });
  const events = parseSse(await (await post("/api/generate", { prompt: "x" })).text());
  assert.deepEqual(events.at(-1), { event: "error", data: { error: 'Model "m" was not found in Ollama.', hint: "Run:  ollama pull m" } });
});

test("unexpected errors never leak messages or stack traces", async () => {
  reply = new Error("secret internal detail at /srv/app.js:12");
  const events = parseSse(await (await post("/api/generate", { prompt: "x" })).text());
  assert.deepEqual(events.at(-1), { event: "error", data: { error: "Something went wrong on the server." } });
  const res = await post("/api/repair", { code: "flowchart TD", error: "e" });
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /secret|stack|\.js:/);
});

test("/api/edit returns the complete diagram, and restores a missing header", async () => {
  reply = "  A --> B\n  B --> C";
  const events = parseSse(await (await post("/api/edit", { code: "flowchart LR\n  A --> B", instruction: "add C" })).text());
  assert.deepEqual(events.at(-1), { event: "done", data: { code: "flowchart LR\n  A --> B\n  B --> C" } });
  assert.match(calls.at(-1).messages.at(-1).content, /Current diagram:\nflowchart LR\n {2}A --> B\n\nChange: add C/);
});

test("/api/repair numbers the lines, points at the suspect lines, returns sanitized code", async () => {
  reply = "```mermaid\nflowchart TD\n  qa --> ship\n```";
  const body = await (await post("/api/repair", { code: "flowchart TD\n  qa{{Q --> ship\n  a --> b", error: "Parse error on line 3:\n..." })).json();
  assert.deepEqual(body, { code: "flowchart TD\n  qa --> ship" });
  const last = calls.at(-1).messages.at(-1).content;
  assert.match(last, /^Code:\n1: flowchart TD\n2: {3}qa\{\{Q --> ship\n3: {3}a --> b/);
  assert.match(last, /Look closely at these lines:\n2: {3}qa\{\{Q --> ship\n3: {3}a --> b/);
});

test("/api/suggest returns exactly 3 suggestions, or [] on garbage", async () => {
  reply = '{"suggestions":[{"label":"Add retries","instruction":"Add a retry loop."}]}';
  const ok = await (await post("/api/suggest", { code: "flowchart TD\n  A-->B" })).json();
  assert.equal(ok.suggestions.length, 3);
  assert.equal(calls.at(-1).opts.json, true);
  reply = "no json here";
  assert.deepEqual(await (await post("/api/suggest", { code: "flowchart TD\n  A-->B" })).json(), { suggestions: [] });
});

/* ---------- rate limiting, bring-your-own-key ---------- */

test("rate limits POSTs per IP with 429 and Retry-After", async () => {
  const limited = await startApp({ RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" });
  try {
    reply = '{"needsClarification": false}';
    assert.equal((await post("/api/analyze", { prompt: "a" }, { base: limited.base })).status, 200);
    assert.equal((await post("/api/analyze", { prompt: "a" }, { base: limited.base })).status, 200);
    const third = await post("/api/analyze", { prompt: "a" }, { base: limited.base });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("retry-after"), "60");
    // Page loads and health checks are not limited.
    assert.equal((await fetch(limited.base + "/")).status, 200);
    assert.equal((await fetch(limited.base + "/healthz")).status, 200);
  } finally { limited.server.close(); }
});

test("user API keys are rejected unless enabled", async () => {
  const res = await post("/api/analyze", { prompt: "a" }, { headers: { "x-user-api-key": "user-key-123" } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not accept user API keys/);
});

test("with ALLOW_USER_KEYS on an openai server, a user key is used for that request only", async () => {
  const byok = await startApp({ PROVIDER: "openai", ALLOW_USER_KEYS: "true" });
  try {
    assert.equal((await (await fetch(byok.base + "/api/status")).json()).allowUserKeys, true);
    reply = '{"needsClarification": false}';
    await post("/api/analyze", { prompt: "a" }, { base: byok.base, headers: { "x-user-api-key": "user-key-123" } });
    assert.equal(calls.at(-1).tag, "user");
    assert.equal(userKeys.at(-1), "user-key-123");
    await post("/api/analyze", { prompt: "a" }, { base: byok.base });
    assert.equal(calls.at(-1).tag, "server");
    const bad = await post("/api/analyze", { prompt: "a" }, { base: byok.base, headers: { "x-user-api-key": "has space" } });
    assert.equal(bad.status, 400);
  } finally { byok.server.close(); }
});
