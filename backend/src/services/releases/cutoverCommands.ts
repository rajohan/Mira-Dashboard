import type { DeploymentJob } from "../../../../contracts/delivery.ts";
import { getMiraDatabasePath } from "../../database/connection.ts";
import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { resolveBunExecutable } from "../../lib/processes.ts";
import { JOB_WORKER_HEARTBEAT_MAX_AGE_MS } from "../jobExecutionQueue/repository.ts";
import { DASHBOARD_SERVICES } from "../pullRequests/config.ts";

const DEPLOYMENT_CUTOVER_HANDOFF_TIMEOUT_MS = 75_000;
export const DEPLOYMENT_WORKER_STABILITY_SECONDS =
    Math.ceil(JOB_WORKER_HEARTBEAT_MAX_AGE_MS / 1000) + 1;

export interface CommandResult {
    stdout: string;
    stderr: string;
}

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Builds a shell command that records deployment status from a detached process.
 * @returns Built a shell command that records deployment status from a detached process.
 */
export function deploymentJobUpdateCommand(job: DeploymentJob): string {
    const script = `
import { Database } from "bun:sqlite";
const job = {
    ...JSON.parse(process.env.MIRA_DEPLOYMENT_JOB || "{}"),
    updatedAt: new Date().toISOString(),
};
const database = new Database(process.env.MIRA_DEPLOYMENT_DB);
function sqlNullable(value) {
    return value === undefined ? null : value;
}
database.run("PRAGMA foreign_keys = ON");
database.run("PRAGMA busy_timeout = 5000");
try {
    database.run("BEGIN IMMEDIATE");
    database.prepare(\`
    INSERT INTO deployment_jobs (
        id,
        status,
        started_at,
        updated_at,
        commit_sha,
        commit_title,
        note,
        stdout,
        stderr
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        commit_sha = excluded.commit_sha,
        commit_title = excluded.commit_title,
        note = excluded.note,
        stdout = excluded.stdout,
        stderr = excluded.stderr
\`).run(
    job.id,
    job.status,
    job.startedAt,
    job.updatedAt,
    sqlNullable(job.commit ?? undefined),
    sqlNullable(job.commitTitle ?? undefined),
    sqlNullable(job.note ?? undefined),
    sqlNullable(job.stdout ?? undefined),
    sqlNullable(job.stderr ?? undefined)
);
    database.prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?").run(job.id);
    database.run("COMMIT");
} catch (error) {
    try {
        database.run("ROLLBACK");
    } catch {}
    throw error;
} finally {
    database.close();
}
`;
    return [
        `MIRA_DEPLOYMENT_DB=${shellQuote(getMiraDatabasePath())}`,
        `MIRA_DEPLOYMENT_JOB=${shellQuote(JSON.stringify(job))}`,
        shellQuote(resolveBunExecutable()),
        "-e",
        shellQuote(script),
    ].join(" ");
}

/**
 * Waits until the worker has durably completed the scheduling action. The
 * cutover snapshot must not capture a running execution that an older worker
 * would later recover as failed.
 * @param deploymentId Deployment identifier.
 * @param databaseSnapshotId Database snapshot identifier.
 * @returns Deployment cutover handoff command result.
 */
export function deploymentCutoverHandoffCommand(
    deploymentId: string,
    databaseSnapshotId: string
): string {
    const script = `
import { Database } from "bun:sqlite";
const database = new Database(process.env.MIRA_DEPLOYMENT_DB, { readonly: true });
database.run("PRAGMA busy_timeout = 5000");
const deadline = Date.now() + ${DEPLOYMENT_CUTOVER_HANDOFF_TIMEOUT_MS};
const readExecution = database.prepare(\`
    SELECT
        status,
        json_extract(output_json, '$.releaseCutover.databaseSnapshotId') AS database_snapshot_id,
        (SELECT status FROM deployment_jobs WHERE id = ?) AS deployment_status,
        (SELECT job_id FROM deployment_lock WHERE id = 1) AS lock_job_id
    FROM job_executions
    WHERE action_key = 'dashboard.deploy'
      AND json_valid(payload_json)
      AND json_valid(output_json)
      AND json_extract(payload_json, '$.deploymentId') = ?
    ORDER BY queued_at DESC, id DESC
    LIMIT 1
\`);
let isReady = false;
try {
    while (Date.now() < deadline) {
        const execution = readExecution.get(
            process.env.MIRA_DEPLOYMENT_ID,
            process.env.MIRA_DEPLOYMENT_ID
        );
        if (
            execution?.status === "success" &&
            execution.database_snapshot_id === process.env.MIRA_DEPLOYMENT_SNAPSHOT_ID &&
            execution.deployment_status === "verifying" &&
            execution.lock_job_id === process.env.MIRA_DEPLOYMENT_ID
        ) {
            isReady = true;
            break;
        }
        if (
            execution &&
            execution.status !== "queued" &&
            execution.status !== "running"
        ) {
            break;
        }
        await Bun.sleep(100);
    }
} finally {
    database.close();
}
if (!isReady) process.exitCode = 1;
`;
    return [
        `MIRA_DEPLOYMENT_DB=${shellQuote(getMiraDatabasePath())}`,
        `MIRA_DEPLOYMENT_ID=${shellQuote(deploymentId)}`,
        `MIRA_DEPLOYMENT_SNAPSHOT_ID=${shellQuote(databaseSnapshotId)}`,
        shellQuote(resolveBunExecutable()),
        "-e",
        shellQuote(script),
    ].join(" ");
}

