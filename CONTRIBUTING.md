# Contributing

Thanks for helping out. Small, focused pull requests are easiest to review.

1. Fork and clone, then `npm install`.
2. Copy `.env.example` to `.env` and point it at a model (local Ollama is easiest).
3. `npm start` and open http://localhost:8787.
4. Make your change. Add or update tests in `test/` for server or `shared/` logic.
5. `npm test` must pass. If you changed the UI, `npm run e2e` (needs Chrome and a running model) updates the screenshots in `docs/screenshots/`.

Guidelines:
- No new runtime dependencies without a good reason; check the license is permissive (MIT, ISC, BSD, Apache-2.0, OFL for fonts).
- Keep the browser free of third-party requests: vendor assets are served from `node_modules`.
- Never commit `.env`, keys, or real user prompts.

By contributing you agree that your work is released under the MIT License.
