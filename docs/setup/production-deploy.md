# Production Deploy

Production separates source control, immutable code, and persistent state:

| Purpose                                           | Path                                              |
| ------------------------------------------------- | ------------------------------------------------- |
| Control checkout and deployment scripts           | `/home/ubuntu/projects/mira-dashboard`            |
| Temporary detached build worktrees                | `/home/ubuntu/projects/mira-dashboard-worktrees/` |
| Immutable releases and `current`/`previous` links | `/home/ubuntu/projects/mira-dashboard-releases`   |
| Persistent production state                       | `/home/ubuntu/projects/mira-dashboard-state`      |

Web and worker execute from:

```text
/home/ubuntu/projects/mira-dashboard-releases/current/backend
```

`current` and `previous` are atomic relative symlinks to full-SHA directories
below `mira-dashboard-releases/releases/`. Production never builds in, writes
to, or executes backend code from the control checkout.

## Persistent State

Mutable state is deliberately outside both Git and every release:

| State                              | Stable path                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| SQLite database                    | `/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db` |
| SQLite WAL and shared-memory files | next to the database                                           |
| Restore-verified SQLite backups    | `/home/ubuntu/projects/mira-dashboard-state/backups/`          |
| Dashboard Gateway device identity  | `/home/ubuntu/projects/mira-dashboard-state/openclaw-client/`  |
| Log-rotation lock                  | `/home/ubuntu/projects/mira-dashboard-state/log-rotation.lock` |

The backup directory is derived from `dirname(MIRA_DASHBOARD_DB_PATH)`, so
pre-deploy and pre-migration snapshots automatically stay under the state root.
Kopia mounts `/home/ubuntu/projects` as its projects source; the separate state
directory remains in that backup scope.

`backend/config/log-rotation.json` is not mutable state. It is versioned
application configuration, is listed in every release manifest, and is copied
and checksum-verified with the other immutable release artifacts.

Both managed units set the stable paths explicitly:

```text
MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db
MIRA_DASHBOARD_OPENCLAW_HOME=/home/ubuntu/projects/mira-dashboard-state/openclaw-client
MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE=/home/ubuntu/projects/mira-dashboard-state/log-rotation.lock
MIRA_DASHBOARD_RELEASE_ROOT=/home/ubuntu/projects/mira-dashboard-releases/current
MIRA_DASHBOARD_RELEASES_ROOT=/home/ubuntu/projects/mira-dashboard-releases
```

Their Doppler command selectively preserves these five values plus `NODE_ENV`,
`MIRA_DASHBOARD_EXECUTION_ROLE`, `MIRA_DASHBOARD_ENABLE_JOB_SCOPES`, and
`MIRA_DASHBOARD_JOB_SCOPE_OWNER`, so production secrets cannot replace
unit-owned state, release paths, or orchestration policy.

The OpenClaw home preserves the signed Gateway device identity across releases.
Secrets remain in Doppler `rajohan/prd`; tracked unit files contain no secret
values.

## Normal Deployment

The Dashboard worker owns the deployment:

1. Require a clean control checkout and fast-forward `main`.
2. Create a detached build worktree below
   `/home/ubuntu/projects/mira-dashboard-worktrees/`.
3. Install frozen frontend and backend dependencies.
4. Run `deploy:prepare` against the stable production database.
5. Verify the release manifest, component identities, schema contract, and
   every checksummed artifact.
6. Copy only declared artifacts to a hidden directory and atomically publish
   it as `releases/<full-sha>`.
7. Start a detached cutover guardian, which atomically switches `current` and
   retains the old release as `previous`.
8. Restart web and worker from inside that guardian.
9. Require `/api/health/ready` to report the exact expected frontend/backend
   commit and a fresh worker heartbeat from that commit.
10. On failure, switch back to `previous`, restart both units, verify the old
    commit, and mark the deployment failed.
