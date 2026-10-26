import { ApiError, hasUserKey, postJson, postStream, setUserKey } from "./api.js";
import { createRenderer, parseStrict, renderSvg, setRenderTheme } from "./render.js";
import { completeLines } from "/shared/sanitize.js";
import { errorText, validateWithRepair } from "/shared/repair.js";

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries([
  "prompt", "promptForm", "generateBtn", "starters", "clarify", "questionList", "skipQuestions", "answerQuestions",
  "status", "canvas", "diagram", "empty", "skeleton", "failure", "failureMsg", "failureRetry", "failureCode",
  "zoomIn", "zoomOut", "zoomFit", "exportSvg", "exportPng",
  "tabRefine", "tabCode", "panelRefine", "panelCode", "refineEmpty", "refineBody", "changeForm", "changeInput", "chips",
  "code", "codeError", "copyCode", "fixCode",
  "modelStatus", "modelName", "healthNotice", "healthMsg", "healthHint", "healthHintWrap", "healthRetry",
  "themeBtn", "aboutBtn", "aboutLink", "aboutDialog", "settingsBtn", "settingsDialog", "settingsForm", "userKey",
].map((id) => [id, $(id)]));

const STARTERS = [
  { icon: "git-branch", text: "Support ticket triage: classify new tickets, page on-call for urgent ones, queue the rest" },
  { icon: "arrow-left-right", text: "Sequence diagram of a mobile app refreshing an expired access token" },
  { icon: "database", text: "ER diagram for a recipe app with users, recipes, ingredients and ratings" },
  { icon: "network", text: "Architecture of a video platform with uploads, transcoding workers, object storage and a CDN" },
];

const state = { busy: false, controller: null, lastRequest: null, pending: null, zoom: 1, svgSize: null, hasDiagram: false };
const icons = () => window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);

/* ---------- theme ---------- */

const media = matchMedia("(prefers-color-scheme: dark)");
const activeTheme = () => document.documentElement.dataset.theme || (media.matches ? "dark" : "light");

function syncThemeButton() {
  const next = activeTheme() === "dark" ? "light" : "dark";
  el.themeBtn.setAttribute("aria-label", `Switch to ${next} theme`);
  el.themeBtn.innerHTML = `<i data-lucide="${next === "dark" ? "moon" : "sun"}"></i>`;
  icons();
}

async function applyTheme() {
  syncThemeButton();
  await setRenderTheme(activeTheme());
  await renderer.refresh();
}

el.themeBtn.onclick = () => {
  const next = activeTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("ds-theme", next); } catch { /* private mode */ }
  applyTheme();
};
media.addEventListener("change", () => { if (!document.documentElement.dataset.theme) applyTheme(); });

/* ---------- status + view helpers ---------- */

function setStatus(kind, text) {
  el.status.className = `status ${kind ?? ""}`;
  el.status.replaceChildren();
  if (!text) return;
  if (kind === "busy" || kind === "repair") el.status.append(make("span", { className: "spinner" }));
  el.status.append(document.createTextNode(text));
}

function setBusy(busy) {
  state.busy = busy;
  el.generateBtn.disabled = busy;
  el.answerQuestions.disabled = busy;
  el.fixCode.disabled = busy;
  el.failureRetry.disabled = busy;
  el.changeForm.querySelector("button").disabled = busy;
  el.chips.querySelectorAll("button").forEach((b) => (b.disabled = busy));
  el.skeleton.hidden = !(busy && !state.hasDiagram);
  if (busy) el.empty.hidden = true;
  else if (!state.hasDiagram && el.failure.hidden) el.empty.hidden = false;
}

function showFailure(message, hint) {
  el.failureMsg.textContent = hint ? `${message} ${hint}` : message;
  el.failure.hidden = false;
  el.empty.hidden = true;
  el.skeleton.hidden = true;
  setStatus("error", "Couldn't finish the diagram");
}
const hideFailure = () => { el.failure.hidden = true; };

