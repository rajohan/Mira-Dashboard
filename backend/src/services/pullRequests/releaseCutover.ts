import path from "node:path";

import type { DeploymentJob } from "../../../../contracts/delivery.ts";
import { getMiraDatabasePath } from "../../database.ts";
import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { resolveBunExecutable } from "../../lib/processes.ts";
import {
    hasManagedBunRuntime,
    installManagedBunRuntime,
    requireManagedBunRuntime,
} from "../../managedBunRuntime.ts";
import {
    assertManagedDashboardUnitProperties,
    MANAGED_DASHBOARD_UNITS,
    managedDashboardUnitContract,
} from "../../releaseDeployment.ts";
import {
    assertDashboardReleaseRuntimeAvailable,
    loadManagedRelease,
    type ManagedDashboardRelease,
    resolveDashboardReleasesRoot,
} from "../../releaseManager.ts";
import {
    ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX,
    RELEASE_READINESS_FAILURE_NOTE_PREFIX,
    ROLLBACK_READINESS_FAILURE_NOTE_PREFIX,
} from "../deploymentRuntimeResults.ts";
import { JOB_WORKER_HEARTBEAT_MAX_AGE_MS } from "../jobExecutionQueue.ts";
import type { OrphanedDeploymentCutover } from "../scheduledJobs.ts";
import { DASHBOARD_SERVICES, getDashboardRoot } from "./config.ts";
import {
    type DeploymentCutoverContext,
    parseDeploymentCutoverContext,
    readDeploymentJob,
    readDeploymentLockExecution,
    writeDeploymentJob,
} from "./deploymentRepository.ts";
import { buildCommandEnvironment, runCommand } from "./githubClient.ts";
import { dateToISOString, FULL_COMMIT_SHA_PATTERN } from "./support.ts";

const DEPLOYMENT_CUTOVER_HANDOFF_TIMEOUT_MS = 75_000;
export const DEPLOYMENT_WORKER_STABILITY_SECONDS =
    Math.ceil(JOB_WORKER_HEARTBEAT_MAX_AGE_MS / 1000) + 1;

