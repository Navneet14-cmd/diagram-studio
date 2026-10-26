# Decisions

Choices made while turning the earlier prototype into this standalone project, in plain language.

## Name: "Diagram Studio"
A plain, descriptive name. Descriptive names are the least likely to clash with an existing trademark, and this one
says what the app does. The folder, package name, page title, logo text and docs all use it. Before publishing, search
GitHub and your country's trademark register for the exact name; if anything close turns up, rename (search for
"Diagram Studio" and "diagram-studio" across the repo).

## What was copied, rewritten or dropped
- **Kept and adapted** (my own code from the prototype): the model client, prompts, Mermaid sanitizer, repair loop and
  their tests.
- **Rewritten**:
  - The whole web UI (HTML, CSS, JS and logo). The old stylesheet used token names and two colour values recorded
    from another site, so none of it was kept.
  - The analyze and suggestion JSON shapes, which had mirrored an observed third-party format. Questions are now
    `{id, text, options[]}` and suggestions are `{label, instruction}`.
  - The status endpoint, now `/api/status` plus `/healthz`.
- **Dropped**:
  - Everything in the old `re-output/` folder apart from that code: evidence, captures, bundles, screenshots,
    reports, API and route notes, design tokens, the old README, and the `.env` and lockfile (the lockfile was
    regenerated).
  - Any notion of pricing, accounts, usage quotas or login.
- **Product names**: brand names were removed from prompts, few-shot examples, test fixtures and e2e prompts (for
  example "Redis" became "Cache"). The README still names the tools you need to run it (Ollama, the OpenAI-compatible
  API format, Mermaid, Docker, Render, Chrome for e2e). These are functional references, not comparisons with
  another product.

## Design direction
- **Palette**: cool slate neutrals with a deep teal accent (`#0b6e64`) and an amber highlight, with full light and dark
  themes. The theme follows the system setting until the user picks one, which is remembered in `localStorage`.
- **Contrast**: all text meets WCAG AA. Lighthouse scores 100 for accessibility and 100 for best practices.
- **Type**: Space Grotesk (OFL, self-hosted) for headings, the system UI font for body text, and the system monospace
  for code. No font requests leave the server.
- **Layout**: a wide prompt bar across the top, the canvas below it, and an inspector on the right with
  **Refine** / **Code** tabs. On screens 960 px and narrower these stack into one column. The canvas never stretches
  the page: diagrams scroll inside it, and tall diagrams fit the width rather than shrinking text.
- **Logo**: an original mark (a node joined to a dot by a connector) drawn as SVG. It doubles as the favicon.
- **Icons**: Lucide only.

## Behaviour
- **Enter** submits the prompt and **Shift+Enter** adds a line, the common convention for chat-style inputs.
- **Exports** always use the light theme on white, so they look right in documents.
- **Clarifying questions** are only honoured for prompts under 6 words, because small models tend to over-ask.
- When the model returns unusable suggestions, the app shows a short note instead of generic filler.

## Production hardening
- **Default host**: `127.0.0.1`, so a fresh install isn't reachable from the network by accident. The Docker image sets
  `0.0.0.0`.
- **Rate limiting**: in-memory, fixed window, per IP, 30 AI requests per minute by default. Page loads, `/healthz` and
  `/api/status` aren't limited. `TRUST_PROXY` is off by default because trusting `X-Forwarded-For` without a proxy
  lets clients spoof their IP. The Render config turns it on.
- **Limits**: prompt 2,000 characters, code 12,000, body 32 KB, 1,500 tokens per call (hard cap 4,000), 120-second
  model timeout. The model call is also aborted when the browser disconnects.
- **CSP**: `script-src 'self'` with no inline scripts (the theme script is a separate file for that reason).
  `style-src` needs `'unsafe-inline'` because Mermaid puts `<style>` inside its SVG output. Rendered SVG goes through
  Mermaid's strict mode and then DOMPurify.
- **Errors**: unexpected errors return a generic message. Provider error bodies are logged on the server only, never
  returned to the browser.
- **Bring your own key** is off by default and only works with `PROVIDER=openai`. The key lives in a JavaScript
  variable, not `localStorage` or `sessionStorage`, so a reload forgets it. Users can't change `BASE_URL`, so a key
  can only go to the configured provider (no SSRF).
- **Logging**: by default only method, path, status and timing. `LOG_PROMPTS=true` adds the prompt text.

## Hosting: Render (with Docker)
Render can deploy straight from a Dockerfile with a small `render.yaml`, has a free tier, and supports health checks.
Fly.io would also work, but needs its CLI and a credit card for most setups. Ollama can't run on free tiers, so the
Render config uses a hosted OpenAI-compatible API.

The Docker image:
- uses two build stages and runs as the non-root `node` user;
- ships only the four browser asset folders the app serves, not all of `node_modules`; the server itself has no
  runtime npm dependencies;
- has no npm tooling at runtime;
- is about 285 MB, mostly the Node base image and Mermaid.

## Licenses
- **The project**: MIT, copyright 2026 Navansh.
- **Allowlist** (checked by `npm run licenses` across all 119 production packages): MIT, ISC, BSD, Apache-2.0, OFL-1.1
  (fonts) and MPL-2.0. DOMPurify is dual-licensed MPL-2.0 OR Apache-2.0, and we use it under Apache-2.0.
- **One reviewed exception**: `elkjs` (EPL-2.0) ships *inside Mermaid's own bundle*, unmodified, for an optional layout
  engine. EPL-2.0 is a weak, file-level copyleft. Distributing it unmodified alongside MIT code is allowed, and it is
  credited with a link to its source.
- `khroma` has no license field in its package.json; its license file says MIT.
- **Development only**: Playwright (Apache-2.0), not shipped. The Lighthouse check was run with `npx` and isn't a
  dependency.

## Testing
- `npm test`: 59 tests, using a fake model and no network. Covers the sanitizer and fence stripping, the repair loop,
  defensive JSON parsing, the rate limiter, config parsing, input validation, size limits, security headers, error
  hygiene and bring-your-own-key.
- `npm run e2e`: drives headless Chrome against the real local model. Covers 9 scenarios (6 required prompts plus
  failure, mobile and mobile-dark), the clarifying-questions path, a typed edit, a suggestion click, SVG and PNG
  export, both themes, and the 390 px and 1440 px viewports. It fails on any console error, CSP violation, request
  that leaves localhost, or horizontal page scroll.
- **How the repair test works**: it corrupts the model's real output in flight with a sequence arrow (`->>`) inside a
  flowchart. The sanitizer deliberately leaves that alone, so the model-backed repair has to fix it.
- **CI**: a GitHub Actions workflow runs `npm test` on Node 20 and 22. The e2e run isn't in CI because it needs a model.

## Placeholders you need to fill in
- `YOUR-USERNAME` in the README and the in-app "Source code" links.
- `SECURITY-CONTACT-PLACEHOLDER` in SECURITY.md and `CONDUCT-CONTACT-PLACEHOLDER` in CODE_OF_CONDUCT.md.
- The copyright holder in LICENSE ("Navansh") if you want your full name there.