function unlockRefine() {
  el.refineEmpty.hidden = true;
  el.refineBody.hidden = false;
}

/* ---------- tabs (arrow-key navigable) ---------- */

const tabs = [[el.tabRefine, el.panelRefine], [el.tabCode, el.panelCode]];
function selectTab(tab, focus = false) {
  for (const [t, p] of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    p.hidden = !on;
  }
  if (focus) tab.focus();
}
for (const [t] of tabs) {
  t.onclick = () => selectTab(t);
  t.onkeydown = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = tabs.findIndex(([x]) => x === t);
    selectTab(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0], true);
  };
}

/* ---------- canvas: render, fit, zoom, pan ---------- */

const renderer = createRenderer((svg) => mountSvg(svg));

function mountSvg(markup) {
  el.diagram.innerHTML = markup;
  const svg = el.diagram.querySelector("svg");
  if (!svg) return;
  const vb = svg.viewBox?.baseVal;
  state.svgSize = vb && vb.width ? { w: vb.width, h: vb.height } : { w: 400, h: 300 };
  svg.removeAttribute("style");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Generated diagram");
  state.hasDiagram = true;
  el.starters.hidden = true;
  el.empty.hidden = true;
  el.skeleton.hidden = true;
  setCanvasTools(true);
  applyZoom();
}

function fitScale() {
  if (!state.svgSize) return 1;
  const pad = 72;
  const cw = Math.max(el.canvas.clientWidth - pad, 120);
  const ch = Math.max(el.canvas.clientHeight - pad, 120);
  const fit = Math.min(cw / state.svgSize.w, ch / state.svgSize.h, 1.6);
  // Tall diagrams: fit the width and scroll rather than shrinking text below a readable size.
  const s = Math.max(fit, Math.min(0.85, cw / state.svgSize.w));
  // Narrow screens: keep text legible and let the user scroll sideways instead.
  return cw < 600 ? Math.max(s, 0.75) : s;
}

function applyZoom() {
  const svg = el.diagram.querySelector("svg");
  if (!svg || !state.svgSize) return;
  const s = fitScale() * state.zoom;
  svg.setAttribute("width", Math.round(state.svgSize.w * s));
  svg.setAttribute("height", Math.round(state.svgSize.h * s));
}

function setCanvasTools(enabled) {
  for (const b of [el.zoomIn, el.zoomOut, el.zoomFit, el.exportSvg, el.exportPng]) b.disabled = !enabled;
}
setCanvasTools(false);

el.zoomIn.onclick = () => { state.zoom = Math.min(state.zoom * 1.25, 6); applyZoom(); };
el.zoomOut.onclick = () => { state.zoom = Math.max(state.zoom / 1.25, 0.2); applyZoom(); };
el.zoomFit.onclick = () => { state.zoom = 1; applyZoom(); el.canvas.scrollTo(0, 0); };
new ResizeObserver(() => applyZoom()).observe(el.canvas);

el.canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.pointerType === "touch" || e.target.closest("button")) return;
  const start = { x: e.clientX, y: e.clientY, l: el.canvas.scrollLeft, t: el.canvas.scrollTop };
  el.canvas.classList.add("dragging");
  const move = (ev) => el.canvas.scrollTo(start.l - (ev.clientX - start.x), start.t - (ev.clientY - start.y));
  const up = () => { el.canvas.classList.remove("dragging"); removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
});
el.canvas.addEventListener("keydown", (e) => {
  const step = 60;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) { e.preventDefault(); el.canvas.scrollBy(...moves[e.key]); }
  else if (e.key === "+" || e.key === "=") el.zoomIn.click();
  else if (e.key === "-") el.zoomOut.click();
  else if (e.key === "0") el.zoomFit.click();
});

/* ---------- generate / edit pipeline ---------- */

function newController() {
  state.controller?.abort();
  state.controller = new AbortController();
  return state.controller.signal;
}

