# Production Deploy

Production separates source control, immutable code, and persistent state:

```text
/home/ubuntu/projects/mira-dashboard/
├── production/
│   ├── checkout/
│   ├── releases/
│   ├── runtimes/
│   └── state/
└── development/
    ├── preview/
    ├── state/
    │   ├── local/
    │   └── preview/
    └── worktrees/
```

| Purpose                                           | Path                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Control checkout and deployment scripts           | `/home/ubuntu/projects/mira-dashboard/production/checkout`       |
| Temporary detached build worktrees                | `/home/ubuntu/projects/mira-dashboard/development/worktrees/`    |
| Shared managed PR-dev checkout                    | `/home/ubuntu/projects/mira-dashboard/development/preview`       |
| Managed PR-dev state and dependency cache         | `/home/ubuntu/projects/mira-dashboard/development/state/preview` |
| Immutable releases and `current`/`previous` links | `/home/ubuntu/projects/mira-dashboard/production/releases`       |
| Exact Bun runtimes declared by release manifests  | `/home/ubuntu/projects/mira-dashboard/production/runtimes/bun`   |
| Persistent production state                       | `/home/ubuntu/projects/mira-dashboard/production/state`          |

Web and worker execute from:

```text
/home/ubuntu/projects/mira-dashboard/production/releases/current/backend
```

`current` and `previous` are atomic relative symlinks to full-SHA directories
below `production/releases/releases/`. Production never builds in, writes to,
or executes backend code from the control checkout.

## Persistent State

Mutable state is deliberately outside both Git and every release:

| State                              | Stable path                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| SQLite database                    | `/home/ubuntu/projects/mira-dashboard/production/state/mira-dashboard.db` |
| SQLite WAL and shared-memory files | next to the database                                                      |
| Restore-verified SQLite backups    | `/home/ubuntu/projects/mira-dashboard/production/state/backups/`          |
| Dashboard Gateway device identity  | `/home/ubuntu/projects/mira-dashboard/production/state/openclaw-client/`  |
| Log-rotation lock                  | `/home/ubuntu/projects/mira-dashboard/production/state/log-rotation.lock` |

The backup directory is derived from the production state root, so cutover,
pre-deploy, and pre-migration snapshots automatically stay under the state
root.
Kopia mounts `/home/ubuntu/projects` as its projects source; the separate state
directory remains in that backup scope.

`backend/config/log-rotation.json` is not mutable state. It is versioned
application configuration, is listed in every release manifest, and is copied
and checksum-verified with the other immutable release artifacts.

Both managed units set one stable project root:

```text
MIRA_DASHBOARD_PROJECT_ROOT=/home/ubuntu/projects/mira-dashboard
```

The backend derives every production and development path in the layout above
from that root. The Doppler command preserves only the root and `NODE_ENV`, so
production secrets cannot replace unit-owned paths or runtime mode. The web and
worker entry points define orchestration policy directly; it is not configurable
through environment variables. Fine-grained path variables remain internal
development, test, and one-shot recovery contracts.

The OpenClaw home preserves the signed Gateway device identity across releases.
Secrets remain in Doppler `rajohan/prd`; tracked unit files contain no secret
values.

## Normal Deployment

The Dashboard worker owns the deployment:

1. Require a clean control checkout and fast-forward `main`.
2. Create a detached build worktree below
   `/home/ubuntu/projects/mira-dashboard/development/worktrees/`.
3. Install frozen frontend and backend dependencies.
4. Run `deploy:prepare` against the stable production database.
5. Verify the release manifest, component identities, schema contract, and
   every checksummed artifact, including the complete web/worker systemd unit
   bundle.
6. Copy only declared artifacts to a hidden directory and atomically publish
   it as `releases/<full-sha>`.
7. Persist a unique cutover-snapshot id and start a detached guardian.
8. Require the scheduling execution, snapshot id, deployment row, and release
   lock to be durably consistent. Then stop web and worker, create and
   restore-verify the exact SQLite cutover snapshot, reconcile changed tracked
   units into `~/.config/systemd/user`, run `systemctl --user daemon-reload`,
   verify both loaded fragment paths, and atomically switch `current` while
   retaining the old release as `previous`.
9. Start web and worker. Unsafe HTTP requests, explicit user-activity touches,
   Gateway WebSockets, and worker execution claims remain paused while the
   deployment row is `verifying`.
10. Require `/api/health/ready` to report the exact expected frontend/backend
    commit and a fresh, stable worker heartbeat from that commit.
