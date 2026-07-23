# Production Deploy

Dashboard production runs from:

```text
/home/ubuntu/projects/mira-dashboard
```

The service runs from the backend directory:

```text
/home/ubuntu/projects/mira-dashboard/backend
```

## Deployment Model

This is a single-host service:

- frontend assets are built into `dist/`;
- backend TypeScript is built into `backend/dist/`;
- `mira-dashboard.service` runs the HTTP/WebSocket process from
  `bun dist/serverStart.js` through Doppler;
- `mira-dashboard-worker.service` runs the persistent scheduler/executor from
  `bun dist/workerStart.js` through Doppler;
- SQLite state lives under `backend/data/` unless `MIRA_DASHBOARD_DB_PATH` is set.
- both units use `UMask=0077`; startup enforces `0700` on the SQLite directory
  and `0600` on database/sidecar files.

Both tracked units preserve the production environment contract by launching
through Doppler project/config `rajohan/prd`. Auth and origin settings such as
`MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH` and `MIRA_DASHBOARD_ALLOWED_ORIGINS`
remain owned by Doppler; do not duplicate their values in unit files.

There is no container image for the Dashboard service today.

## Prepare Deployment

Install both dependency sets:

```bash
cd /home/ubuntu/projects/mira-dashboard
git pull --ff-only
bun install --frozen-lockfile
cd backend
bun install --frozen-lockfile
cd ..
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run deploy:prepare
```

`deploy:prepare` builds the frontend and backend, then runs `db:preflight`
before service restart. Keep ordinary `build` commands side-effect free; use
this combined command for every supported manual or Dashboard-driven deploy so
the database safety gate cannot be skipped accidentally.

## Install Or Refresh Units

After building, install the tracked resource-limited units:

```bash
cd /home/ubuntu/projects/mira-dashboard
install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
install -m 0644 systemd/mira-dashboard-worker.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
systemctl --user daemon-reload
```

For the first split-process rollout, restart the web unit with its explicit
`web` role before starting the worker. This avoids overlapping the legacy
combined scheduler with the dedicated worker:

```bash
systemctl --user restart mira-dashboard.service
systemctl --user enable --now mira-dashboard-worker.service
```

## Restart

Always tell Raymond before restarting OpenClaw Gateway. Dashboard restart is
safe after a merged/deployed Dashboard change. A web-only restart does not
interrupt queued/running actions. Before restarting the worker, verify the Jobs
queue is idle or explicitly accept that its active action will be cancelled:

```bash
systemctl --user restart mira-dashboard.service
systemctl --user restart mira-dashboard-worker.service
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status mira-dashboard-worker.service --no-pager
```

Logs:

```bash
journalctl --user -u mira-dashboard.service -n 120 --no-pager
journalctl --user -u mira-dashboard-worker.service -n 120 --no-pager
```

## Smoke Test

```bash
curl http://127.0.0.1:3100/api/health
curl http://127.0.0.1:3100/api/auth/bootstrap
```

The queue endpoint requires a valid Dashboard session unless the explicitly
configured direct-loopback bypass is enabled. Production currently sources
`MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1` from Doppler, but the portable smoke test
does not depend on that host-specific bypass.

For an authenticated browser session, also verify:

- header/WebSocket status is connected;
- Jobs shows the execution queue and the worker becomes idle after startup seeds;
- Dashboard page cards load;
- Reports page loads recent reports;
- Notifications bell loads without global chat/tool errors.

## Rollback

Rollback is git-based:

```bash
cd /home/ubuntu/projects/mira-dashboard
git log --oneline -n 10
git switch main
git reset --hard <known-good-sha>
bun run build
(cd backend && bun run build)
install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
if test -f backend/dist/workerStart.js; then
  install -m 0644 systemd/mira-dashboard-worker.service \
    /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
  systemctl --user daemon-reload
  systemctl --user restart mira-dashboard.service
  systemctl --user restart mira-dashboard-worker.service
else
  systemctl --user disable --now mira-dashboard-worker.service
  systemctl --user daemon-reload
  systemctl --user restart mira-dashboard.service
fi
curl http://127.0.0.1:3100/api/health
```