11. On success, retain `current`, `previous`, and one additional newest
    verified release.

The executor fails closed unless both units already run from managed
`current/backend` with the exact stable state paths. A deployment never modifies
the running release.

## One-Time Managed Cutover

Run this once immediately after the atomic-executor change has been merged into
the control checkout. Do **not** use the old in-place deploy executor for this
change. The old services stay online while the merged control-checkout scripts
stage the managed releases. The Jobs queue must be idle. PR #333 is the
known-good format-2 bootstrap release.

### 1. Stage both releases while the old services remain online

The existing database is still below the control checkout during this step.
Staging is read-safe and creates a restore-verified pre-deploy backup.
Run all four cutover sections in the same interactive shell so the validated
path and commit variables remain available.

```bash
cd /home/ubuntu/projects/mira-dashboard
git switch main
git pull --ff-only origin main

RELEASES_ROOT=/home/ubuntu/projects/mira-dashboard-releases
OLD_STATE_ROOT=/home/ubuntu/projects/mira-dashboard/backend/data
STATE_ROOT=/home/ubuntu/projects/mira-dashboard-state
OLD_DATABASE_PATH="$OLD_STATE_ROOT/mira-dashboard.db"
OLD_OPENCLAW_CLIENT_HOME="$OLD_STATE_ROOT/openclaw-client"
OLD_LOG_ROTATION_LOCK="$OLD_STATE_ROOT/log-rotation.lock"
DATABASE_PATH="$STATE_ROOT/mira-dashboard.db"
OPENCLAW_CLIENT_HOME="$STATE_ROOT/openclaw-client"
LOG_ROTATION_LOCK="$STATE_ROOT/log-rotation.lock"
BOOTSTRAP_SHA=4aca68e0cffed68c42a630c4221e11e725ab294b
CANDIDATE_SHA="$(git rev-parse HEAD)"
DASHBOARD_PORT="$(
  /usr/local/bin/doppler run --config prd --project rajohan -- \
    /bin/sh -c 'printf "%s" "${PORT:-3100}"'
)"
DASHBOARD_PORT="$(
  printf '%s' "$DASHBOARD_PORT" |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
)"
if ! [[ "$DASHBOARD_PORT" =~ ^[0-9]+$ ]] ||
  (( DASHBOARD_PORT < 1 || DASHBOARD_PORT > 65535 )); then
  DASHBOARD_PORT=3100
fi

env \
  MIRA_DASHBOARD_DB_PATH="$OLD_DATABASE_PATH" \
  MIRA_DASHBOARD_OPENCLAW_HOME="$OLD_OPENCLAW_CLIENT_HOME" \
  MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE="$OLD_LOG_ROTATION_LOCK" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun backend/src/releaseDeployment.ts stage "$BOOTSTRAP_SHA"
env \
  MIRA_DASHBOARD_DB_PATH="$OLD_DATABASE_PATH" \
  MIRA_DASHBOARD_OPENCLAW_HOME="$OLD_OPENCLAW_CLIENT_HOME" \
  MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE="$OLD_LOG_ROTATION_LOCK" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun backend/src/releaseDeployment.ts stage "$CANDIDATE_SHA"
```

### 2. Stop both units and atomically move persistent state

Keep copies of the installed pre-cutover units for the recovery procedure.
Both source and destination are below `/home/ubuntu/projects`, so `mv` is a
same-filesystem directory rename rather than a live database copy.

```bash
CUTOVER_UNIT_BACKUP="$(mktemp -d)"
cp --preserve=mode,timestamps \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service \
  "$CUTOVER_UNIT_BACKUP/mira-dashboard.service"
cp --preserve=mode,timestamps \
  /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service \
  "$CUTOVER_UNIT_BACKUP/mira-dashboard-worker.service"

systemctl --user stop mira-dashboard-worker.service mira-dashboard.service
test -d "$OLD_STATE_ROOT"
test ! -e "$STATE_ROOT"
mv --no-target-directory "$OLD_STATE_ROOT" "$STATE_ROOT"
test -f "$DATABASE_PATH"
```

