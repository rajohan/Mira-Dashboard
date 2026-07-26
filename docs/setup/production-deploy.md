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
code-and-data cutover. This procedure becomes executable only after the final
deploy integration has switched both systemd units and the executor to the
managed `current` link; incompatible cutovers are unsupported while production
still uses the in-place checkout:

1. run the candidate's production preflight, then record the release SHA,
   supported schema range, and preflight result in the deployment record;
2. stop both Dashboard units for the cutover and verify the execution queue is
   idle;
3. rerun the candidate's database preflight against the stable production
   database, require restore verification, and record the newly created
   `pre-deploy` snapshot; do not reuse the snapshot from step 1 because writes
   may have committed before the units stopped;
4. activate the immutable release with the explicit
   `--coordinated-schema-cutover` flag;
5. start both units through the managed `current` link, migrate forward on
   startup, and run readiness against the new release and schema;
6. on failure, stop both units, restore the snapshot recorded in step 3,
   switch the `current` release link back, and only then restart.

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

Manifest format version 2 records:

- the full and eight-character Git commit plus commit title and build time;
- the Bun version used for the build;
- matching frontend/backend commit identities emitted inside both build trees;
- the target, minimum-compatible, and maximum-compatible SQLite schema;
- a checksum of the immutable migration registry;
- the ordered migration identities and their inventory digest;
- the SHA-256 and byte length of every frontend/backend build artifact plus
  both package manifests, Bun lockfiles, and the default runtime log-rotation
  configuration.

Format version 1 remains readable only for the first managed cutover and its
rollback window because the currently deployed release predates the migration
inventory and lifecycle artifact. Remove v1 support once neither `current` nor
`previous` can reference that release; all newly built releases are format v2.

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
SHA under `/home/ubuntu/projects/mira-dashboard-releases/releases/`. This is the
production default; a deliberately configured `MIRA_DASHBOARD_RELEASES_ROOT`
overrides it. Run lifecycle commands from a known format-v2 release with the
same Doppler production environment as the services so schema checks always
inspect the live Dashboard database. Do not invoke the lifecycle CLI through
`current`: the first managed rollback may point `current` at the retained
format-v1 release, which does not contain that artifact. Record and retain the
first format-v2 release SHA as the management release until the v1 rollback
window closes.

Pass the service's stable absolute database path after Doppler injection;
changing into an immutable release must not redirect SQLite state into that
release:

```bash
RELEASES_ROOT="/home/ubuntu/projects/mira-dashboard-releases"
LIFECYCLE_RELEASE_SHA="REPLACE_WITH_RETAINED_FORMAT_2_SHA"
CANDIDATE_RELEASE_SHA="REPLACE_WITH_CANDIDATE_FULL_SHA"
LIFECYCLE_CLI="$RELEASES_ROOT/releases/$LIFECYCLE_RELEASE_SHA/backend/dist/releaseLifecycle.js"
test -f "$LIFECYCLE_CLI"

doppler run --config prd --project rajohan -- \
  env MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard/backend/data/mira-dashboard.db \
  bun "$LIFECYCLE_CLI" status
doppler run --config prd --project rajohan -- \
  env MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard/backend/data/mira-dashboard.db \
  bun "$LIFECYCLE_CLI" rollback

doppler run --config prd --project rajohan -- \
  env MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard/backend/data/mira-dashboard.db \
  bun "$LIFECYCLE_CLI" activate "$CANDIDATE_RELEASE_SHA"
```

If production uses a non-default release root, replace `RELEASES_ROOT` with
that explicit absolute path. Passing it through `env` after Doppler injection
ensures the lifecycle process and the shell-resolved CLI always use the same
release tree.

`current` and `previous` are relative links inside the release root. Link
replacement uses same-directory temporary symlinks, atomic rename, and a
directory fsync, then re-verifies the linked release before committing the
transition. Activation verifies every artifact, both component build
identities, the exact manifest/directory SHA, the host Bun version, the actual
live SQLite schema, and the previous release's rollback window. Rollback also
checks the live schema rather than assuming it was downgraded by a code-only
rollback.

The lifecycle CLI changes release links only; an already-running process keeps
executing the physical release it started from. After the final systemd
cutover, every activation and rollback must therefore restart both units and
verify release readiness before reporting success:

```bash
systemctl --user restart mira-dashboard-worker.service
systemctl --user restart mira-dashboard.service
curl --fail --silent --show-error http://127.0.0.1:3100/api/health/ready
```

The final deploy executor owns this sequence and automatically runs the same
restart/readiness checks after switching back on failure. The commands above
are the required manual fallback, not an optional post-deploy check.

Normal activation refuses a schema target outside the current release's rollback
window. After the final systemd/executor cutover, the exceptional snapshot-backed
procedure above runs the candidate command only after preflight succeeds, both
services are stopped, their `WorkingDirectory`/`ExecStart` resolve through the
managed `current` link, and the queue is idle:

```bash
doppler run --config prd --project rajohan -- \
  env MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard/backend/data/mira-dashboard.db \
  bun "$LIFECYCLE_CLI" activate "$CANDIDATE_RELEASE_SHA" \
  --coordinated-schema-cutover
```

The flag is rejected for ordinary compatible releases. It permits the candidate
startup migration across the incompatible boundary, but it does not permit
automatic code-only rollback afterward; restore the recorded matching snapshot
before switching back.

Every status read, activation, rollback, and interrupted-transition recovery is
serialized by a kernel-owned `flock` held on an open descriptor. The kernel
releases the lock if the lifecycle process exits, so stale PID metadata and PID
reuse cannot block recovery. A durable transition journal is written before
either link changes. Status takes a shared lock and remains observational; it
fails clearly when a journal requires recovery. The next exclusive activation
or rollback restores the recorded pre-transition slots. Successful transitions
verify both final slots and remove only the exact journal inode they inspected,
so an interruption cannot discard the known-good rollback target.

The Dashboard executor still uses the in-place transition flow until the final
deploy integration performs the controlled systemd cutover to these links.
That cutover must set both units' stable state paths explicitly before changing
their working directories:

```ini
[Service]
Environment=MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard/backend/data/mira-dashboard.db
Environment=MIRA_DASHBOARD_OPENCLAW_HOME=/home/ubuntu/projects/mira-dashboard/backend/data/openclaw-client
```

The OpenClaw home value preserves the existing signed Gateway device identity
at
`backend/data/openclaw-client/.openclaw/identity/device.json`. Leaving it unset
would derive a different path below each SHA-specific working directory.

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