/** Validate final code; ask the model to repair it up to 2 times with a visible progress state. */
async function finalize(code, signal) {
  const result = await validateWithRepair(code, {
    parse: parseStrict,
    repair: async (c, error) => (await postJson("/api/repair", { code: c, error }, signal)).code,
    onRepair: ({ attempt, maxAttempts }) => {
      setStatus("repair", `Fixing syntax… (attempt ${attempt} of ${maxAttempts})`);
      el.diagram.classList.add("stale");
    },
  });
  el.diagram.classList.remove("stale");
  el.code.value = result.code;
  if (!result.ok) {
    setCodeError(result.error);
    showFailure("The model's diagram still had a syntax error after two automatic fixes.", "Try rewording the request, or open the code to fix it by hand.");
    return false;
  }
  setCodeError(null);
  await renderer.show(result.code);
  if (renderer.lastGood !== result.code) {
    showFailure("The diagram parsed but could not be laid out.", "Try rewording the request.");
    return false;
  }
  setStatus("done", result.repairs ? "Done · a syntax error was fixed automatically" : "Done");
  return true;
}

/** Shared runner for /api/generate and /api/edit: streams code, renders live, validates/repairs, then suggests. */
async function runStream(path, body, label) {
  const signal = newController();
  state.lastRequest = { path, body, label };
  hideFailure();
  setBusy(true);
  unlockRefine();
  setStatus("busy", label);
  el.chips.replaceChildren(make("p", { className: "chips-note", textContent: "Suggestions appear once the diagram is ready." }));
  try {
    const done = await postStream(path, body, {
      signal,
      onEvent: (event, data) => {
        if (event !== "code") return;
        el.code.value = data.code;
        renderer.show(completeLines(data.code));
      },
    });
    setStatus("busy", "Checking syntax…");
    if (await finalize(done.code, signal)) loadSuggestions(done.code, signal);
  } catch (err) {
    if (err.name === "AbortError") return;
    showFailure(err.message, err instanceof ApiError ? err.hint ?? "" : "");
  } finally {
    if (!signal.aborted) setBusy(false);
  }
}

async function generate(prompt, analysis, answers = []) {
  el.clarify.hidden = true;
  await runStream("/api/generate", { prompt, diagramType: analysis?.diagramType, answers }, "Drawing your diagram…");
}

async function submitPrompt() {
  const prompt = el.prompt.value.trim();
  if (!prompt) { el.prompt.focus(); return; }
  if (state.busy) return;
  const signal = newController();
  hideFailure();
  el.clarify.hidden = true;
  setBusy(true);
  setStatus("busy", "Reading your request…");
  let analysis;
  try {
    analysis = await postJson("/api/analyze", { prompt }, signal);
  } catch (err) {
    if (err.name === "AbortError") return;
    setBusy(false);
    state.lastRequest = { path: "/api/generate", body: { prompt }, label: "Drawing your diagram…" };
    showFailure(err.message, err.hint ?? "");
    return;
  }
  setBusy(false);
  if (analysis.needsClarification && analysis.questions?.length) {
    state.pending = { prompt, analysis };
    showQuestions(analysis.questions);
    setStatus("", "");
    return;
  }
  await generate(prompt, analysis);
}

async function requestEdit(instruction) {
  const code = el.code.value.trim();
  if (!instruction || !code || state.busy) return;
  el.changeInput.value = "";
  await runStream("/api/edit", { code, instruction }, "Applying your change…");
}