interface CommandResult {
    stdout: string;
    stderr: string;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Builds a shell command that records deployment status from a detached process.
 * @returns Built a shell command that records deployment status from a detached process.
 */
function deploymentJobUpdateCommand(job: DeploymentJob): string {
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
function deploymentCutoverHandoffCommand(
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

function releaseLifecycleInvocation(
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

function releaseCutoverShellFunctions(): string[] {
    return [
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

export async function assertManagedDashboardServiceContract(
    signal?: AbortSignal
): Promise<void> {
    const contract = managedDashboardUnitContract();
    for (const unit of Object.keys(MANAGED_DASHBOARD_UNITS) as Array<
        keyof typeof MANAGED_DASHBOARD_UNITS
    >) {
        const { stdout } = await runCommand(
            "systemctl",
            [
                "--user",
                "show",
                unit,
                "--property=Environment",
                "--property=ExecStart",
                "--property=WorkingDirectory",
            ],
            { signal, timeoutMs: 30_000 }
        );
        assertManagedDashboardUnitProperties(unit, stdout, contract);
    }
}

export async function ensureManagedRuntimeForRelease(
    release: ManagedDashboardRelease,
    sourceExecutable = resolveBunExecutable()
): Promise<void> {
    if (!hasManagedBunRuntime(release.manifest.bunVersion)) {
        await installManagedBunRuntime(sourceExecutable, release.manifest.bunVersion);
    }
    assertDashboardReleaseRuntimeAvailable(release);
}

/**
 * Schedules detached service restart, commit-bound readiness, and rollback.
 * @returns Promise resolving to the schedule release cutover result.
 */
export async function scheduleReleaseCutover(
    job: DeploymentJob,
    cutover: DeploymentCutoverContext,
    signal?: AbortSignal
): Promise<CommandResult> {
    const {
        candidateCommit,
        databaseSnapshotId,
        preActivationCommit,
        preActivationPreviousCommit,
        rollbackCommit,
    } = cutover;
    if (!job.commit || !FULL_COMMIT_SHA_PATTERN.test(job.commit)) {
        throw new TypeError("Release cutover requires a full candidate commit");
    }
    if (
        !FULL_COMMIT_SHA_PATTERN.test(candidateCommit) ||
        candidateCommit !== job.commit
    ) {
        throw new TypeError("Release cutover requires the matching full candidate SHA");
    }
    if (!FULL_COMMIT_SHA_PATTERN.test(preActivationCommit)) {
        throw new TypeError("Release cutover requires a full pre-activation commit");
    }
    if (
        rollbackCommit === candidateCommit ||
        !FULL_COMMIT_SHA_PATTERN.test(rollbackCommit)
    ) {
        throw new TypeError("Release cutover requires a distinct full rollback commit");
    }
    if (
        preActivationPreviousCommit !== undefined &&
        (preActivationPreviousCommit === preActivationCommit ||
            !FULL_COMMIT_SHA_PATTERN.test(preActivationPreviousCommit))
    ) {
        throw new TypeError(
            "Release cutover requires a distinct full pre-activation previous SHA"
        );
    }
    const isNewActivation = candidateCommit !== preActivationCommit;
    if (isNewActivation && rollbackCommit !== preActivationCommit) {
        throw new TypeError(
            "New release cutover requires the pre-activation current release as rollback target"
        );
    }
    const releasesRoot = resolveDashboardReleasesRoot();
    const candidateRelease = await loadManagedRelease(releasesRoot, candidateCommit);
    assertDashboardReleaseRuntimeAvailable(candidateRelease);
    const candidateBunExecutable = requireManagedBunRuntime(
        candidateRelease.manifest.bunVersion
    );
    const guardedLifecycleCommand = path.join(
        releasesRoot,
        "releases",
        candidateCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const guardedLifecycleEnvironment = releaseLifecycleInvocation(
        guardedLifecycleCommand,
        candidateBunExecutable
    );
    const snapshotCommand = `${guardedLifecycleEnvironment} snapshot-database ${shellQuote(databaseSnapshotId)}`;
    const restoreDatabaseCommand = `${guardedLifecycleEnvironment} restore-database ${shellQuote(databaseSnapshotId)}`;
    const discardSnapshotCommand = `${guardedLifecycleEnvironment} discard-database-snapshot ${shellQuote(databaseSnapshotId)}`;
    const waitForHandoffCommand = deploymentCutoverHandoffCommand(
        job.id,
        databaseSnapshotId
    );
    const restoreCommand = isNewActivation
        ? [
              guardedLifecycleEnvironment,
              "restore",
              shellQuote(candidateCommit),
              shellQuote(rollbackCommit),
              ...(preActivationPreviousCommit
                  ? [shellQuote(preActivationPreviousCommit)]
                  : []),
          ].join(" ")
        : `${guardedLifecycleEnvironment} rollback ${shellQuote(candidateCommit)} ${shellQuote(rollbackCommit)}`;
    const activationFailureRestoreCommand = isNewActivation
        ? `${restoreDatabaseCommand} && ${restoreCommand}`
        : restoreDatabaseCommand;
    const candidateShort = candidateCommit.slice(0, 8);
    const rollbackShort = rollbackCommit.slice(0, 8);
    const okJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: `Atomic release activated. Web, worker, commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability checks passed`,
    };
    const okWithRetentionWarningJob: DeploymentJob = {
        ...okJob,
        note: `Atomic release activated and verified, including ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability; release retention cleanup failed`,
    };
    const rolledBackJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: isNewActivation
            ? `${RELEASE_READINESS_FAILURE_NOTE_PREFIX}; automatic rollback restored the exact pre-deploy release slots with ${rollbackShort} active`
            : `${RELEASE_READINESS_FAILURE_NOTE_PREFIX}; automatic rollback activated the previous verified release ${rollbackShort}`,
    };
    const rollbackFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `${RELEASE_READINESS_FAILURE_NOTE_PREFIX} and automatic rollback to ${rollbackShort} failed`,
    };
    const activationFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation failed before restart; the exact pre-cutover database and original release were restored",
    };
    const snapshotFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation stopped before restart because the guarded database snapshot failed; original services were restored",
    };
    const cutoverStartFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation could not stop every Dashboard service safely; original services were restored",
    };
    const handoffFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Release activation stopped before service shutdown because the worker handoff did not become durable",
    };

