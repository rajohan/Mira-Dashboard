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
`MIRA_DASHBOARD_AUTOMATION_CREDENTIALS`,
`MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY`,
`MIRA_DASHBOARD_WEBAUTHN_RP_ID`,
`MIRA_DASHBOARD_WEBAUTHN_ORIGINS`, and
`MIRA_DASHBOARD_ALLOWED_ORIGINS` remain owned by Doppler. Do not duplicate their
values in unit files.

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

`deploy:prepare` builds the frontend and backend, runs `db:preflight`, and
writes the checksummed release manifest before service restart. Keep ordinary
`build` commands side-effect free; use this combined command for every
supported manual or Dashboard-driven deploy so the database and release gates
cannot be skipped accidentally.

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
wait_for_dashboard_ready() {
  for attempt in {1..20}; do
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      http://127.0.0.1:3100/api/health/ready >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
wait_for_dashboard_ready
curl http://127.0.0.1:3100/api/auth/bootstrap
```

Every other API route requires a valid Dashboard session or an explicitly
allowed minimum-scope bearer credential. Direct loopback is not an
authentication mechanism. A tokenless local check should therefore fail:

```bash
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:3100/api/cache/heartbeat)" = "401"
```

### Scoped Automation Rollout

The release removes direct-loopback bypass code. Provision and migrate local
callers before restarting into this version:

1. In an untracked privileged shell, generate a separate validator per
   automation identity. Store only its SHA-256 hash plus minimum scopes in
   `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS`. Never generate it through Dashboard
   Terminal or another tracked exec path.
2. Keep the full validator only in the caller's secret store. Do not put it in
   a prompt, command argument, transcript, unit file, or the same configuration
   surface as its hash.
   On this host, use the four `0600` files under
   `/home/ubuntu/.config/mira-dashboard/automation/` through
   `/home/ubuntu/projects/mira-dashboard/scripts/miraDashboardApi.ts`.
3. Migrate and smoke-test every caller against the currently running
   scoped-credential-compatible release:
    - heartbeat: `cache:read`, `reports:write`;
    - task tracking: `agents:write`, `tasks:read`, and `tasks:write`;
    - daily summary: `cache:read`, `reports:write`;
    - daily brief: `cache:read`, `reports:write`, `tasks:read`.
4. Confirm allowed and intentionally denied calls have the expected automation
   actor and scope in `/api/audit-events`.
5. Deploy this release, restart the web unit, verify every scoped caller again,
   and confirm tokenless loopback returns `401`.

The OpenClaw heartbeat must retain its dedicated
`cache:read`/`reports:write` credential.
Task/report credentials must not be reused for heartbeat.

For an authenticated browser session, also verify:

- a pre-v6 session is rejected and a fresh login succeeds;
- first bootstrap still accepts username, password, and Gateway token, then
  stores the Gateway token only as an encrypted envelope and directs the
  operator to **Settings → Dashboard** for MFA enrollment;
- two named security keys can be registered and one can authenticate while the
  other remains offline;
- TOTP and one-time recovery each complete a test verification;
- privileged actions require fresh second-factor verification;
- structured OpenClaw config is masked and raw reveal requires recent MFA;
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
if ! bun -e 'const packageJson = await Bun.file("package.json").json(); process.exit(typeof packageJson.scripts?.["deploy:prepare"] === "string" ? 0 : 1)'; then
  echo "Rollback target predates the supported deploy contract" >&2
  exit 1
fi
bun install --frozen-lockfile
(cd backend && bun install --frozen-lockfile)
if test -f scripts/writeReleaseManifest.ts; then
  release_health_path=/api/health/ready
else
  # One-time bootstrap rollback to the pre-manifest release.
  release_health_path=/api/health
fi
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run deploy:prepare
install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
install -m 0644 systemd/mira-dashboard-worker.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
systemctl --user daemon-reload
systemctl --user restart mira-dashboard.service
systemctl --user restart mira-dashboard-worker.service
wait_for_dashboard_ready() {
  for attempt in {1..20}; do
    if test "$release_health_path" = "/api/health"; then
      if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
        "http://127.0.0.1:3100${release_health_path}" |
        grep -Fq '"workerOnline":true'; then
        return 0
      fi
    elif curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      "http://127.0.0.1:3100${release_health_path}" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
wait_for_dashboard_ready
```