Do not leave a compatibility symlink at `backend/data`. Production units use
the new absolute paths and development retains its normal local `backend/data`
default.

### 3. Activate the bootstrap and install managed units

```bash
env \
  MIRA_DASHBOARD_DB_PATH="$DATABASE_PATH" \
  MIRA_DASHBOARD_OPENCLAW_HOME="$OPENCLAW_CLIENT_HOME" \
  MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE="$LOG_ROTATION_LOCK" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun backend/src/releaseLifecycle.ts activate "$BOOTSTRAP_SHA"

install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
install -m 0644 systemd/mira-dashboard-worker.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
systemctl --user daemon-reload
systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
```

Use a commit-bound readiness function; exhausting the loop is a failure:

```bash
worker_identity() {
  local properties active substate pid started
  properties="$(
    systemctl --user show mira-dashboard-worker.service \
      --property=ActiveState \
      --property=SubState \
      --property=MainPID \
      --property=ExecMainStartTimestampMonotonic \
      --no-pager 2>/dev/null
  )" || return 1
  active="$(sed -n 's/^ActiveState=//p' <<<"$properties")"
  substate="$(sed -n 's/^SubState=//p' <<<"$properties")"
  pid="$(sed -n 's/^MainPID=//p' <<<"$properties")"
  started="$(sed -n 's/^ExecMainStartTimestampMonotonic=//p' <<<"$properties")"
  [[ "$active" == active && "$substate" == running ]] || return 1
  [[ "$pid:$started" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]] || return 1
  printf '%s:%s' "$pid" "$started"
}

readiness_matches() {
  local expected="$1"
  local response
  response="$(curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    "http://127.0.0.1:${DASHBOARD_PORT}/api/health/ready" || true)"
  jq --exit-status --arg expected "$expected" \
    '.status == "isReady"
     and .checks.release.ready == true
     and .checks.release.backendCommit == $expected
     and .checks.release.frontendCommit == $expected
     and .checks.worker.ready == true' <<<"$response" >/dev/null
}

ready_for_commit() {
  local full_sha="$1"
  local expected="${full_sha:0:8}"
  local initial_worker_identity current_worker_identity
  initial_worker_identity=""
  for attempt in {1..30}; do
    if readiness_matches "$expected"; then
      initial_worker_identity="$(worker_identity || true)"
      [[ -n "$initial_worker_identity" ]] && break
    fi
    sleep 1
  done
  [[ -n "$initial_worker_identity" ]] || return 1
  sleep 31
  current_worker_identity="$(worker_identity || true)"
  [[ "$current_worker_identity" == "$initial_worker_identity" ]] || return 1
  readiness_matches "$expected"
}

recover_legacy_deployment() {
  systemctl --user stop \
    mira-dashboard-worker.service mira-dashboard.service || return 1
  install -m 0644 "$CUTOVER_UNIT_BACKUP/mira-dashboard.service" \
    /home/ubuntu/.config/systemd/user/mira-dashboard.service || return 1
  install -m 0644 "$CUTOVER_UNIT_BACKUP/mira-dashboard-worker.service" \
    /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service || return 1
  mv --no-target-directory "$STATE_ROOT" "$OLD_STATE_ROOT" || return 1
  systemctl --user daemon-reload || return 1
  systemctl --user restart \
    mira-dashboard-worker.service mira-dashboard.service
}

if ! ready_for_commit "$BOOTSTRAP_SHA"; then
  echo "Bootstrap readiness failed; restoring the legacy deployment" >&2
  if ! recover_legacy_deployment; then
    echo "Legacy deployment recovery also failed; manual recovery is required" >&2
  fi
  exit 1
fi
```

Any failed bootstrap check now runs recovery and exits nonzero. Investigate
before retrying; never continue to candidate activation after this branch.