11. On failure, stop both units, atomically restore the recorded database
    snapshot, restore the exact pre-activation release slots, restart both
    units, verify the old commit, and mark the deployment failed.
12. On success, retain `current`, `previous`, and one additional newest
    verified release, record the terminal result, then discard the one-cutover
    snapshot. Terminalizing first prevents a crash from leaving `verifying`
    without its rollback snapshot.

The executor fails closed unless both units use the expected project root and
run from managed `current/backend`. A deployment never modifies the running
release.

Release manifests record the exact Bun runtime used for both component builds.
Candidate install/build commands use the host bootstrap
`/home/ubuntu/.bun/bin/bun` (or the explicit
`MIRA_DASHBOARD_DEPLOY_BUN_EXECUTABLE` override), never the active worker's
release-specific runtime. Staging atomically caches that verified executable below
`production/runtimes/bun/<version>/bun`. The systemd launcher reads the active
manifest and starts web or worker with that exact cached runtime. Activation,
rollback, and failed-activation restoration all fail closed when a required
runtime is absent, malformed, noncanonical, or reports a different version.
This permits Bun major upgrades without assuming that a new major can execute
an older release: the candidate uses its new runtime while automatic rollback
keeps using the previous release's runtime.

Successful retention cleanup garbage-collects cached Bun runtimes only after
release pruning determines the final retained set. A runtime is removed only
when no retained release manifest references its identity; runtimes for
`current`, `previous`, and the newest additional verified release therefore
remain available for restart and rollback. Interrupted `.retired-*` runtime
cleanup is completed by the next prune, while missing runtimes for retained
releases fail the operation before an old release is removed.

Managed releases carry checksummed copies of
`systemd/mira-dashboard.service` and
`systemd/mira-dashboard-worker.service`. Activation, restore, and rollback
install a changed complete pair with mode `0644`, reload the user manager, and
verify that both units loaded from `~/.config/systemd/user`. If reconciliation
fails, the pre-operation files are restored before the release transition
returns an error. On a new VPS, `deploy:bootstrap` performs the first activation
and unit installation, then enables and starts both services. Ordinary
deployments thereafter update the installed unit definitions automatically.

The first rollout of this unit-bundle contract is manual and supervised because
its rollback release predates the bundle and is deliberately not special-cased
in the permanent lifecycle code. Preserve the installed units and use the
previous release lifecycle during recovery if that first cutover fails. After
the first successful release, later activation targets carry the bundle, but
the immediately previous pre-bundle slot remains manual-only until a second
bundled release rotates it out. Automatic rollback is fully available again
once both managed slots contain verified bundles.

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

Normal activation automatically rolls code and data back on restart or
commit-bound readiness failure before the cutover reaches a terminal state. The
preferred manual path is **Delivery → Production releases →
Roll back**, which uses the same exclusive release lock, persistent job,
detached guardian, web/worker restart, commit-bound readiness, and automatic
restoration of the original release if the rollback target fails.

A later manual rollback is intentionally code-only and remains constrained by
the live schema compatibility window. It never restores a pre-deploy snapshot
after a successful release, because doing so would discard writes accepted
after deployment.

Use the host-local fallback below only when the Dashboard UI is unavailable.
First confirm no deployment or rollback action is running:

