// Defensive JSON handling for small models: they wrap JSON in prose, fences, or emit it twice.
import { DIAGRAM_TYPES, guessDiagramType } from "./prompts.mjs";

/** First balanced {...} block in the text, parsed; null if none parses. */
export function extractJson(text) {
  const src = String(text ?? "");
  try { return JSON.parse(src); } catch { /* fall through */ }
  for (let start = src.indexOf("{"); start !== -1; start = src.indexOf("{", start + 1)) {
    let depth = 0, inStr = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

const shortText = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * → { needsClarification, diagramType, questions: [{ id, text, options: string[] }] }
 * An empty `options` list means "free text answer".
 */
export function normalizeAnalysis(raw, prompt) {
  const guessed = guessDiagramType(prompt);
  const modelType = DIAGRAM_TYPES.includes(raw?.diagramType) ? raw.diagramType : null;
  const diagramType = guessed ?? modelType ?? "flowchart";
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .map((q) => {
      const text = shortText(q?.question ?? q?.text, 200);
      const options = (Array.isArray(q?.options) ? q.options : [])
        .map((o) => shortText(typeof o === "string" ? o : o?.text, 60))
        .filter(Boolean)
        .slice(0, 4);
      return text && { text, options };
    })
    .filter(Boolean)
    .slice(0, 3)
    .map((q, i) => ({ id: `q${i + 1}`, ...q }));
  // Small models over-ask. Only honour a clarification request for genuinely short prompts.
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  const needsClarification = raw?.needsClarification === true && questions.length > 0 && words < 6;
  return { needsClarification, diagramType, questions: needsClarification ? questions : [] };
}

const FALLBACK_SUGGESTIONS = [
  { label: "Add error paths", instruction: "Add error or failure paths where a step can fail." },
  { label: "Clearer labels", instruction: "Make every node label short and descriptive." },
  { label: "Group related steps", instruction: "Group related nodes into labeled subgraphs." },
];

// Text a small model copies from the prompt instead of writing its own.
const ECHOED = /word label|^\.\.\.$|one sentence|button label|Add rate limiting|Expire reset links|Confirm by email/i;

/** → exactly 3 `{label, instruction}` items, or [] when the model's output is unusable. */
export function normalizeSuggestions(raw) {
  const list = Array.isArray(raw?.suggestions) ? raw.suggestions : Array.isArray(raw) ? raw : null;
  if (!list) return [];
  const items = list
    .map((e) => ({ label: shortText(e?.label ?? e?.title, 40), instruction: shortText(e?.instruction ?? e?.label, 240) }))
    .filter((e) => e.label && e.instruction && !ECHOED.test(e.label));
  if (!items.length) return [];
  for (const f of FALLBACK_SUGGESTIONS) if (items.length < 3 && !items.some((e) => e.label === f.label)) items.push(f);
  return items.slice(0, 3);
}
