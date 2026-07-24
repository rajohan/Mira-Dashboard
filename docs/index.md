# Mira Dashboard Documentation

This directory is the repo-native wiki for Mira Dashboard. It is meant to be
kept in the same PRs as code changes so operational knowledge does not drift
away from the system it describes.

## Start Here

- [New VPS setup](setup/new-vps.md) - bring up Dashboard on a fresh host.
- [Secrets and environment](setup/secrets-and-env.md) - required and optional
  runtime configuration.
- [Production deploy](setup/production-deploy.md) - build, restart, health
  checks, and rollback notes.
- [Architecture overview](architecture/overview.md) - how the frontend,
  backend, SQLite store, OpenClaw Gateway, and background jobs fit together.
- [Gateway and chat runtime](architecture/gateway-and-chat.md) - Gateway token
  validation, browser WebSocket behavior, and chat event handling.
- [Frontend feature map](architecture/frontend-feature-map.md) - route/page
  ownership, data fetching expectations, and UI pitfalls.
- [API overview](api/overview.md) - auth, routing, rate limits, and conventions.
- [Endpoint reference](api/endpoints.md) - route-by-route API map.
- [Operations runbooks](operations/runbooks.md) - common production tasks.
- [Reports delivery](operations/reports-delivery.md) - daily brief, summary,
  heartbeat, and report notification behavior.
- [Docker updater](operations/docker-updater.md) - managed image updates,
  registry auth, compose rewrite rules, and troubleshooting.
- [Scheduler, cache, and backups](operations/scheduler-cache-backups.md) -
  background jobs, cache entries, backup scripts, and inspection commands.
- [Troubleshooting](operations/troubleshooting.md) - symptom-oriented checks for
  Gateway, bootstrap, SQLite, Reports, Docker, frontend, and CI issues.
- [Auth and trust boundaries](security/auth-and-trust-boundaries.md) - route
  auth, scoped automation, loopback migration, proxy trust, bootstrap, secrets,
  and host operations.
- [Local development](development/local-dev.md) - developer setup and commands.
- [Testing and PR workflow](development/testing-and-prs.md) - validation gates,
  worktrees, coverage, and PR hygiene.

## What Dashboard Is

Mira Dashboard is Raymond's local control surface for Mira/OpenClaw operations.
It is a Bun-native application with:

- a React/TanStack Router frontend;
- a Bun backend on port `3100`;
- a shared WebSocket bridge to OpenClaw Gateway;
- local SQLite state for tasks, notifications, reports, auth, Docker updater
  state, scheduled jobs, cache entries, and deployment jobs;
- background schedulers for cache refresh, backups, Docker update checks, log
  rotation, quota notifications, and OpenClaw update notifications.

The production service is `mira-dashboard.service`, running from
`/home/ubuntu/projects/mira-dashboard/backend` through Doppler
`rajohan/prd`.

## Documentation Rules

- Do not store secret values in docs.
- Document new env vars, new route families, new database tables, and new
  operational workflows in the same PR that introduces them.
- Treat changes to an existing API response, cache projection, user-facing
  control, or failure/fallback behavior as documentation changes too. Update
  the owning page or state explicitly in the PR why no docs change is needed.
- Prefer concrete commands and file paths over vague descriptions.
- Keep README short; put setup, operations, and API detail here.