    const script = [
        ...releaseCutoverShellFunctions(),
        `${waitForHandoffCommand} || { ${deploymentJobUpdateCommand(handoffFailedJob)}; exit 1; }`,
        "if stop_services; then",
        `  if ${snapshotCommand}; then`,
        `    if ${guardedLifecycleEnvironment} activate ${shellQuote(candidateCommit)} --coordinated-schema-cutover; then`,
        `      if restart_services && ready_for_commit ${shellQuote(candidateShort)}; then`,
        `        if ${guardedLifecycleEnvironment} prune 3; then`,
        `          ${deploymentJobUpdateCommand(okJob)} || exit 1`,
        "        else",
        `          ${deploymentJobUpdateCommand(okWithRetentionWarningJob)} || exit 1`,
        "        fi",
        `        ${discardSnapshotCommand} >/dev/null 2>&1 || true`,
        "      else",
        `        if stop_services && ${restoreDatabaseCommand} && ${restoreCommand} && restart_services && ready_for_commit ${shellQuote(rollbackShort)}; then`,
        `          ${deploymentJobUpdateCommand(rolledBackJob)} || exit 1`,
        `          ${discardSnapshotCommand} >/dev/null 2>&1 || true`,
        "        else",
        `          ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "        fi",
        "      fi",
        "    else",
        `      if ${activationFailureRestoreCommand} && restart_services && ready_for_commit ${shellQuote(preActivationCommit.slice(0, 8))}; then`,
        `        ${deploymentJobUpdateCommand(activationFailedJob)} || exit 1`,
        `        ${discardSnapshotCommand} >/dev/null 2>&1 || true`,
        "      else",
        `        ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "      fi",
        "    fi",
        "  else",
        `    if restart_services && ready_for_commit ${shellQuote(preActivationCommit.slice(0, 8))}; then`,
        `      ${deploymentJobUpdateCommand(snapshotFailedJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "    fi",
        "  fi",
        "else",
        `  if restart_services && ready_for_commit ${shellQuote(preActivationCommit.slice(0, 8))}; then`,
        `    ${deploymentJobUpdateCommand(cutoverStartFailedJob)}`,
        "  else",
        `    ${deploymentJobUpdateCommand(rollbackFailedJob)}`,
        "  fi",
        "fi",
    ].join("\n");

    return runCommand(
        "systemd-run",
        [
            "--user",
            "--collect",
            "--expand-environment=no",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard atomic release cutover",
            "/bin/bash",
            "-lc",
            script,
        ],
        { signal, timeoutMs: 30_000 }
    );
}

/**
 * Schedules a detached current/previous swap with readiness-bound restoration.
 * @returns Promise resolving to the schedule release rollback result.
 */
export async function scheduleReleaseRollback(
    job: DeploymentJob,
    targetCommit: string,
    originalCommit: string,
    signal?: AbortSignal
): Promise<CommandResult> {
    if (
        !job.commit ||
        !FULL_COMMIT_SHA_PATTERN.test(job.commit) ||
        job.commit !== targetCommit
    ) {
        throw new TypeError("Release rollback requires its matching full target SHA");
    }
    if (
        originalCommit === targetCommit ||
        !FULL_COMMIT_SHA_PATTERN.test(originalCommit)
    ) {
        throw new TypeError(
            "Release rollback requires a distinct full original release SHA"
        );
    }

    const releasesRoot = resolveDashboardReleasesRoot();
    const originalRelease = await loadManagedRelease(releasesRoot, originalCommit);
    assertDashboardReleaseRuntimeAvailable(originalRelease);
    const originalBunExecutable = requireManagedBunRuntime(
        originalRelease.manifest.bunVersion
    );
    const lifecycleCommand = path.join(
        releasesRoot,
        "releases",
        originalCommit,
        "backend",
        "dist",
        "releaseLifecycle.js"
    );
    const lifecycleEnvironment = releaseLifecycleInvocation(
        lifecycleCommand,
        originalBunExecutable
    );
    const targetShort = targetCommit.slice(0, 8);
    const originalShort = originalCommit.slice(0, 8);
    const okJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: `Atomic rollback activated ${targetShort}. Web, worker, commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability checks passed`,
    };
    const restoredJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `${ROLLBACK_READINESS_FAILURE_NOTE_PREFIX}. Original release ${originalShort} was restored automatically`,
    };
    const restorationFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: `${ROLLBACK_READINESS_FAILURE_NOTE_PREFIX} and restoration of ${originalShort} failed`,
    };
    const transitionFailedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Atomic rollback failed before restart. Current release was left unchanged",
    };

    const script = [
        "sleep 2",
        ...releaseCutoverShellFunctions(),
        `if ${lifecycleEnvironment} rollback ${shellQuote(originalCommit)} ${shellQuote(targetCommit)}; then`,
        `  if restart_services && ready_for_commit ${shellQuote(targetShort)}; then`,
        `    ${deploymentJobUpdateCommand(okJob)}`,
        "  else",
        `    if ${lifecycleEnvironment} rollback ${shellQuote(targetCommit)} ${shellQuote(originalCommit)} && restart_services && ready_for_commit ${shellQuote(originalShort)}; then`,
        `      ${deploymentJobUpdateCommand(restoredJob)}`,
        "    else",
        `      ${deploymentJobUpdateCommand(restorationFailedJob)}`,
        "    fi",
        "  fi",
        "else",
        `  ${deploymentJobUpdateCommand(transitionFailedJob)}`,
        "fi",
    ].join("\n");

    return runCommand(
        "systemd-run",
        [
            "--user",
            "--collect",
            "--expand-environment=no",
            `--unit=mira-dashboard-deploy-${job.id}`,
            "--description=Mira Dashboard atomic release rollback",
            "/bin/bash",
            "-lc",
            script,
        ],
        { signal, timeoutMs: 30_000 }
    );
}

export function didScheduleOrphanedReleaseCutoverRecovery(
    cutover: OrphanedDeploymentCutover
): boolean {
    const job = readDeploymentJob(cutover.id);
    if (!job || job.status !== "verifying") {
        return false;
    }
    const candidateCommit = cutover.candidateCommit ?? job.commit;
    if (
        !candidateCommit ||
        !FULL_COMMIT_SHA_PATTERN.test(candidateCommit) ||
        job.commit !== candidateCommit
    ) {
        throw new Error(
            "Orphaned release cutover recovery requires its persisted full candidate SHA"
        );
    }

    const releasesRoot = resolveDashboardReleasesRoot();
    const recoveryExecution = readDeploymentLockExecution(cutover.id);
    const isRollbackAction = recoveryExecution?.action_key === "dashboard.rollback";
    const persistedCutover =
        recoveryExecution?.action_key === "dashboard.deploy"
            ? parseDeploymentCutoverContext(
                  recoveryExecution.output_json,
                  cutover.id,
                  candidateCommit
              )
            : undefined;
    const willRestoreExactPreActivationSlots =
        persistedCutover !== undefined &&
        persistedCutover.candidateCommit !== persistedCutover.preActivationCommit;
    let recoveryMode: "candidate-rollback" | "restore" | "rollback" =
        persistedCutover || isRollbackAction ? "rollback" : "candidate-rollback";
    if (willRestoreExactPreActivationSlots) {
        recoveryMode = "restore";
    }
    const rolledBackJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: willRestoreExactPreActivationSlots
            ? `${ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX} the exact pre-deploy release slots`
            : `${ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX} the previous verified release`,
    };
    const activationNotAppliedJob: DeploymentJob = {
        ...job,
        status: "failed",
        updatedAt: dateToISOString(new Date()),
        note: "Interrupted release cutover recovered before candidate activation; current verified release remains ready",
    };
    const activeCandidateRecoveredJob: DeploymentJob = {
        ...job,
        status: "isOk",
        updatedAt: dateToISOString(new Date()),
        note: `Interrupted release cutover recovered; active candidate passed restart, commit-bound readiness, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS}-second worker stability`,
    };
    const script = [
        "sleep 1",
        ...releaseCutoverShellFunctions(),
        `project_root=${shellQuote(resolveDashboardProjectPaths().projectRoot)}`,
        `releases_root=${shellQuote(releasesRoot)}`,
        `candidate_commit=${shellQuote(candidateCommit)}`,
        `database_snapshot_id=${shellQuote(persistedCutover?.databaseSnapshotId ?? "")}`,
        `recovery_mode=${shellQuote(recoveryMode)}`,
        `expected_rollback_commit=${shellQuote(persistedCutover?.rollbackCommit ?? "")}`,
        `pre_activation_previous_commit=${shellQuote(
            persistedCutover?.preActivationPreviousCommit ?? ""
        )}`,
        "resolve_trusted_lifecycles() {",
        '  candidate_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/releases/$candidate_commit") || return 1',
        '  [ "$candidate_release" = "$releases_root/releases/$candidate_commit" ] || return 1',
        '  candidate_lifecycle="$candidate_release/backend/dist/releaseLifecycle.js"',
        '  [ -f "$candidate_lifecycle" ] && [ ! -L "$candidate_lifecycle" ] || return 1',
        '  candidate_bun_executable="$(resolve_release_bun "$candidate_release")" || return 1',
        '  current_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/current") || return 1',
        '  current_commit="$(/usr/bin/basename -- "$current_release")"',
        '  [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || return 1',
        '  [ "$current_release" = "$releases_root/releases/$current_commit" ] || return 1',
        '  if [ "$current_commit" = "$candidate_commit" ]; then',
        '    if [ -e "$releases_root/previous" ] || [ -L "$releases_root/previous" ]; then',
        '      activation_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/previous") || return 1',
        "    else",
        '      activation_release="$candidate_release"',
        "    fi",
        "  else",
        '    activation_release="$current_release"',
        "  fi",
        '  activation_commit="$(/usr/bin/basename -- "$activation_release")"',
        '  [[ "$activation_commit" =~ ^[0-9a-f]{40}$ ]] || return 1',
        '  [ "$activation_release" = "$releases_root/releases/$activation_commit" ] || return 1',
        '  activation_lifecycle="$activation_release/backend/dist/releaseLifecycle.js"',
        '  [ -f "$activation_lifecycle" ] && [ ! -L "$activation_lifecycle" ] || return 1',
        '  activation_bun_executable="$(resolve_release_bun "$activation_release")" || return 1',
        "}",
        "run_activation_lifecycle() {",
        '  MIRA_DASHBOARD_PROJECT_ROOT="$project_root" \\',
        "  NODE_ENV=production \\",
        '  "$activation_bun_executable" "$activation_lifecycle" "$@"',
        "}",
        "run_candidate_lifecycle() {",
        '  MIRA_DASHBOARD_PROJECT_ROOT="$project_root" \\',
        "  NODE_ENV=production \\",
        '  "$candidate_bun_executable" "$candidate_lifecycle" "$@"',
        "}",
        "restore_failed_candidate() {",
        '  case "$recovery_mode" in',
        "    restore)",
        '      [ "$rollback_commit" = "$expected_rollback_commit" ] || return 1',
        '      if [ -n "$pre_activation_previous_commit" ]; then',
        '        run_candidate_lifecycle restore "$candidate_commit" "$rollback_commit" "$pre_activation_previous_commit"',
        "      else",
        '        run_candidate_lifecycle restore "$candidate_commit" "$rollback_commit"',
        "      fi",
        "      ;;",
        "    rollback)",
        '      run_activation_lifecycle rollback "$candidate_commit" "$rollback_commit"',
        "      ;;",
        "    candidate-rollback)",
        '      run_candidate_lifecycle rollback "$candidate_commit" "$rollback_commit"',
        "      ;;",
        "    *) return 1 ;;",
        "  esac",
        "}",
        "resolve_trusted_lifecycles || exit 1",
        'if [ -n "$database_snapshot_id" ]; then',
        '  if ! run_candidate_lifecycle verify-database-snapshot "$database_snapshot_id" >/dev/null; then',
        '    [ "$current_commit" != "$candidate_commit" ] || exit 1',
        '    if restart_services && ready_for_commit "${current_commit:0:8}"; then',
        `      ${deploymentJobUpdateCommand(activationNotAppliedJob)}`,
        "      exit 0",
        "    fi",
        "    exit 1",
        "  fi",
        "  stop_services || exit 1",
        '  if activation_output="$(run_candidate_lifecycle activate "$candidate_commit" --coordinated-schema-cutover)"; then',
        '    activation_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '    [ "$activation_commit" = "$candidate_commit" ] || exit 1',
        '    if restart_services && ready_for_commit "${candidate_commit:0:8}"; then',
        `      ${deploymentJobUpdateCommand(activeCandidateRecoveredJob)} || exit 1`,
        '      run_candidate_lifecycle discard-database-snapshot "$database_snapshot_id" >/dev/null 2>&1 || true',
        "      exit 0",
        "    fi",
        '    rollback_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.previous.commitSha // empty\')"',
        '    [[ "$rollback_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '    [ "$rollback_commit" != "$candidate_commit" ] || exit 1',
        '    if stop_services && run_candidate_lifecycle restore-database "$database_snapshot_id" && restore_failed_candidate && restart_services && ready_for_commit "${rollback_commit:0:8}"; then',
        `      ${deploymentJobUpdateCommand(rolledBackJob)} || exit 1`,
        '      run_candidate_lifecycle discard-database-snapshot "$database_snapshot_id" >/dev/null 2>&1 || true',
        "    else",
        "      exit 1",
        "    fi",
        "  else",
        '    if run_candidate_lifecycle restore-database "$database_snapshot_id"; then',
        '      status_output="$(run_candidate_lifecycle status)" || exit 1',
        '      current_commit="$(printf "%s" "$status_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '      [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '      [ "$current_commit" != "$candidate_commit" ] || exit 1',
        '      if restart_services && ready_for_commit "${current_commit:0:8}"; then',
        `        ${deploymentJobUpdateCommand(activationNotAppliedJob)} || exit 1`,
        '        run_candidate_lifecycle discard-database-snapshot "$database_snapshot_id" >/dev/null 2>&1 || true',
        "        exit 0",
        "      fi",
        "    fi",
        "    exit 1",
        "  fi",
        'elif activation_output="$(run_activation_lifecycle activate "$candidate_commit")"; then',
        '  activation_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '  [ "$activation_commit" = "$candidate_commit" ] || exit 1',
        '  if restart_services && ready_for_commit "${candidate_commit:0:8}"; then',
        `    ${deploymentJobUpdateCommand(activeCandidateRecoveredJob)}`,
        "    exit 0",
        "  fi",
        '  rollback_commit="$(printf "%s" "$activation_output" | /usr/bin/jq --raw-output \'.previous.commitSha // empty\')"',
        '  [[ "$rollback_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '  [ "$rollback_commit" != "$candidate_commit" ] || exit 1',
        '  if restore_failed_candidate && restart_services && ready_for_commit "${rollback_commit:0:8}"; then',
        `    ${deploymentJobUpdateCommand(rolledBackJob)}`,
        "  else",
        "    exit 1",
        "  fi",
        "else",
        '  status_output="$(run_activation_lifecycle status)" || exit 1',
        '  current_commit="$(printf "%s" "$status_output" | /usr/bin/jq --raw-output \'.current.commitSha // empty\')"',
        '  [[ "$current_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1',
        '  [ "$current_commit" != "$candidate_commit" ] || exit 1',
        '  if ready_for_commit "${current_commit:0:8}" || { restart_services && ready_for_commit "${current_commit:0:8}"; }; then',
        `    ${deploymentJobUpdateCommand(activationNotAppliedJob)}`,
        "  else",
        "    exit 1",
        "  fi",
        "fi",
    ].join("\n");

    writeDeploymentJob({
        ...job,
        updatedAt: dateToISOString(new Date()),
        note: "Detached release guardian ended without a terminal result; automatic rollback recovery scheduled",
    });
    const result = Bun.spawnSync({
        cmd: [
            "systemd-run",
            "--user",
            "--collect",
            "--expand-environment=no",
            `--unit=mira-dashboard-deploy-recovery-${job.id}`,
            "--description=Mira Dashboard orphaned release rollback",
            "/bin/bash",
            "-lc",
            script,
        ],
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    if (result.exitCode !== 0) {
        const diagnostic =
            new TextDecoder().decode(result.stderr).trim() ||
            new TextDecoder().decode(result.stdout).trim();
        throw new Error(
            `systemd-run failed to schedule orphaned release rollback: ${
                diagnostic || `exit ${result.exitCode}`
            }`
        );
    }
    return true;
}

/**
 * Runs deployment work after the API has returned a job to the caller.
 * @returns Promise resolving to the run deployment job result.
 */
