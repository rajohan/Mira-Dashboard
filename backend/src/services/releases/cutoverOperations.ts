import path from "node:path";

import type { DeploymentJob } from "../../../../contracts/delivery/deployments.ts";
import { resolveBunExecutable } from "../../lib/processes.ts";
import {
    RELEASE_READINESS_FAILURE_NOTE_PREFIX,
    ROLLBACK_READINESS_FAILURE_NOTE_PREFIX,
} from "../deploymentRuntimeResults.ts";
import { type DeploymentCutoverContext } from "../pullRequests/deploymentCutoverContext.ts";
import { runCommand } from "../pullRequests/githubCommandClient.ts";
import { dateToISOString, FULL_COMMIT_SHA_PATTERN } from "../pullRequests/support.ts";
import {
    deploymentCutoverHandoffCommand,
    deploymentJobUpdateCommand,
    DEPLOYMENT_WORKER_STABILITY_SECONDS,
    type CommandResult,
    releaseCutoverShellFunctions,
    releaseLifecycleInvocation,
    shellQuote,
} from "./cutoverCommands.ts";
import {
    assertManagedDashboardUnitProperties,
    MANAGED_DASHBOARD_UNITS,
    managedDashboardUnitContract,
} from "./deployment.ts";
import { installManagedBunRuntime } from "./managedRuntimeStore.ts";
import type { ManagedDashboardRelease } from "./managerModel.ts";
import { loadManagedRelease, resolveDashboardReleasesRoot } from "./releaseLayout.ts";
import { hasManagedBunRuntime, requireManagedBunRuntime } from "./runtime.ts";
import { assertDashboardReleaseRuntimeAvailable } from "./schemaCompatibility.ts";

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