### 4. Activate and verify the candidate

```bash
if ! env \
  MIRA_DASHBOARD_DB_PATH="$DATABASE_PATH" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun "$RELEASES_ROOT/releases/$BOOTSTRAP_SHA/backend/dist/releaseLifecycle.js" \
  activate "$CANDIDATE_SHA"; then
  echo "Candidate activation failed; bootstrap remains active" >&2
  exit 1
fi
systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
```

```bash
if ! ready_for_commit "$CANDIDATE_SHA"; then
  echo "Candidate readiness failed; rolling back to bootstrap" >&2
  if ! env \
    MIRA_DASHBOARD_DB_PATH="$DATABASE_PATH" \
    MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
    NODE_ENV=production \
    bun "$RELEASES_ROOT/releases/$BOOTSTRAP_SHA/backend/dist/releaseLifecycle.js" \
    rollback; then
    echo "Candidate rollback failed; manual recovery is required" >&2
    exit 1
  fi
  systemctl --user restart \
    mira-dashboard-worker.service mira-dashboard.service
  if ! ready_for_commit "$BOOTSTRAP_SHA"; then
    echo "Bootstrap was restored but did not become ready" >&2
    exit 1
  fi
  echo "Bootstrap restored; investigate candidate failure before retrying" >&2
  exit 1
fi
```

The failure branch always exits nonzero, including after a verified rollback.
After a successful candidate check:

```bash
env \
  MIRA_DASHBOARD_DB_PATH="$DATABASE_PATH" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun "$RELEASES_ROOT/current/backend/dist/releaseLifecycle.js" prune 3
gio trash -- "$CUTOVER_UNIT_BACKUP"
```

## Restart And Smoke Test

Normal deploys schedule their own restart. For manual recovery, first confirm
no action is running, then:

```bash
systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status mira-dashboard-worker.service --no-pager
journalctl --user -u mira-dashboard.service -n 120 --no-pager
journalctl --user -u mira-dashboard-worker.service -n 120 --no-pager
curl --fail --silent --show-error \
  "http://127.0.0.1:${DASHBOARD_PORT:-3100}/api/health/ready" | jq
```

Direct loopback is transport, not authentication. Tokenless protected API calls
must still return `401`.

## Rollback

Normal activation automatically rolls back on restart or commit-bound readiness
failure. Manual rollback is a failure-only operation:

```bash
set -euo pipefail
RELEASES_ROOT=/home/ubuntu/projects/mira-dashboard-releases
DATABASE_PATH=/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db
PREVIOUS_RELEASE="$(
  readlink --canonicalize-existing "$RELEASES_ROOT/previous"
)"
PREVIOUS_SHA="$(basename -- "$PREVIOUS_RELEASE")"
[[ "$PREVIOUS_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$PREVIOUS_RELEASE" == "$RELEASES_ROOT/releases/$PREVIOUS_SHA" ]]
PREVIOUS_LIFECYCLE="$PREVIOUS_RELEASE/backend/dist/releaseLifecycle.js"
test -f "$PREVIOUS_LIFECYCLE"
test ! -L "$PREVIOUS_LIFECYCLE"
env MIRA_DASHBOARD_DB_PATH="$DATABASE_PATH" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun "$PREVIOUS_LIFECYCLE" status
env MIRA_DASHBOARD_DB_PATH="$DATABASE_PATH" \
  MIRA_DASHBOARD_RELEASES_ROOT="$RELEASES_ROOT" \
  NODE_ENV=production \
  bun "$PREVIOUS_LIFECYCLE" rollback
systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
curl --fail --silent --show-error \
  "http://127.0.0.1:${DASHBOARD_PORT:-3100}/api/health/ready" | jq
```

Git reset and rebuilding in the control checkout are not production rollback
mechanisms.

## SQLite Deploy Lifecycle

