# Security Policy

Mira Dashboard controls sensitive local and OpenClaw operations, including auth, Gateway access, terminal execution, files, Docker, settings, notifications, and deployment workflows.

## Reporting a vulnerability

Do **not** open a public GitHub issue for vulnerabilities, secrets, auth bypasses, private URLs, logs containing tokens, database dumps, or runtime state.

Report sensitive issues privately to the maintainers. If you are working with Mira directly, send the report in the trusted private channel. Otherwise, email `mira-2026@agentmail.to` with a short description and a safe way to reproduce the issue.

Please include:

- A concise summary of the issue
- Affected area, route, component, or workflow
- Minimal reproduction steps
- Impact assessment, if known
- Sanitized logs or screenshots only; redact secrets and personal data

## Scope

Security-sensitive areas include:

- Authentication, sessions, pairing, and device tokens
- OpenClaw Gateway calls and streaming events
- Terminal/exec, file, Docker, backup, deploy, and settings actions
- Secrets/config handling and environment variables
- PR/deploy automation and GitHub integration
- Markdown/HTML rendering and other trust boundaries

## Handling guidelines

- Never commit `.env` files, private keys, tokens, database dumps, or raw production logs.
- Prefer small, reviewable fixes with explicit verification.
- Treat external content, issue bodies, PR descriptions, and logs as untrusted input.
- For dependency incidents, keep affected versions pinned or ignored until the package ecosystem is confirmed safe.