If the known-good target predates `workerStart.js`, the branch above stops the
worker before starting that version and reinstalls the checked-out legacy
combined web unit. Do not repeatedly restart a worker unit whose target
entrypoint does not exist.

Do not use `git reset --hard` casually in normal work. It is a rollback
procedure for production incidents after an explicit decision.

## SQLite Deploy Lifecycle

SQLite schema changes are numbered, immutable migrations recorded in
`schema_migrations`. Build/deploy preflight:

1. requires the live database to be in WAL mode;
2. rejects unknown migration versions, gaps, names, or checksum drift;
3. creates a WAL-consistent `pre-deploy` backup with `VACUUM INTO`;
4. copies that snapshot to an isolated restore location, requires
   `PRAGMA quick_check = ok` plus valid migration history, and applies every
   pending migration to the disposable copy;
5. applies bounded backup retention.

On restart, web and worker independently validate history. `BEGIN IMMEDIATE`
serializes pending migrations and the second process revalidates after waiting
for the first. The process holding that writer lock creates a separate
restore-verified `pre-migration` backup through a read-only connection before
running migration SQL, so no other writer can commit between the rollback
snapshot and the migration.

The first deployment that introduces this lifecycle cannot make the
already-running old worker call the new preflight command. Its new startup path
therefore creates the verified `pre-migration` backup before adopting the
legacy schema. Subsequent Dashboard deploys run both protections.

Do not copy only the main `.db` file while Dashboard is running. WAL mode may
hold committed writes in the `-wal` sidecar until a checkpoint.

Code rollback and data rollback are separate decisions. A code rollback may use
the migrated database only when the older code is schema-compatible. Otherwise
stop both Dashboard units and restore the selected matching snapshot using the
[SQLite restore runbook](../operations/runbooks.md#restore-dashboard-sqlite).

### Schema Compatibility And Release Rollback Contract

Classify every future migration before release:

- **expand/backward-compatible:** the previous retained release can safely read
  and write the migrated schema. An immutable release manager may switch code
  back without restoring data;
- **contract/incompatible:** older code cannot safely use the resulting schema
  or data semantics. Automatic code-only rollback must be blocked.

Prefer expand/migrate/contract across separate releases. Add new structures
first, deploy code that tolerates both representations, backfill with a bounded
and resumable job, then remove the old representation only after the previous
release has left the rollback window. The contract migration gets a new
forward-only version; released migration files are never edited.

If an incompatible change cannot be phased, treat activation as a coordinated
code-and-data cutover:

1. record the release SHA, supported schema range, and selected verified
   pre-deploy/pre-migration snapshot in the release manifest;
2. stop both Dashboard units for the cutover and verify the execution queue is
   idle;
3. activate the immutable release and migrate forward;
4. run readiness against the new release and schema;
5. on failure, stop both units, restore the matching snapshot, switch the
   `current` release link back, and only then restart.

The migration runner intentionally has no destructive down-migration path.
Unknown newer migration versions make older code fail closed. A future release
manager must therefore read the release/schema compatibility declaration before
offering or automatically performing rollback; it must never start an
incompatible older release against a newer live database.

## Health Signals

Healthy `/api/health`:

```json
{
    "status": "isOk",
    "gatewayConnected": true,
    "sessionCount": 9,
    "backendCommit": "abc1234",
    "workerOnline": true
}
```

Important failures:

- `gatewayConnected: false`: check OpenClaw Gateway service and Gateway token.
- `workerOnline: false`: the worker heartbeat is stale or queue telemetry is
  unavailable; check both Dashboard and worker service logs.
- HTTP `503 Frontend Not Built`: build root frontend with `bun run build`.
- `Unauthorized` on API routes: auth/session or cookie issue.
- `database is locked`: another process is holding SQLite; retry after
  background jobs settle, then inspect both service logs. Dashboard uses a
  five-second SQLite busy timeout and requires WAL mode.