SQLite schema changes are numbered, immutable migrations recorded in
`schema_migrations`. Build/deploy preflight:

1. requires the live database to be in WAL mode;
2. rejects unknown versions, gaps, names, or checksum drift;
3. creates a WAL-consistent `pre-deploy` backup with `VACUUM INTO`;
4. restores that snapshot in isolation, requires `PRAGMA quick_check = ok`,
   validates history, and applies pending migrations to the disposable copy;
5. applies bounded backup retention.

On restart, web and worker independently validate history. `BEGIN IMMEDIATE`
serializes pending migrations. The process holding the writer lock creates a
separate restore-verified `pre-migration` backup before running migration SQL.

Do not copy only the main `.db` file while Dashboard is running. WAL mode may
hold committed writes in the `-wal` sidecar until a checkpoint.

Code rollback and data rollback are separate decisions. A code rollback may use
the migrated database only when the older code is schema-compatible. Otherwise
stop both units and restore the matching snapshot using the
[SQLite restore runbook](../operations/runbooks.md#restore-dashboard-sqlite).

### Schema Compatibility

Classify every migration before release:

- **expand/backward-compatible:** `previous` can safely use the migrated schema;
- **contract/incompatible:** older code cannot safely use the new schema or
  data semantics, so automatic code-only rollback is blocked.

Prefer expand/migrate/contract across separate releases. If an incompatible
change cannot be phased, use a coordinated code-and-data cutover:

1. require an idle execution queue;
2. stop both units;
3. rerun candidate preflight and record its fresh verified snapshot;
4. activate with `--coordinated-schema-cutover`;
5. start both units and require commit/schema readiness;
6. on failure, stop both units, restore the recorded snapshot, switch code back,
   and only then restart.

The migration runner has no destructive down-migration path. Unknown newer
migrations make older code fail closed.

## Release Manifest Contract

`bun run deploy:prepare` builds frontend and backend, performs verified SQLite
preflight, and writes `release-manifest.json`. Format version 2 is the only
supported release format. It records:

- full/short Git identity, title, build time, and Bun version;
- matching frontend/backend build identities;
- target and compatible SQLite schema range;
- immutable migration identities and registry/inventory digests;
- SHA-256 and byte length for every frontend/backend artifact, package
  manifest, Bun lockfile, and `backend/config/log-rotation.json`.

Manifest creation and verification reject absolute/traversal paths, symlinks,
hard-linked files, special files, unsorted/duplicate inventories, checksum
drift, and undeclared runtime artifacts. Runtime readiness requires the embedded
backend commit, both build identities, and manifest to agree.

Release link transitions use a kernel-owned `flock`, atomic same-directory
symlink replacement, directory fsync, and a durable recovery journal. Every
status read, activation, rollback, and interrupted-transition recovery verifies
the managed release and live schema contract.

## Health Signals

- `GET /api/health/live` proves the web process can answer.
- `GET /api/health/ready` requires a valid release identity, compatible
  accessible SQLite schema, built frontend, and a fresh worker heartbeat from
  the exact release commit. It returns HTTP 503 with `status: "notReady"` when
  an activation check fails.
- `GET /api/health/diagnostics` adds the authenticated readiness breakdown and
  session count.

There is no legacy `/health` or `/api/health` route. Production activation and
automatic rollback use `/api/health/ready`.

Gateway connectivity is reported as an external dependency but does not fail
release readiness: rolling Dashboard code back cannot repair a Gateway outage.

Important failures:

- `dependencies.gatewayConnected: false`: check Gateway service and token.
- `checks.worker.ready: false`: inspect worker heartbeat and both unit logs.
- HTTP `503 Frontend Not Built`: the release is incomplete and must not activate.
- `Unauthorized`: inspect Dashboard session or scoped automation credentials.
- `database is locked`: wait for background work, then inspect both service
  logs; production requires WAL mode and uses a five-second busy timeout.