The conditional health target exists only for the first rollback across the
manifest-contract cutover. Manifest-aware releases always regenerate their
ignored manifest through `deploy:prepare` and verify `/api/health/ready`.

Rollback targets older than the split-worker/database-preflight contract are
deliberately unsupported. This private single-operator service keeps a supported
known-good release instead of retaining an untested legacy activation path.

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

## Release Manifest Contract

`bun run deploy:prepare` builds frontend and backend, completes the verified
SQLite preflight, and writes an ignored `release-manifest.json` in the release
root. The manifest is the release identity source when `NODE_ENV=production`;
Git is only a development/test fallback.

Manifest format version 1 records:

- the full and eight-character Git commit plus commit title and build time;
- the Bun version used for the build;
- matching frontend/backend commit identities emitted inside both build trees;
- the target, minimum-compatible, and maximum-compatible SQLite schema;
- a checksum of the immutable migration registry;
- the SHA-256 and byte length of every frontend/backend build artifact plus
  both package manifests, Bun lockfiles, and the default runtime log-rotation
  configuration.

The backend bundle also embeds its full build commit. Runtime readiness requires
that embedded commit, both build-identity files, and the release manifest to
agree. Running `release:manifest` against ignored output left behind by another
checkout therefore fails instead of relabeling stale code.

Manifest creation and verification reject absolute/traversal paths, symlinks,
hard-linked files, special files, unsorted/duplicate inventories, checksum
drift, and undeclared runtime artifacts. The schema compatibility range is an
explicit code constant. Adding a future migration without reviewing that range
fails the release contract.

The release lifecycle layer validates immutable directories named by full Git
SHA under `/home/ubuntu/projects/mira-dashboard-releases/releases/`. It exposes
only three commands:

```bash
bun backend/dist/releaseLifecycle.js status
bun backend/dist/releaseLifecycle.js activate <full-commit-sha>
bun backend/dist/releaseLifecycle.js rollback
```

`current` and `previous` are relative links inside the release root. Link
replacement uses same-directory temporary symlinks, atomic rename, and a
directory fsync. Activation verifies every artifact, both component build
identities, the exact manifest/directory SHA, the host Bun version, the actual
live SQLite schema, and the previous release's rollback window. Rollback also
checks the live schema rather than assuming it was downgraded by a code-only
rollback.

Every activation and rollback is serialized by an owner-PID lock and recorded
in a durable transition journal before either link changes. A later lifecycle
command restores the recorded pre-transition slots when it finds a journal
whose owner process is gone. Successful transitions verify both final slots
before removing the journal, so an interruption cannot discard the known-good
rollback target.

The Dashboard executor still uses the in-place transition flow until the final
deploy integration performs the controlled systemd cutover to these links.

## Health Signals

Deployment health is split by purpose:

- `GET /api/health/live` proves that the web process can answer requests.
- `GET /api/health/ready` requires a valid release identity,
  current/accessible SQLite schema, built frontend, and a fresh worker heartbeat
  from the exact manifest commit.
  Concurrent probes share one artifact scan, and a completed result is reused
  for at most 15 seconds before the checksummed inventory is verified again.
  This readiness route returns HTTP 503 with `status: "notReady"` when an
  internal activation check fails.
- `GET /api/health/diagnostics` returns the readiness breakdown plus session
  count and requires an authenticated Dashboard session.
- `GET /api/health` is a temporary compatibility adapter for the pre-readiness
  deploy executor. It returns 503 unless the full readiness contract passes and
  retains `workerOnline` only until the atomic executor cutover is complete.

Gateway connectivity is reported as an external dependency but deliberately
does not fail release readiness: rolling Dashboard code back cannot repair an
OpenClaw Gateway outage. Production activation and automatic rollback must use
`/api/health/ready`.

Important failures:

- `dependencies.gatewayConnected: false` in authenticated diagnostics: check
  OpenClaw Gateway service and Gateway token.
- `checks.worker.ready: false`: the worker heartbeat is stale or queue telemetry is
  unavailable; check both Dashboard and worker service logs.
- HTTP `503 Frontend Not Built`: build root frontend with `bun run build`.
- `Unauthorized` on API routes: auth/session or cookie issue.
- `database is locked`: another process is holding SQLite; retry after
  background jobs settle, then inspect both service logs. Dashboard uses a
  five-second SQLite busy timeout and requires WAL mode.
