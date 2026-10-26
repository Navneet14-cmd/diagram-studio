import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeAnalysis, normalizeSuggestions } from "../server/json.mjs";

test("extractJson parses plain, fenced and prose-wrapped JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a": {"b": "}"}}\n```'), { a: { b: "}" } });
  assert.deepEqual(extractJson('junk {not json} then {"ok":true}'), { ok: true });
  assert.deepEqual(extractJson('{"s":"escaped \\" quote {"}'), { s: 'escaped " quote {' });
  assert.equal(extractJson("no braces"), null);
  assert.equal(extractJson("{ broken"), null);
  assert.equal(extractJson(undefined), null);
});

test("analysis falls back to no clarification on garbage", () => {
  assert.deepEqual(normalizeAnalysis(null, "login flow"), { needsClarification: false, diagramType: "flowchart", questions: [] });
  assert.deepEqual(normalizeAnalysis("text", "login flow"), { needsClarification: false, diagramType: "flowchart", questions: [] });
});

test("analysis ignores clarification requests for detailed prompts", () => {
  const raw = { needsClarification: true, diagramType: "flowchart", questions: [{ question: "Which?", options: ["a", "b"] }] };
  const r = normalizeAnalysis(raw, "user signs up, verifies email, then lands on the dashboard");
  assert.equal(r.needsClarification, false);
  assert.deepEqual(r.questions, []);
});

test("analysis keeps up to 3 well-formed questions for short vague prompts", () => {
  const raw = {
    needsClarification: true,
    questions: [
      { question: "What kind of app?", options: ["Web", "Mobile", 3, ""] },
      { question: "Anything else?" },
      { question: "" }, { question: "Q4", options: [] }, { question: "Q5" },
    ],
  };
  const r = normalizeAnalysis(raw, "my app");
  assert.equal(r.needsClarification, true);
  assert.deepEqual(r.questions, [
    { id: "q1", text: "What kind of app?", options: ["Web", "Mobile"] },
    { id: "q2", text: "Anything else?", options: [] },
    { id: "q3", text: "Q4", options: [] },
  ]);
});

test("keywords in the prompt pick the diagram type over the model", () => {
  assert.equal(normalizeAnalysis({ diagramType: "flowchart" }, "sequence diagram for payments").diagramType, "sequence");
  assert.equal(normalizeAnalysis({}, "ER diagram for a shop").diagramType, "er");
  assert.equal(normalizeAnalysis({}, "microservice architecture").diagramType, "architecture");
  assert.equal(normalizeAnalysis({ diagramType: "sequence" }, "do things").diagramType, "sequence");
  assert.equal(normalizeAnalysis({ diagramType: "nonsense" }, "do things").diagramType, "flowchart");
});

test("suggestions are exactly 3, padded or trimmed, or empty on garbage", () => {
  assert.deepEqual(normalizeSuggestions(null), []);
  assert.deepEqual(normalizeSuggestions({ suggestions: "nope" }), []);
  const one = normalizeSuggestions({ suggestions: [{ label: "Add cache", instruction: "Add a cache in front of the database." }] });
  assert.equal(one.length, 3);
  assert.deepEqual(one[0], { label: "Add cache", instruction: "Add a cache in front of the database." });
  const many = normalizeSuggestions({ suggestions: Array.from({ length: 5 }, (_, i) => ({ label: `S${i}`, instruction: `I${i}` })) });
  assert.deepEqual(many.map((e) => e.label), ["S0", "S1", "S2"]);
});

test("suggestions that echo the prompt's placeholder text are discarded", () => {
  const echoed = { suggestions: [1, 2, 3].map(() => ({ label: "2-4 word label", instruction: "one sentence" })) };
  assert.deepEqual(normalizeSuggestions(echoed), []);
});