async function loadSuggestions(code, signal) {
  el.chips.replaceChildren(...[0, 1, 2].map(() => make("div", { className: "chip-skeleton" })));
  try {
    const { suggestions } = await postJson("/api/suggest", { code }, signal);
    if (!suggestions.length) {
      el.chips.replaceChildren(make("p", { className: "chips-note", textContent: "No suggestions this time. Describe a change above." }));
      return;
    }
    el.chips.replaceChildren(...suggestions.map((s) => {
      const b = make("button", { type: "button", className: "chip" });
      b.innerHTML = '<i data-lucide="sparkle"></i><span><strong></strong><small></small></span>';
      b.querySelector("strong").textContent = s.label;
      b.querySelector("small").textContent = s.instruction;
      b.onclick = () => requestEdit(s.instruction);
      return b;
    }));
    icons();
  } catch (err) {
    if (err.name !== "AbortError") el.chips.replaceChildren(make("p", { className: "chips-note", textContent: "Suggestions are unavailable right now." }));
  }
}

/* ---------- clarifying questions ---------- */

function showQuestions(questions) {
  el.questionList.replaceChildren(...questions.map((q) => {
    const wrap = make("div", { className: "question" });
    wrap.dataset.question = q.text;
    const label = make("p", { textContent: q.text, id: `${q.id}-label` });
    wrap.append(label);
    if (q.options.length) {
      const opts = make("div", { className: "options" });
      opts.setAttribute("role", "group");
      opts.setAttribute("aria-labelledby", label.id);
      for (const text of q.options) {
        const b = make("button", { type: "button", className: "option", textContent: text });
        b.setAttribute("aria-pressed", "false");
        b.onclick = () => {
          const on = b.getAttribute("aria-pressed") !== "true";
          opts.querySelectorAll(".option").forEach((o) => o.setAttribute("aria-pressed", String(o === b && on)));
        };
        opts.append(b);
      }
      wrap.append(opts);
    }
    const free = make("input", { className: "free", placeholder: q.options.length ? "Or type your own answer" : "Your answer" });
    free.setAttribute("aria-labelledby", label.id);
    wrap.append(free);
    return wrap;
  }));
  el.clarify.hidden = false;
  el.questionList.querySelector("button, input")?.focus();
}

function collectAnswers() {
  return [...el.questionList.querySelectorAll(".question")].map((w) => ({
    question: w.dataset.question,
    answer: w.querySelector(".free").value.trim() || w.querySelector('.option[aria-pressed="true"]')?.textContent || "",
  })).filter((a) => a.answer);
}

el.answerQuestions.onclick = () => { const p = state.pending; if (p) generate(p.prompt, p.analysis, collectAnswers()); };
el.skipQuestions.onclick = () => { const p = state.pending; if (p) generate(p.prompt, p.analysis); };

/* ---------- code pane: live re-render on manual edits ---------- */

function setCodeError(message) {
  el.codeError.hidden = !message;
  if (message) el.codeError.querySelector("pre").textContent = message;
}

let editTimer;
el.code.addEventListener("input", () => {
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    const code = el.code.value.trim();
    if (!code) return;
    try {
      await parseStrict(code);
      setCodeError(null);
      hideFailure();
      unlockRefine();
      await renderer.show(code);
      setStatus("", "");
    } catch (err) {
      setCodeError(errorText(err));
    }
  }, 350);
});

el.fixCode.onclick = async () => {
  if (state.busy) return;
  const signal = newController();
  setBusy(true);
  hideFailure();
  try {
    if (await finalize(el.code.value, signal)) loadSuggestions(el.code.value, signal);
  } catch (err) {
    if (err.name !== "AbortError") showFailure(err.message, err.hint ?? "");
  } finally {
    if (!signal.aborted) setBusy(false);
  }
};

el.copyCode.onclick = async () => {
  const label = el.copyCode.querySelector("span");
  try {
    await navigator.clipboard.writeText(el.code.value);
    label.textContent = "Copied";
  } catch {
    el.code.select();
    label.textContent = "Press ⌘/Ctrl+C";
  }
  setTimeout(() => (label.textContent = "Copy"), 1500);
};

/* ---------- export (always light theme, white background) ---------- */

