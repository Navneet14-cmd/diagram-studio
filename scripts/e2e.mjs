// End-to-end check against the configured model (default: local Ollama) in headless Chrome.
// Usage: npm run e2e        (E2E_ONLY=<name prefix> to run one scenario)
// Writes screenshots to docs/screenshots/. Needs Google Chrome installed (Playwright "chrome" channel).
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createApp } from "../server/server.mjs";
import { config } from "../server/config.mjs";
import { createLlm } from "../server/llm.mjs";

const outDir = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const LONG = 300_000;

const SCENARIOS = [
  { name: "01-login-flow", prompt: "Login flow with email and password, optional 2FA code, and account lockout after 3 failed attempts", chip: true, exports: true },
  { name: "02-microservices", prompt: "Microservice architecture for a food delivery app: API gateway, auth, orders, restaurants, payments, notifications, each with its own database, plus a message queue", edit: "Add an in-memory cache used by the orders service" },
  { name: "03-shop-er", prompt: "ER diagram for an online shop with customers, orders, order items, products, categories and reviews", theme: "dark" },
  { name: "04-payment-sequence", prompt: "Sequence diagram for a card payment: customer, web shop, payment gateway, bank with 3-D Secure, and the webhook back to the shop", theme: "dark", tab: "code" },
  { name: "05-cicd-pipeline", prompt: "CI/CD pipeline: push to the repository, lint, unit tests, build a container image, deploy to staging, smoke tests, manual approval, deploy to production" },
  // The model's output is corrupted in flight, so the client must run the model-backed repair loop.
  { name: "06-repair", prompt: "Flowchart of an order fulfilment process: order placed, payment check, pick items, pack, ship, deliver, handle returns", breakIt: true },
  // Repair is forced to fail too, to show the friendly error state.
  { name: "07-error-state", prompt: "Simple flowchart of brewing a cup of tea", breakIt: true, failRepair: true, expectFailure: true },
  { name: "08-mobile", prompt: "Flowchart for resetting a forgotten password by email", viewport: MOBILE, fullPage: true },
  { name: "09-mobile-dark", prompt: "Sequence diagram of a user uploading a profile photo to a web app that stores it in object storage", viewport: MOBILE, theme: "dark", fullPage: true },
];

const llm = createLlm(config);
const health = await llm.health();
if (!health.ok) {
  console.error(`✖ ${health.message}\n  ${health.hint}`);
  process.exit(1);
}

const server = createApp({ cfg: { ...config, rateLimitMax: 0 }, llm });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const shot = (page, name, fullPage = false) => page.screenshot({ path: `${outDir}${name}.png`, fullPage });

async function newPage(viewport, theme, problems) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme ?? "light", acceptDownloads: true, isMobile: viewport === MOBILE, hasTouch: viewport === MOBILE });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("request", (r) => { const u = r.url(); if (!u.startsWith(base) && !/^(data|blob):/.test(u)) problems.push(`external request: ${u}`); });
  return page;
}

const settled = (page) => page.waitForFunction(() => {
  const s = document.getElementById("status").textContent;
  return s.startsWith("Done") || !document.getElementById("failure").hidden || !document.getElementById("clarify").hidden;
}, null, { timeout: LONG });

async function waitForChips(page) {
  await page.waitForFunction(() => !document.querySelector("#chips .chip-skeleton") && document.querySelector("#chips").children.length > 0, null, { timeout: 120_000 });
}

async function runEdit(page, trigger) {
  await trigger();
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Applying"), null, { timeout: 10_000 });
  await settled(page);
  await waitForChips(page).catch(() => {});
}

const only = process.env.E2E_ONLY;

// Empty states (desktop light/dark).
if (!only) {
  for (const theme of ["light", "dark"]) {
    const problems = [];
    const page = await newPage(DESKTOP, theme, problems);
    await page.goto(base);
    await page.waitForSelector("#modelStatus.ok");
    await shot(page, `00-empty-${theme}`);
    if (problems.length) results.push({ name: `00-empty-${theme}`, problems, failure: null, svg: true });
    await page.context().close();
  }
}

