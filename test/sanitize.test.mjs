import { test } from "node:test";
import assert from "node:assert/strict";
import { completeLines, diagramKind, sanitizeMermaid, stripFences, trimToDiagram } from "../shared/sanitize.js";

test("strips a ```mermaid fence and the prose around it", () => {
  const raw = "Sure! Here is your diagram:\n```mermaid\nflowchart TD\n  A --> B\n```\nThis shows A going to B.";
  assert.equal(sanitizeMermaid(raw), "flowchart TD\n  A --> B");
});

test("handles an unclosed fence while streaming", () => {
  assert.equal(stripFences("```mermaid\nsequenceDiagram\n  A->>B: hi\n"), "sequenceDiagram\n  A->>B: hi\n");
});

test("removes stray fence lines without a language", () => {
  assert.equal(sanitizeMermaid("```\nerDiagram\n  A ||--o{ B : has\n```"), "erDiagram\n  A ||--o{ B : has");
});

test("drops text before the first diagram keyword", () => {
  assert.equal(trimToDiagram("Here you go\n\ngraph LR\n  a --> b"), "graph LR\n  a --> b");
  assert.equal(diagramKind(sanitizeMermaid("Okay.\nstateDiagram-v2\n  [*] --> Idle")), "stateDiagram-v2");
});

test("keeps only the first diagram when the model emits two", () => {
  const out = sanitizeMermaid("flowchart TD\n  A --> B\nsequenceDiagram\n  A->>B: x");
  assert.equal(out, "flowchart TD\n  A --> B");
});

test("drops trailing prose sentences after the code", () => {
  const out = sanitizeMermaid("flowchart TD\n  A --> B\n\nThis diagram shows the basic flow of the app.");
  assert.equal(out, "flowchart TD\n  A --> B");
});

test("auto-quotes labels containing parentheses, brackets or colons", () => {
  assert.equal(sanitizeMermaid("flowchart TD\n  A[Login (OAuth)] --> B"), 'flowchart TD\n  A["Login (OAuth)"] --> B');
  assert.equal(sanitizeMermaid("flowchart TD\n  A[Step 1: Login] --> B"), 'flowchart TD\n  A["Step 1: Login"] --> B');
  assert.equal(sanitizeMermaid("flowchart TD\n  C{Valid (y/n)?}"), 'flowchart TD\n  C{"Valid (y/n)?"}');
  assert.equal(sanitizeMermaid("flowchart TD\n  A(Check (again))"), 'flowchart TD\n  A("Check (again)")');
  assert.equal(sanitizeMermaid("flowchart TD\n  db[(Users: main)]"), 'flowchart TD\n  db[("Users: main")]');
  assert.equal(sanitizeMermaid("flowchart TD\n  A[items[0]]"), 'flowchart TD\n  A["items[0]"]');
});

test("auto-quotes risky edge labels", () => {
  assert.equal(sanitizeMermaid("flowchart TD\n  A -->|yes (ok)| B"), 'flowchart TD\n  A -->|"yes (ok)"| B');
});

test("leaves safe and already-quoted labels alone", () => {
  const code = 'flowchart LR\n  A["Already (quoted)"] --> B[Plain label]\n  B -->|no| C(Round)';
  assert.equal(sanitizeMermaid(code), code);
});

test("escapes inner double quotes when quoting", () => {
  assert.equal(sanitizeMermaid('flowchart TD\n  A[Say "hi" (now)]'), 'flowchart TD\n  A["Say #quot;hi#quot; (now)"]');
});

test("renames a node ID `end` but keeps subgraph `end` and the word in labels", () => {
  const raw = "flowchart TD\n  subgraph s[Group]\n    start --> end\n  end\n  end --> x[The end]\n  y --> end[Finish]";
  const out = sanitizeMermaid(raw);
  assert.equal(out, "flowchart TD\n  subgraph s[Group]\n    start --> end_\n  end\n  end_ --> x[The end]\n  y --> end_[Finish]");
});

test("does not rename `end` in sequence diagrams", () => {
  const code = "sequenceDiagram\n  alt ok\n    A->>B: pay\n  end";
  assert.equal(sanitizeMermaid(code), code);
});

test("leaves arrows alone (no false shape detection on -->)", () => {
  const code = "flowchart LR\n  a-->b\n  b ==> c\n  c -.-> d";
  assert.equal(sanitizeMermaid(code), code);
});

test("completeLines drops the half-written last line", () => {
  assert.equal(completeLines("flowchart TD\n  A --> B\n  B --> C[Unfin"), "flowchart TD\n  A --> B");
});

test("closes a shape left unclosed before an edge", () => {
  assert.equal(sanitizeMermaid("flowchart TD\n  qa{{Quality gate --> ship"), 'flowchart TD\n  qa{{"Quality gate"}} --> ship');
  assert.equal(sanitizeMermaid("flowchart TD\n  a[Start here"), 'flowchart TD\n  a["Start here"]');
});

test("strips line numbers a model copied back from a numbered repair prompt", () => {
  assert.equal(sanitizeMermaid("1: flowchart TD\n2:   A --> B\n3:   B --> C"), "flowchart TD\n  A --> B\n  B --> C");
  // A single numbered-looking line is left alone.
  assert.equal(sanitizeMermaid("sequenceDiagram\n  A->>B: 1: step"), "sequenceDiagram\n  A->>B: 1: step");
});
