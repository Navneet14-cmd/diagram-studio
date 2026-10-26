# Security policy

## Reporting a vulnerability

Please report security issues privately, not in public issues. Use GitHub's
"Report a vulnerability" button on the repository's Security tab, or email
the maintainer at SECURITY-CONTACT-PLACEHOLDER.

Include what you found, how to reproduce it, and the impact you expect. You'll get
an acknowledgement within a few days. Please give a reasonable window for a fix
before disclosing publicly.

## Running a public instance

- Use a hosted OpenAI-compatible provider with a spending limit on its key.
- Keep `RATE_LIMIT_MAX` on, and set `TRUST_PROXY=true` only behind a proxy you control.
- Keep `LOG_PROMPTS=false` unless you have told users their prompts are logged.
- The app has no authentication. Anyone who can reach it can spend your model quota;
  put it behind your own auth (for example a reverse proxy) if that matters.
