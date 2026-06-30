# Troubleshooting

Use this page when the symptom is unclear. Prefer narrow checks before restarts.

## Quick Triage

```bash
curl http://127.0.0.1:3100/api/health
systemctl --user status mira-dashboard.service --no-pager
journalctl --user -u mira-dashboard.service -n 160 --no-pager
git -C /home/ubuntu/projects/mira-dashboard status --short --branch
```

Expected production checkout state:

```text
## main...origin/main
```

## Dashboard Is Up But Gateway Disconnected

Check:

```bash
systemctl --user status openclaw-gateway.service --no-pager
openclaw status
journalctl --user -u mira-dashboard.service -n 200 --no-pager | rg -i "gateway|token|mismatch|unauthorized"
```

Likely causes:

- OpenClaw Gateway is down or restarting;
- Dashboard token does not match OpenClaw token;
- bootstrap stored a stale token while env token is absent;
- browser session is valid but backend Gateway client is disconnected.

Fix token state without printing token values. Prefer Doppler/env token when
available.

## Bootstrap Problems

`/api/auth/register-first-user` should:

- reject if a user already exists;
- validate Gateway auth before creating the first user;
- serialize overlapping first-user requests;
- roll back user/session/token state on failure.

If bootstrap appears stuck:

```bash
curl http://127.0.0.1:3100/api/auth/bootstrap
journalctl --user -u mira-dashboard.service -n 200 --no-pager
```

If Raymond explicitly wants a reset, follow the reset runbook in
[Operations runbooks](runbooks.md).

## SQLite Locked

Dashboard sets `PRAGMA busy_timeout = 5000`, so short locks should self-resolve.
Manual `sqlite3` writes can still conflict with background jobs.

Safe response:

1. Retry once after a short delay.
2. Stop manual write sessions.
3. Check Dashboard logs for a long transaction or active backup/deploy job.
4. Restart only if the lock persists and no operation should still be running.

## Reports Missing Or Stale

Check:

- Reports page filter;
- whether the report has a `dedupeKey` and was upserted;
- whether `/reports?reportId=...` points to a deleted report;
- whether polling failed but cached data is still visible.

Smoke-test report creation requires a Dashboard session cookie unless loopback
auth is intentionally enabled. See [Operations runbooks](runbooks.md).

## Docker Update Problems

Before applying or retrying Docker updates:

```bash
cd /opt/docker
git status --short
/opt/docker/bin/docker-compose-doppler config
```

If registry checks fail, inspect credentials:

- Docker Hub needs both `DOCKER_LOGIN` and `DOCKER_TOKEN`;
- GHCR needs `MIRA_GITHUB_USERNAME` and `MIRA_GITHUB_TOKEN`.

Do not manually rewrite compose YAML through generic formatters. Preserve human
layout unless a deliberate migration requires otherwise.

## Frontend Not Built Or Serving Old Assets

```bash
cd /home/ubuntu/projects/mira-dashboard
bun run build
systemctl --user restart mira-dashboard.service
curl http://127.0.0.1:3100/api/health
```

If the browser still shows old UI, hard refresh or clear the tab cache.

## CI Or PR Checks Fail

Run the same local gates before pushing another fix:

```bash
bun run lint
bun run build
bun run format:check
git diff --check
```

Backend:

```bash
cd backend
bun run lint
bun run build
bun run test:coverage
```

Remember that Codecov PR comments often discuss patch coverage, not total local
coverage. Add focused tests for the changed lines rather than chasing only the
overall percentage.
