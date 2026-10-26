// Deterministic clean-up of LLM output before it reaches mermaid.parse.
// Runs unchanged in the browser and in Node (no imports, no DOM).

export const DIAGRAM_KEYWORDS = [
  "flowchart", "graph", "sequenceDiagram", "erDiagram", "classDiagram", "stateDiagram-v2", "stateDiagram",
];

const KEYWORD_LINE = new RegExp(`^\\s*(${DIAGRAM_KEYWORDS.map((k) => k.replace("-", "\\-")).join("|")})\\b`);

// Flowchart node shapes, longest opener first. Value = closing delimiter.
const SHAPES = [
  ["((", "))"], ["([", "])"], ["[[", "]]"], ["[(", ")]"], ["{{", "}}"],
  ["[", "]"], ["(", ")"], ["{", "}"], [">", "]"],
];
const RISKY_LABEL = /[()[\]{}:;]/;
const FLOW_SKIP = /^\s*(subgraph\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|%%|end\s*$)/;

/** Pull the code out of a ``` fence if there is one (an unclosed fence is fine while streaming). */
export function stripFences(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const open = src.match(/```[^\n]*\n/);
  if (!open) return src.replace(/^\s*```.*$/gm, "");
  const body = src.slice(open.index + open[0].length);
  const close = body.indexOf("```");
  return close === -1 ? body : body.slice(0, close);
}

/** Drop everything before the first diagram keyword, and anything from a second diagram onwards. */
export function trimToDiagram(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => KEYWORD_LINE.test(l));
  if (start === -1) return text.trim();
  const rest = lines.slice(start + 1);
  const second = rest.findIndex((l) => KEYWORD_LINE.test(l));
  const kept = [lines[start].trim(), ...(second === -1 ? rest : rest.slice(0, second))];
  return dropTrailingProse(kept).join("\n").trim();
}

// "This diagram shows the login flow." after the code: words, sentence punctuation, no diagram syntax.
function dropTrailingProse(lines) {
  const out = [...lines];
  while (out.length > 1) {
    const l = out[out.length - 1].trim();
    const prose = l === "" || (/^[A-Z][\w'’,]*(\s+\S+){3,}[.!?]$/.test(l) && !/--|->|[[\]{}()|:]/.test(l));
    if (!prose) break;
    out.pop();
  }
  return out;
}

export function diagramKind(code) {
  const first = String(code ?? "").trim().split("\n")[0] ?? "";
  const m = first.match(KEYWORD_LINE);
  return m ? m[1] : null;
}

/** Index just past the delimiter that closes `open` at `from`, counting nesting of the opener's bracket. */
function findClose(line, from, open, close) {
  const o = open[open.length - 1], c = close[0];
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { const q = line.indexOf('"', i + 1); if (q !== -1) { i = q; continue; } }
    if (o !== c && ch === o) depth++;
    else if (line.startsWith(close, i)) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return line.lastIndexOf(close) >= from ? line.lastIndexOf(close) : -1;
}

function quoteLabel(label) {
  const t = label.trim();
  if (/^".*"$/s.test(t)) return t;
  if (!RISKY_LABEL.test(t)) return label;
  return `"${t.replace(/"/g, "#quot;")}"`;
}

/**
 * Rewrite one flowchart line: quote risky node and edge labels, rename a bare `end` node ID.
 * Labels are copied through untouched apart from quoting, so `end` inside text is never renamed.
 */
function fixFlowLine(line) {
  if (FLOW_SKIP.test(line)) return line;
  let out = "";
  let code = "";
  const flushCode = () => { out += code.replace(/(^|[^\w-])end(?![\w-])/g, "$1end_"); code = ""; };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      const q = line.indexOf('"', i + 1);
      const j = q === -1 ? line.length : q + 1;
      flushCode(); out += line.slice(i, j); i = j; continue;
    }
    if (ch === "|") {
      const q = line.indexOf("|", i + 1);
      if (q !== -1) { flushCode(); out += `|${quoteLabel(line.slice(i + 1, q))}|`; i = q + 1; continue; }
    }
    // A shape opener directly after an identifier character (A[...], end(...), db[(...)]).
    const prev = code.match(/[\w-]$/) && !/-$/.test(code) ? code : null;
    const shape = prev !== null ? SHAPES.find(([o]) => line.startsWith(o, i)) : null;
    if (shape) {
      const [open, close] = shape;
      const at = findClose(line, i + open.length, open, close);
      if (at !== -1) {
        flushCode();
        out += open + quoteLabel(line.slice(i + open.length, at)) + close;
        i = at + close.length;
        continue;
      }
      // Unclosed shape (`qa{{Quality gate --> ship`): the label ends at the next edge, so close it there.
      const rest = line.slice(i + open.length);
      const edge = rest.search(/\s+(--|==|-\.|~~~)/);
      const label = (edge === -1 ? rest : rest.slice(0, edge)).trim();
      if (label) {
        flushCode();
        out += `${open}"${label.replace(/"/g, "#quot;")}"${close}`;
        i += open.length + (edge === -1 ? rest.length : edge);
        continue;
      }
    }
    code += ch; i++;
  }
  flushCode();
  return out;
}

// Models asked to fix numbered code sometimes copy the numbers back ("3: A --> B").
function stripLineNumbers(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2 || !lines.every((l) => /^\s*\d+: /.test(l))) return text;
  return text.replace(/^\s*\d+: ?/gm, "");
}

/** Full pipeline: fences → line numbers → trim prose → flowchart fixes. Safe to call on partial (streaming) text. */
export function sanitizeMermaid(text) {
  let code = trimToDiagram(stripLineNumbers(stripFences(text)));
  const kind = diagramKind(code);
  if (kind === "flowchart" || kind === "graph") {
    code = code.split("\n").map((l, idx) => (idx === 0 ? l : fixFlowLine(l))).join("\n");
  }
  return code;
}

/** While streaming, the last line is usually half-written; parse only complete lines. */
export function completeLines(text) {
  const i = text.lastIndexOf("\n");
  return i === -1 ? text : text.slice(0, i);
}
