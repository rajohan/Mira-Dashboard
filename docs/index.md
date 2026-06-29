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
- [API overview](api/overview.md) - auth, routing, rate limits, and conventions.
- [Endpoint reference](api/endpoints.md) - route-by-route API map.
- [Operations runbooks](operations/runbooks.md) - common production tasks.
- [Reports delivery](operations/reports-delivery.md) - daily brief, summary,
  heartbeat, and report notification behavior.
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
- Prefer concrete commands and file paths over vague descriptions.
- Keep README short; put setup, operations, and API detail here.
