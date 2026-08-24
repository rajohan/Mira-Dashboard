import {
    logMaintenancePolicyIds,
    type LogMaintenancePolicyId,
} from "../../contracts/logs.ts";
import type { FixedSystemLogrotateBroker } from "./fixedSystemLogrotateBroker.ts";
import type { ManagedLogRotationEngine } from "./managedLogRotation.ts";

export interface LogMaintenanceExecutor {
    readonly availablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
    readonly run: (
        policyId: LogMaintenancePolicyId,
        signal?: AbortSignal
    ) => Promise<void>;
}

function executionFailure(): Error {
    return new Error("Fixed log maintenance execution failed");
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
        async run(policyId: LogMaintenancePolicyId, signal?: AbortSignal) {
            try {
                if (signal?.aborted === true) throw executionFailure();
                if (policyId === "docker-managed") {
                    const result = await options.managed.run({ signal });
                    if (!result.ok) throw executionFailure();
                    return;
                }
                await options.system.run(policyId, signal);
            } catch {
                throw executionFailure();
            }
        },
    };
    return Object.freeze(executor);
}
