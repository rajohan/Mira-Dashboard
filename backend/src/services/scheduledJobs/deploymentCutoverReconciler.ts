import { database } from "../../database.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { parseSystemdProperties } from "../../lib/systemdProperties.ts";

const logger = createStructuredLogger("scheduled-jobs");
const RECONCILE_INTERVAL_MS = 5000;
const MAXIMUM_UNKNOWN_MS = 10 * 60 * 1000;
const FULL_RELEASE_COMMIT_PATTERN = /^[\da-f]{40}$/u;
const GUARDIAN_UNIT_PREFIX = "mira-dashboard-deploy-";
const RECOVERY_UNIT_PREFIX = "mira-dashboard-deploy-recovery-";

type DeploymentGuardianState = "active" | "inactive" | "unknown";
export type DeploymentGuardianStateReader = (
    jobId: string
) => DeploymentGuardianState;

export interface OrphanedDeploymentCutover {
    candidateCommit?: string;
    id: string;
    updatedAt: string;
}

export type DeploymentCutoverRecoveryHandler = (
    cutover: OrphanedDeploymentCutover
) => boolean;

type SystemdUnitState = DeploymentGuardianState | "missing";

function readSystemdUnitState(unit: string): SystemdUnitState {
    const result = Bun.spawnSync({
        cmd: [
            "systemctl",
            "--user",
            "show",
            unit,
            "--property=ActiveState",
            "--property=LoadState",
            "--no-pager",
        ],
        env: process.env,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (result.exitCode !== 0) {
        logger.warn("scheduled_jobs.systemd_unit_inspection_failed", {
            exitCode: result.exitCode,
            stderr,
            unit,
        });
        return "unknown";
    }
    if (stderr) {
        logger.warn("scheduled_jobs.systemd_unit_diagnostics", { stderr, unit });
    }
    const properties = parseSystemdProperties(
        new TextDecoder().decode(result.stdout).trim()
    );
    if (properties.get("LoadState") === "not-found") {
        return "missing";
    }
    if (properties.get("LoadState") !== "loaded") {
        return "unknown";
    }
    const state = properties.get("ActiveState");
    if (state && ["active", "activating", "deactivating", "reloading"].includes(state)) {
        return "active";
    }
    if (state && ["inactive", "failed"].includes(state)) {
        return "inactive";
    }
    return "unknown";
}

function readDeploymentGuardianState(jobId: string): DeploymentGuardianState {
    const guardian = readSystemdUnitState(`${GUARDIAN_UNIT_PREFIX}${jobId}.service`);
    if (guardian === "active") {
        return "active";
    }
    const recovery = readSystemdUnitState(`${RECOVERY_UNIT_PREFIX}${jobId}.service`);
    if (recovery === "active") {
        return "active";
    }
    if (guardian === "unknown" || recovery === "unknown") {
        return "unknown";
    }
    return "inactive";
}

function isReconciliationExpired(updatedAt: string, timestamp: string): boolean {
    const updatedAtMs = Date.parse(updatedAt);
    const timestampMs = Date.parse(timestamp);
    return (
        !Number.isFinite(updatedAtMs) ||
        !Number.isFinite(timestampMs) ||
        timestampMs - updatedAtMs >= MAXIMUM_UNKNOWN_MS
    );
}

function didTerminalizeUnrecoverableCutover(
    cutover: OrphanedDeploymentCutover,
    timestamp: string
): boolean {
    const terminalize = database.transaction(() => {
        const result = database
            .prepare(
                `UPDATE deployment_jobs
                 SET status = 'failed',
                     updated_at = ?,
                     note = ?
                 WHERE id = ?
                   AND status = 'verifying'`
            )
            .run(
                timestamp,
                "Interrupted deployment cutover cannot be recovered because it lacks a persisted full candidate SHA",
                cutover.id
            );
        if (result.changes === 0) {
            return false;
        }
        database
            .prepare("DELETE FROM deployment_lock WHERE id = 1 AND job_id = ?")
            .run(cutover.id);
        return true;
    });
    const didTerminalize = terminalize();
    if (didTerminalize) {
        logger.warn("scheduled_jobs.deployment_cutover_terminalized", {
            candidateCommit: cutover.candidateCommit,
            cutoverId: cutover.id,
        });
    }
    return didTerminalize;
}

/** Reconciles detached deployment cutovers and owns their recovery handler. */
export class DeploymentCutoverReconciler {
    #recoveryHandler: DeploymentCutoverRecoveryHandler | undefined;
    #missingRecoveryWarningKey: string | undefined;
    #nextReconcileAt = 0;

    reset(): void {
        this.#missingRecoveryWarningKey = undefined;
        this.#nextReconcileAt = 0;
    }

    registerRecoveryHandler(handler: DeploymentCutoverRecoveryHandler): void {
        this.#recoveryHandler = handler;
        this.#missingRecoveryWarningKey = undefined;
    }

    reconcile(
        timestamp = new Date().toISOString(),
        readGuardianState: DeploymentGuardianStateReader =
            readDeploymentGuardianState,
        ...recoveryHandlerOverride: [
            recoverCutover?: DeploymentCutoverRecoveryHandler,
        ]
    ): number {
        const recoverCutover =
            recoveryHandlerOverride.length === 0
                ? this.#recoveryHandler
                : recoveryHandlerOverride[0];
        const pendingRows = database
            .query(
                `SELECT id, commit_sha AS candidateCommit, updated_at AS updatedAt
                 FROM deployment_jobs
                 WHERE status = 'verifying'`
            )
            .all() as Array<{
            candidateCommit: string | null;
            id: string;
            updatedAt: string;
        }>;
        const pending: OrphanedDeploymentCutover[] = pendingRows.map((row) => ({
            ...(row.candidateCommit && { candidateCommit: row.candidateCommit }),
            id: row.id,
            updatedAt: row.updatedAt,
        }));
        let reconciled = 0;
        const cutoversMissingRecoveryHandler: string[] = [];
        for (const cutover of pending) {
            let state: DeploymentGuardianState = "unknown";
            try {
                state = readGuardianState(cutover.id);
            } catch (error) {
                logger.warn("scheduled_jobs.deployment_guardian_inspection_failed", {
                    cutoverId: cutover.id,
                    error,
                });
            }
            const shouldRecover =
                state === "inactive" ||
                (state === "unknown" &&
                    isReconciliationExpired(cutover.updatedAt, timestamp));
            if (!shouldRecover) {
                continue;
            }
            if (
                !cutover.candidateCommit ||
                !FULL_RELEASE_COMMIT_PATTERN.test(cutover.candidateCommit)
            ) {
                if (didTerminalizeUnrecoverableCutover(cutover, timestamp)) {
                    reconciled += 1;
                }
                continue;
            }
            if (!recoverCutover) {
                cutoversMissingRecoveryHandler.push(cutover.id);
                continue;
            }
            try {
                if (recoverCutover(cutover)) {
                    reconciled += 1;
                }
            } catch (error) {
                logger.warn("scheduled_jobs.orphaned_deployment_rollback_failed", {
                    cutoverId: cutover.id,
                    error,
                });
            }
        }
        const sortedMissingHandlerIds = cutoversMissingRecoveryHandler.toSorted(
            (left, right) => left.localeCompare(right)
        );
        const warningKey = sortedMissingHandlerIds.join(",");
        if (warningKey && this.#missingRecoveryWarningKey !== warningKey) {
            logger.warn("scheduled_jobs.deployment_recovery_handler_missing", {
                cutoverIds: sortedMissingHandlerIds,
            });
        }
        this.#missingRecoveryWarningKey = warningKey || undefined;
        return reconciled;
    }

    hasPending(): boolean {
        const now = Date.now();
        if (now >= this.#nextReconcileAt) {
            this.#nextReconcileAt = now + RECONCILE_INTERVAL_MS;
            const reconciled = this.reconcile();
            if (reconciled > 0) {
                logger.warn("scheduled_jobs.deployment_cutovers_reconciled", {
                    reconciled,
                });
            }
        }
        return Boolean(
            database
                .query(
                    `SELECT 1
                     FROM deployment_jobs
                     WHERE status = 'verifying'
                     LIMIT 1`
                )
                .get()
        );
    }
}