export function releaseLifecycleInvocation(
    lifecycleCommand: string,
    bunExecutable: string
): string {
    return [
        `MIRA_DASHBOARD_PROJECT_ROOT=${shellQuote(
            resolveDashboardProjectPaths().projectRoot
        )}`,
        "NODE_ENV=production",
        shellQuote(bunExecutable),
        shellQuote(lifecycleCommand),
    ].join(" ");
}

export function releaseCutoverShellFunctions(): string[] {
    return [
        `project_root=${shellQuote(resolveDashboardProjectPaths().projectRoot)}`,
        "resolve_dashboard_port() {",
        '  dashboard_port=$(/usr/local/bin/doppler run --config prd --project rajohan -- /bin/sh -c \'printf "%s" "${PORT:-3100}"\' 2>/dev/null || true)',
        "  dashboard_port=\"$(printf \"%s\" \"$dashboard_port\" | /usr/bin/sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^0*//')\"",
        '  [ -n "$dashboard_port" ] || dashboard_port=0',
        '  case "$dashboard_port" in',
        "    *[!0-9]*) dashboard_port=3100 ;;",
        "  esac",
        "  if ((${#dashboard_port} > 5)); then",
        "    dashboard_port=3100",
        "  fi",
        "  if ((10#$dashboard_port < 1 || 10#$dashboard_port > 65535)); then",
        "    dashboard_port=3100",
        "  fi",
        '  printf "%s" "$dashboard_port"',
        "}",
        "resolve_release_bun() {",
        '  release_root="$1"',
        '  bun_version="$(/usr/bin/jq --exit-status --raw-output \'.bunVersion | select(type == "string" and length > 0 and length <= 64)\' "$release_root/release-manifest.json")" || return 1',
        String.raw`  [[ "$bun_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|([0-9]*[A-Za-z-][0-9A-Za-z-]*))(\.((0|[1-9][0-9]*)|([0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)$ ]] || return 1`,
        '  runtime_path="$project_root/production/runtimes/bun/$bun_version/bun"',
        '  [ -f "$runtime_path" ] && [ -x "$runtime_path" ] && [ ! -L "$runtime_path" ] || return 1',
        '  [ "$(/usr/bin/realpath --canonicalize-existing "$runtime_path")" = "$runtime_path" ] || return 1',
        '  [ "$(/usr/bin/stat --format=\'%h\' -- "$runtime_path")" = 1 ] || return 1',
        '  runtime_revision="$(/usr/bin/timeout --signal=KILL 5s "$runtime_path" --revision 2>/dev/null)" || return 1',
        '  [ "$runtime_revision" = "$bun_version" ] || return 1',
        '  printf "%s" "$runtime_path"',
        "}",
        "dashboard_listener_identity() {",
        '  local dashboard_port="$1"',
        "  local dashboard_properties dashboard_active dashboard_substate dashboard_cgroup dashboard_started",
        "  local listener_pids listener_pid listener_cgroup current_backend listener_backend",
        "  dashboard_properties=$(/usr/bin/systemctl --user show mira-dashboard.service --property=ActiveState --property=SubState --property=ControlGroup --property=ExecMainStartTimestampMonotonic --no-pager 2>/dev/null) || return 1",
        String.raw`  dashboard_active="$(printf "%s\n" "$dashboard_properties" | /usr/bin/sed -n 's/^ActiveState=//p')"`,
        String.raw`  dashboard_substate="$(printf "%s\n" "$dashboard_properties" | /usr/bin/sed -n 's/^SubState=//p')"`,
        String.raw`  dashboard_cgroup="$(printf "%s\n" "$dashboard_properties" | /usr/bin/sed -n 's/^ControlGroup=//p')"`,
        String.raw`  dashboard_started="$(printf "%s\n" "$dashboard_properties" | /usr/bin/sed -n 's/^ExecMainStartTimestampMonotonic=//p')"`,
        '  [ "$dashboard_active" = active ] || return 1',
        '  [ "$dashboard_substate" = running ] || return 1',
        '  case "$dashboard_cgroup" in',
        "    /*) ;;",
        "    *) return 1 ;;",
        "  esac",
        '  case "$dashboard_started" in',
        '    ""|0|*[!0-9]*) return 1 ;;',
        "  esac",
        "  listener_pids=$(/usr/bin/ss -H -ltnp \"sport = :$dashboard_port\" 2>/dev/null | /usr/bin/grep --only-matching 'pid=[0-9][0-9]*' | /usr/bin/cut --delimiter== --fields=2 | /usr/bin/sort --unique) || return 1",
        '  case "$listener_pids" in',
        String.raw`    ""|*$'\n'*|*[!0-9]*) return 1 ;;`,
        "  esac",
        '  listener_pid="$listener_pids"',
        "  listener_cgroup=$(/usr/bin/sed -n 's/^0:://p' \"/proc/$listener_pid/cgroup\" 2>/dev/null) || return 1",
        '  [ "$listener_cgroup" = "$dashboard_cgroup" ] || return 1',
        '  current_backend=$(/usr/bin/realpath --canonicalize-existing "$project_root/production/releases/current/backend" 2>/dev/null) || return 1',
        '  listener_backend=$(/usr/bin/readlink --canonicalize-existing "/proc/$listener_pid/cwd" 2>/dev/null) || return 1',
        '  [ "$listener_backend" = "$current_backend" ] || return 1',
        '  printf "%s:%s" "$listener_pid" "$dashboard_started"',
        "}",
        "worker_identity() {",
        "  worker_properties=$(/usr/bin/systemctl --user show mira-dashboard-worker.service --property=ActiveState --property=SubState --property=MainPID --property=ExecMainStartTimestampMonotonic --no-pager 2>/dev/null) || return 1",
        String.raw`  worker_active="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^ActiveState=//p')"`,
        String.raw`  worker_substate="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^SubState=//p')"`,
        String.raw`  worker_pid="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^MainPID=//p')"`,
        String.raw`  worker_started="$(printf "%s\n" "$worker_properties" | /usr/bin/sed -n 's/^ExecMainStartTimestampMonotonic=//p')"`,
        '  [ "$worker_active" = active ] || return 1',
        '  [ "$worker_substate" = running ] || return 1',
        '  case "$worker_pid:$worker_started" in',
        "    *[!0-9:]*|0:*|*:0|:*|*:) return 1 ;;",
        "  esac",
        '  printf "%s:%s" "$worker_pid" "$worker_started"',
        "}",
        "readiness_matches() {",
        '  expected_commit="$1"',
        '  current_release=$(/usr/bin/realpath --canonicalize-existing "$project_root/production/releases/current" 2>/dev/null) || return 1',
        '  current_commit=$(/usr/bin/jq --exit-status --raw-output \'.commitSha | select(type == "string" and length == 40)\' "$current_release/release-manifest.json" 2>/dev/null) || return 1',
        '  case "$current_commit" in "$expected_commit"*) ;; *) return 1 ;; esac',
        '  dashboard_port="$(resolve_dashboard_port)"',
        '  dashboard_identity_before="$(dashboard_listener_identity "$dashboard_port")" || return 1',
        '  response=$(/usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "http://127.0.0.1:${dashboard_port}/api/health/ready" 2>/dev/null || true)',
        '  dashboard_identity_after="$(dashboard_listener_identity "$dashboard_port")" || return 1',
        '  [ "$dashboard_identity_after" = "$dashboard_identity_before" ] || return 1',
        '  printf "%s" "$response" | /usr/bin/jq --exit-status \'.status == "isReady" and .checks.release.ready == true and .checks.worker.ready == true\' >/dev/null 2>&1',
        "}",
        "ready_for_commit() {",
        '  expected_commit="$1"',
        '  initial_dashboard_identity=""',
        '  initial_worker_identity=""',
        "  for attempt in {1..30}; do",
        '    if readiness_matches "$expected_commit"; then',
        '      dashboard_port="$(resolve_dashboard_port)"',
        '      initial_dashboard_identity="$(dashboard_listener_identity "$dashboard_port" || true)"',
        '      initial_worker_identity="$(worker_identity || true)"',
        '      [ -n "$initial_dashboard_identity" ] && [ -n "$initial_worker_identity" ] && break',
        "    fi",
        "    sleep 1",
        "  done",
        '  [ -n "$initial_dashboard_identity" ] || return 1',
        '  [ -n "$initial_worker_identity" ] || return 1',
        `  sleep ${DEPLOYMENT_WORKER_STABILITY_SECONDS}`,
        '  dashboard_port="$(resolve_dashboard_port)"',
        '  current_dashboard_identity="$(dashboard_listener_identity "$dashboard_port" || true)"',
        '  current_worker_identity="$(worker_identity || true)"',
        '  [ "$current_dashboard_identity" = "$initial_dashboard_identity" ] || return 1',
        '  [ "$current_worker_identity" = "$initial_worker_identity" ] || return 1',
        '  readiness_matches "$expected_commit"',
        "}",
        "restart_services() {",
        `  /usr/bin/systemctl --user restart ${DASHBOARD_SERVICES.join(" ")}`,
        "}",
        "stop_services() {",
        `  /usr/bin/systemctl --user stop ${DASHBOARD_SERVICES.join(" ")}`,
        "}",
    ];
}
