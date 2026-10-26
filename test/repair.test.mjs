import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWithRepair } from "../shared/repair.js";

// Stand-in parser: treats any line containing BROKEN as a syntax error.
const parse = async (code) => {
  const line = code.split("\n").findIndex((l) => l.includes("BROKEN"));
  if (line !== -1) throw new Error(`Parse error on line ${line + 1}: unexpected BROKEN`);
};

test("valid code passes without calling repair", async () => {
  let calls = 0;
  const r = await validateWithRepair("flowchart TD\n  A --> B", { parse, repair: async () => { calls++; return ""; } });
  assert.deepEqual(r, { ok: true, code: "flowchart TD\n  A --> B", repairs: 0 });
  assert.equal(calls, 0);
});

test("sanitizes before parsing (fences never reach the parser)", async () => {
  const r = await validateWithRepair("```mermaid\nflowchart TD\n  A --> B\n```", { parse, repair: async () => "" });
  assert.equal(r.ok, true);
  assert.equal(r.code, "flowchart TD\n  A --> B");
});

test("repairs once, sending the broken code and the parser error", async () => {
  const seen = [];
  const progress = [];
  const r = await validateWithRepair("flowchart TD\n  A --> BROKEN", {
    parse,
    repair: async (code, error) => { seen.push({ code, error }); return "```\nflowchart TD\n  A --> B\n```"; },
    onRepair: (p) => progress.push(p),
  });
  assert.equal(r.ok, true);
  assert.equal(r.repairs, 1);
  assert.equal(r.code, "flowchart TD\n  A --> B");
  assert.equal(seen[0].code, "flowchart TD\n  A --> BROKEN");
  assert.match(seen[0].error, /line 2/);
  assert.deepEqual(progress.map((p) => [p.attempt, p.maxAttempts]), [[1, 2]]);
});

test("succeeds on the second repair attempt", async () => {
  const outputs = ["flowchart TD\n  A --> BROKEN again", "flowchart TD\n  A --> C"];
  const r = await validateWithRepair("flowchart TD\n  BROKEN", { parse, repair: async () => outputs.shift() });
  assert.equal(r.ok, true);
  assert.equal(r.repairs, 2);
  assert.equal(r.code, "flowchart TD\n  A --> C");
});

test("gives up after 2 attempts and reports the last error", async () => {
  let calls = 0;
  const r = await validateWithRepair("flowchart TD\n  BROKEN", {
    parse,
    repair: async () => { calls++; return "flowchart TD\n  still BROKEN"; },
  });
  assert.equal(calls, 2);
  assert.equal(r.ok, false);
  assert.equal(r.repairs, 2);
  assert.match(r.error, /unexpected BROKEN/);
});

test("a failing repair request ends the loop with a clear error instead of throwing", async () => {
  const r = await validateWithRepair("flowchart TD\n  BROKEN", { parse, repair: async () => { throw new Error("Ollama down"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Repair request failed: Ollama down/);
});

test("an empty repair response keeps the previous code", async () => {
  const r = await validateWithRepair("flowchart TD\n  BROKEN", { parse, repair: async () => "  ", maxAttempts: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "flowchart TD\n  BROKEN");
});