```bash
set -euo pipefail
export MIRA_DASHBOARD_PROJECT_ROOT=/home/ubuntu/projects/mira-dashboard
RELEASES_ROOT="$MIRA_DASHBOARD_PROJECT_ROOT/production/releases"
DATABASE_PATH="$MIRA_DASHBOARD_PROJECT_ROOT/production/state/mira-dashboard.db"

assert_no_active_release_action() {
  local active_action
  active_action="$(
    sqlite3 -batch -noheader "$DATABASE_PATH" "
      SELECT action
      FROM (
        SELECT 'deployment_lock:' || job_id AS action
        FROM deployment_lock
        WHERE id = 1
        UNION ALL
        SELECT 'job_execution:' || id AS action
        FROM job_executions
        WHERE action_key IN ('dashboard.deploy', 'dashboard.rollback')
          AND status IN ('queued', 'running')
      )
      LIMIT 1;
    "
  )"
  if [[ -n "$active_action" ]]; then
    echo "Dashboard release action is already active ($active_action); aborting." >&2
    return 1
  fi
}

assert_no_active_release_action
CURRENT_RELEASE="$(
  readlink --canonicalize-existing "$RELEASES_ROOT/current"
)"
CURRENT_SHA="$(basename -- "$CURRENT_RELEASE")"
[[ "$CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$CURRENT_RELEASE" == "$RELEASES_ROOT/releases/$CURRENT_SHA" ]]
CURRENT_LIFECYCLE="$CURRENT_RELEASE/backend/dist/releaseLifecycle.js"
test -f "$CURRENT_LIFECYCLE"
test ! -L "$CURRENT_LIFECYCLE"
CURRENT_BUN_ID="$(
  jq --exit-status --raw-output '.bunVersion' \
    "$CURRENT_RELEASE/release-manifest.json"
)"
CURRENT_BUN="$MIRA_DASHBOARD_PROJECT_ROOT/production/runtimes/bun/$CURRENT_BUN_ID/bun"
test -f "$CURRENT_BUN"
test -x "$CURRENT_BUN"
test ! -L "$CURRENT_BUN"
[[ "$(realpath --canonicalize-existing "$CURRENT_BUN")" == "$CURRENT_BUN" ]]
[[ "$(stat --format='%h' -- "$CURRENT_BUN")" == "1" ]]
CURRENT_BUN_REVISION="$("$CURRENT_BUN" --revision)"
[[ "$CURRENT_BUN_REVISION" == "$CURRENT_BUN_ID" ]]
STATUS="$(
  env NODE_ENV=production \
    "$CURRENT_BUN" "$CURRENT_LIFECYCLE" status
)"
TARGET_SHA="$(jq --raw-output '.previous.commitSha // empty' <<<"$STATUS")"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$TARGET_SHA" != "$CURRENT_SHA" ]]

ready_for_commit() {
  local expected="${1:0:8}"
  local current_release
  local current_commit
  local response
  for attempt in {1..30}; do
    current_release="$(
      realpath --canonicalize-existing "$RELEASES_ROOT/current" 2>/dev/null || true
    )"
    current_commit="$(
      jq --exit-status --raw-output \
        '.commitSha | select(type == "string" and length == 40)' \
        "$current_release/release-manifest.json" 2>/dev/null || true
    )"
    [[ "$current_commit" == "$expected"* ]] || {
      sleep 1
      continue
    }
    response="$(
      curl --fail --silent --show-error \
        --connect-timeout 2 --max-time 5 \
        "http://127.0.0.1:${DASHBOARD_PORT:-3100}/api/health/ready" || true
    )"
    if jq --exit-status \
      '.status == "isReady"
       and .checks.release.ready == true
       and .checks.worker.ready == true' <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

assert_no_active_release_action
env NODE_ENV=production \
  "$CURRENT_BUN" "$CURRENT_LIFECYCLE" rollback "$CURRENT_SHA" "$TARGET_SHA"
systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
if ! ready_for_commit "$TARGET_SHA"; then
  echo "Rollback target failed readiness. Restoring $CURRENT_SHA" >&2
  env NODE_ENV=production \
    "$CURRENT_BUN" "$CURRENT_LIFECYCLE" rollback "$TARGET_SHA" "$CURRENT_SHA"
  systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
  ready_for_commit "$CURRENT_SHA"
  exit 1
fi
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

Build preflight snapshots prove that migrations are runnable, but managed
activation creates a separate `cutover` snapshot only after both Dashboard
writers are stopped. That exact snapshot id is persisted in the deployment
context so detached recovery cannot guess which backup belongs to the release.
During candidate verification, production mutations and worker execution claims
are paused. Failed activation restores data first and old code second.

After activation succeeds, code rollback and data rollback are separate
operator decisions. A later code rollback may use the migrated database only
when the older code is schema-compatible. Otherwise use the
[SQLite restore runbook](../operations/runbooks.md#restore-dashboard-sqlite)
with an explicitly selected backup and accept that it is a data-loss recovery.

### Schema Compatibility

The manifest range describes which live schema versions that release can open;
it does not describe a reversible SQL path. Classify every migration before
release:

- **expand/backward-compatible:** `previous` can safely use the migrated schema;
- **contract/incompatible:** older code cannot safely use the new schema or
  data semantics, so automatic code-only rollback is blocked.

Every managed deployment now uses the coordinated code-and-data cutover above,
including schema-compatible releases. An incompatible migration may therefore
cross the previous release's runtime window safely during initial activation:
failure restores the old schema snapshot before old code starts. Once the
candidate passes readiness, its cutover snapshot is discarded and the old
release is no longer a valid manual rollback target unless it can open the live
schema.

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
