// Mermaid wrapper: themed rendering, DOMPurify on every SVG, and a serialized queue that always keeps the
// last valid diagram on screen while partial (streaming) code fails to parse.
import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const THEMES = {
  light: {
    background: "#ffffff", primaryColor: "#ffffff", primaryBorderColor: "#0b6e64", primaryTextColor: "#15202b",
    secondaryColor: "#eef1f4", tertiaryColor: "#f6f8fa", lineColor: "#53616e", textColor: "#15202b",
    clusterBkg: "#f1f7f6", clusterBorder: "#9fcfc6", edgeLabelBackground: "#ffffff",
    noteBkgColor: "#fff1d6", noteBorderColor: "#e0b45c", noteTextColor: "#15202b",
    actorBkg: "#dcf1ec", actorBorder: "#0b6e64", actorTextColor: "#15202b", signalColor: "#33414d", signalTextColor: "#15202b",
    labelBoxBkgColor: "#dcf1ec", labelBoxBorderColor: "#0b6e64", labelTextColor: "#15202b", loopTextColor: "#15202b",
    activationBkgColor: "#eef1f4", activationBorderColor: "#53616e",
    attributeBackgroundColorOdd: "#ffffff", attributeBackgroundColorEven: "#f3f5f7", rowOdd: "#ffffff", rowEven: "#f3f5f7",
  },
  dark: {
    background: "#151d24", primaryColor: "#1b252e", primaryBorderColor: "#4fd1bd", primaryTextColor: "#e7eef3",
    secondaryColor: "#24313c", tertiaryColor: "#1b252e", lineColor: "#a2b0bc", textColor: "#e7eef3",
    clusterBkg: "#16302c", clusterBorder: "#2f6e64", edgeLabelBackground: "#151d24",
    noteBkgColor: "#3a2c12", noteBorderColor: "#a07a2f", noteTextColor: "#f3e7cf",
    actorBkg: "#143b36", actorBorder: "#4fd1bd", actorTextColor: "#e7eef3", signalColor: "#c3cdd6", signalTextColor: "#e7eef3",
    labelBoxBkgColor: "#143b36", labelBoxBorderColor: "#4fd1bd", labelTextColor: "#e7eef3", loopTextColor: "#e7eef3",
    activationBkgColor: "#24313c", activationBorderColor: "#a2b0bc",
    attributeBackgroundColorOdd: "#1b252e", attributeBackgroundColorEven: "#202c36", rowOdd: "#1b252e", rowEven: "#202c36",
  },
};

function configure(theme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    darkMode: theme === "dark",
    // Plain SVG <text> labels (no <foreignObject>) so PNG export doesn't taint the canvas.
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: "basis", padding: 14, nodeSpacing: 46, rankSpacing: 56 },
    sequence: { mirrorActors: false, actorMargin: 60 },
    fontFamily: FONT,
    themeVariables: { fontFamily: FONT, fontSize: "15px", ...THEMES[theme] },
  });
}

let currentTheme = "light";
configure(currentTheme);

// Mermaid keeps global state; run every parse/render through one queue.
let lock = Promise.resolve();
function exclusive(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** Throws mermaid's parse error (message includes line info) if the code is invalid. */
export const parseStrict = (code) => exclusive(() => mermaid.parse(code));

let seq = 0;
async function renderRaw(code, theme) {
  const id = `ds-diagram-${++seq}`;
  if (theme !== currentTheme) configure(theme);
  try {
    const { svg } = await mermaid.render(id, code);
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"] });
  } finally {
    if (theme !== currentTheme) configure(currentTheme);
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Render to sanitized SVG markup in the given theme (used by export too). */
export const renderSvg = (code, theme = currentTheme) => exclusive(() => renderRaw(code, theme));

export function setRenderTheme(theme) {
  return exclusive(() => { currentTheme = theme; configure(theme); });
}

/**
 * Coalescing renderer: show(code) may be called on every stream chunk; only the newest pending code is rendered.
 * Invalid code is skipped silently so the previous diagram stays visible.
 */
export function createRenderer(onSvg) {
  let running = null;
  let pending = null;
  let lastGood = "";

  async function pump() {
    await null; // let show() store `running` before this can reset it
    while (pending !== null) {
      const code = pending;
      pending = null;
      if (code === lastGood) continue;
      try {
        const ok = await exclusive(() => mermaid.parse(code, { suppressErrors: true }));
        if (ok === false) continue;
        const svg = await renderSvg(code);
        lastGood = code;
        onSvg(svg, code);
      } catch { /* keep last valid render */ }
    }
    running = null; // same tick as the loop check, so a show() arriving now starts a fresh pump
  }

  return {
    /** Queue code for rendering; the promise settles once the queue (including this code) is drained. */
    show(code) {
      pending = code;
      running ??= pump();
      return running;
    },
    /** Re-render the current diagram (after a theme change). */
    refresh() {
      const code = lastGood;
      lastGood = "";
      return code ? this.show(code) : Promise.resolve();
    },
    get lastGood() { return lastGood; },
  };
}
