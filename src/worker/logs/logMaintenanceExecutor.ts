import {
    logMaintenancePolicyIds,
    type LogMaintenanceExecutionSummary,
    type LogMaintenancePolicyId,
} from "../../contracts/logs.ts";
import type { FixedSystemLogrotateBroker } from "./fixedSystemLogrotateBroker.ts";
import type {
    ManagedLogRotationEngine,
    ManagedLogRotationSummary,
} from "./managedLogRotation.ts";

export interface LogMaintenanceExecutor {
    readonly availablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
    readonly run: (
        policyId: LogMaintenancePolicyId,
        dryRun: boolean,
        signal?: AbortSignal
    ) => Promise<LogMaintenanceExecutionSummary | undefined>;
}

function executionFailure(): Error {
    return new Error("Fixed log maintenance execution failed");
}

function projectManagedSummary(
    summary: ManagedLogRotationSummary
): LogMaintenanceExecutionSummary {
    const actionCounts: LogMaintenanceExecutionSummary["actionCounts"] = {
        compressed: 0,
        deleted: 0,
        error: 0,
        missing: 0,
        rotated: 0,
        skipped: 0,
    };
    for (const { action } of summary.results) {
        actionCounts[action] += 1;
    }
    return Object.freeze({
        actionCounts: Object.freeze(actionCounts),
        checkedTargets: summary.checkedTargets,
        dryRun: summary.dryRun,
        finishedAtMs: summary.finishedAtMs,
        ok: summary.ok,
        startedAtMs: summary.startedAtMs,
    });
}

/**
 * Worker-only dispatch: custom managed rotation owns application/container logs;
 * system logrotate receives only one of four fixed Ubuntu host policy ids.
 * @param options Fixed custom-engine and system-broker authorities.
 * @returns One policy-id-only worker execution boundary.
 */
export function createLogMaintenanceExecutor(options: {
    readonly managed: ManagedLogRotationEngine;
    readonly system: FixedSystemLogrotateBroker;
}): LogMaintenanceExecutor {
    const executor: LogMaintenanceExecutor = {
        async availablePolicies(signal?: AbortSignal) {
            if (signal?.aborted === true) throw executionFailure();
            const [managed, system] = await Promise.all([
                options.managed
                    .status()
                    .then(() => ["docker-managed" as const])
                    .catch(() => []),
                options.system.availablePolicies(signal).catch(() => []),
            ]);
            const available = new Set<LogMaintenancePolicyId>([...managed, ...system]);
            return logMaintenancePolicyIds.filter((policyId) => available.has(policyId));
        },
        async run(
            policyId: LogMaintenancePolicyId,
            dryRun: boolean,
            signal?: AbortSignal
        ) {
            try {
                if (signal?.aborted === true) throw executionFailure();
                if (policyId === "docker-managed") {
                    await options.system.ensureManagedAccess(signal);
                    const result = await options.managed.run({ dryRun, signal });
                    if (!result.ok) throw executionFailure();
                    return projectManagedSummary(result);
                }
                if (dryRun) throw executionFailure();
                await options.system.run(policyId, signal);
                return;
            } catch {
                throw executionFailure();
            }
        },
    };
    return Object.freeze(executor);
}
