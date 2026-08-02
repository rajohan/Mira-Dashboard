import type { DeploymentJob } from "../../../../contracts/delivery.ts";
import { ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX } from "../deploymentRuntimeResults.ts";
import { getDashboardRoot } from "../pullRequests/config.ts";
import {
    parseDeploymentCutoverContext,
    readDeploymentJob,
    readDeploymentLockExecution,
    writeDeploymentJob,
} from "../pullRequests/deploymentRepository.ts";
import { buildCommandEnvironment } from "../pullRequests/githubCommandClient.ts";
import { dateToISOString, FULL_COMMIT_SHA_PATTERN } from "../pullRequests/support.ts";
import { type OrphanedDeploymentCutover } from "../scheduledJobs/deploymentCutoverReconciler.ts";
import {
    deploymentJobUpdateCommand,
    DEPLOYMENT_WORKER_STABILITY_SECONDS,
    releaseCutoverShellFunctions,
    shellQuote,
} from "./cutoverCommands.ts";
import { resolveDashboardReleasesRoot } from "./releaseLayout.ts";

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