for (const s of SCENARIOS.filter((x) => !only || x.name.startsWith(only))) {
  const problems = [];
  const page = await newPage(s.viewport ?? DESKTOP, s.theme, problems);
  if (s.breakIt) {
    let broken = false;
    await page.route("**/api/generate", async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      if (!broken) {
        // A sequence-diagram arrow inside a flowchart: a typical small-model slip the sanitizer leaves alone.
        body = body.replace(/"code":"((?:flowchart|graph) [A-Z]{2})\\n/g, '"code":"$1\\n  audit[\\"Audit log\\"] ->> archive[\\"Archive\\"]\\n');
        broken = body.includes("->> archive");
      }
      await route.fulfill({ response: res, body });
    });
  }
  if (s.failRepair) await page.route("**/api/repair", (r) => r.fulfill({ json: { code: "flowchart TD\n  a[\"Kettle\"] ->> b[\"Cup\"]" } }));

  await page.goto(base);
  await page.evaluate(() => {
    window.__statusLog = [];
    new MutationObserver(() => window.__statusLog.push(document.getElementById("status").textContent))
      .observe(document.getElementById("status"), { childList: true, subtree: true, characterData: true });
  });
  const t0 = Date.now();
  await page.fill("#prompt", s.prompt);
  await page.press("#prompt", "Enter");

  if (s.breakIt) {
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Fixing syntax"), null, { timeout: LONG });
    await shot(page, `${s.name}-fixing`);
  }
  await settled(page);
  if (await page.isVisible("#clarify")) {
    problems.push("(info) clarifying questions shown; skipped");
    await page.click("#skipQuestions");
    await settled(page);
  }
  const ok = await page.evaluate(() => document.getElementById("failure").hidden);
  if (ok) await waitForChips(page).catch(() => problems.push("no suggestions"));
  await page.waitForTimeout(250);
  await shot(page, s.name, s.fullPage);

  if (ok && s.chip) {
    const label = await page.textContent("#chips .chip strong");
    await runEdit(page, () => page.click("#chips .chip"));
    problems.push(`(info) applied suggestion: "${label}"`);
    await shot(page, `${s.name}-after-suggestion`);
  }
  if (ok && s.edit) {
    await runEdit(page, async () => { await page.fill("#changeInput", s.edit); await page.press("#changeInput", "Enter"); });
    problems.push(`(info) applied typed edit: "${s.edit}"`);
    await shot(page, `${s.name}-after-edit`);
  }
  if (ok && s.tab === "code") {
    await page.click("#tabCode");
    await shot(page, `${s.name}-code-tab`);
  }
  if (ok && s.exports) {
    for (const [btn, ext] of [["#exportSvg", "svg"], ["#exportPng", "png"]]) {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click(btn)]);
      await dl.saveAs(`${outDir}export-sample.${ext}`);
      problems.push(`(info) exported ${dl.suggestedFilename()}`);
    }
  }

  const info = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    failure: document.getElementById("failure").hidden ? null : document.getElementById("failureMsg").textContent,
    statusLog: [...new Set(window.__statusLog)],
    svg: !!document.querySelector("#diagram svg"),
    code: document.getElementById("code").value,
    chips: [...document.querySelectorAll("#chips .chip strong")].map((b) => b.textContent),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }));
  if (info.overflowX) problems.push("page scrolls horizontally");
  const repaired = info.statusLog.some((x) => x.startsWith("Fixing syntax"));
  const pass = s.expectFailure ? !!info.failure : !info.failure && info.svg && (!s.breakIt || repaired);
  results.push({ ...s, ...info, pass, problems });
  console.log(`\n${pass ? "✔" : "✖"} ${s.name} (${Math.round((Date.now() - t0) / 1000)}s) status="${info.status}" repaired=${repaired}`);
  console.log(`  statuses: ${info.statusLog.filter(Boolean).join(" | ")}`);
  if (info.chips.length) console.log(`  suggestions: ${info.chips.join(" · ")}`);
  if (info.failure) console.log(`  failure: ${info.failure}`);
  for (const p of problems) console.log(`  ${p}`);
  if (process.env.E2E_CODE) console.log(info.code.replace(/^/gm, "    "));
  await page.context().close();
}

// Clarifying questions: only shown for very short, vague prompts (the model decides, so this may not trigger).
if (!only || only === "10") {
  const problems = [];
  const page = await newPage(DESKTOP, "light", problems);
  await page.goto(base);
  await page.fill("#prompt", "a diagram of my app");
  await page.click("#generateBtn");
  await settled(page);
  const asked = await page.isVisible("#clarify");
  if (asked) await shot(page, "10-clarifying-questions");
  console.log(`\n${asked ? "✔ 10-clarifying-questions shown" : "• 10-clarifying-questions: model chose not to ask (allowed)"}`);
  await page.context().close();
}

await browser.close();
server.close();
const bad = results.filter((r) => r.pass === false || r.problems.some((p) => !p.startsWith("(info)")));
console.log(`\n${results.length - bad.length}/${results.length} checks clean. Screenshots: ${outDir}`);
process.exit(bad.length ? 1 : 0);