function download(blob, name) {
  const a = make("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportMarkup() {
  const code = renderer.lastGood;
  if (!code) return null;
  const doc = new DOMParser().parseFromString(await renderSvg(code, "light"), "image/svg+xml");
  const svg = doc.documentElement;
  const vb = svg.viewBox.baseVal;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", vb.width);
  svg.setAttribute("height", vb.height);
  svg.setAttribute("style", "background-color:#ffffff");
  return { text: new XMLSerializer().serializeToString(svg), w: vb.width, h: vb.height };
}

el.exportSvg.onclick = async () => {
  const out = await exportMarkup();
  if (out) download(new Blob([out.text], { type: "image/svg+xml" }), "diagram.svg");
};

el.exportPng.onclick = async () => {
  const out = await exportMarkup();
  if (!out) return;
  const scale = 2;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.text)}`;
  try {
    await img.decode();
    const canvas = make("canvas", { width: Math.ceil(out.w * scale), height: Math.ceil(out.h * scale) });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => (blob ? download(blob, "diagram.png") : setStatus("error", "PNG export failed. Try SVG.")), "image/png");
  } catch {
    setStatus("error", "PNG export failed. Try SVG.");
  }
};

/* ---------- failure actions ---------- */

el.failureRetry.onclick = () => {
  const r = state.lastRequest;
  if (r) runStream(r.path, r.body, r.label);
  else submitPrompt();
};
el.failureCode.onclick = () => { selectTab(el.tabCode); el.code.focus(); };

/* ---------- status, dialogs, bring-your-own-key ---------- */

async function checkStatus() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    el.modelName.textContent = `${s.model} · ${s.provider === "ollama" ? "local" : "API"}`;
    el.modelStatus.className = `model-status ${s.ok || hasUserKey() ? "ok" : "bad"}`;
    el.modelStatus.title = s.ok ? "Model ready" : s.message;
    el.settingsBtn.hidden = !s.allowUserKeys;
    el.healthNotice.hidden = s.ok || hasUserKey();
    if (!s.ok) {
      el.healthMsg.textContent = s.allowUserKeys ? `${s.message} You can add your own API key with the key button.` : s.message;
      const cmd = (s.hint ?? "").replace(/^.*?:\s+/, "");
      el.healthHint.textContent = cmd;
      el.healthHintWrap.hidden = !cmd || s.allowUserKeys;
    }
  } catch {
    el.modelName.textContent = "Server offline";
    el.modelStatus.className = "model-status bad";
  }
}
el.healthRetry.onclick = checkStatus;

const openAbout = () => el.aboutDialog.showModal();
el.aboutBtn.onclick = openAbout;
el.aboutLink.onclick = openAbout;

el.settingsBtn.onclick = () => { el.userKey.value = ""; el.settingsDialog.showModal(); el.userKey.focus(); };
el.settingsDialog.addEventListener("close", () => {
  if (el.settingsDialog.returnValue === "save" && el.userKey.value.trim()) setUserKey(el.userKey.value);
  if (el.settingsDialog.returnValue === "clear") setUserKey("");
  el.userKey.value = "";
  checkStatus();
});

/* ---------- starters + keyboard ---------- */

el.starters.replaceChildren(...STARTERS.map((s) => {
  const b = make("button", { type: "button", className: "starter", title: s.text });
  b.innerHTML = `<i data-lucide="${s.icon}"></i><span></span>`;
  b.querySelector("span").textContent = s.text;
  b.onclick = () => { el.prompt.value = s.text; autosize(); submitPrompt(); };
  return b;
}));

function autosize() {
  el.prompt.style.height = "auto";
  el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 200)}px`;
}
el.prompt.addEventListener("input", autosize);
el.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitPrompt(); }
});
el.promptForm.addEventListener("submit", (e) => { e.preventDefault(); submitPrompt(); });
el.changeForm.addEventListener("submit", (e) => { e.preventDefault(); requestEdit(el.changeInput.value.trim()); });

icons();
applyTheme();
checkStatus();
