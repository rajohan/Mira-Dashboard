import * as v from "valibot";

import { logMaintenancePolicyIds } from "./logMaintenanceUnits.ts";
import { nonnegativeSafeIntegerSchema } from "./validation.ts";

/** Fixed worker-owned availability projection entry beneath log-maintenance state. */
export const logMaintenanceAvailabilityProjectionFileName = "availability.json";
/** Maximum serialized projection size accepted across the worker/web boundary. */
export const logMaintenanceAvailabilityProjectionMaximumBytes = 2048;
/** Worker refresh cadence for the local availability heartbeat. */
export const logMaintenanceAvailabilityRefreshIntervalMs = 15_000;
/** Maximum projection age accepted by the web process. */
export const logMaintenanceAvailabilityMaximumAgeMs = 60_000;
/** Small same-host clock tolerance before a future projection fails closed. */
export const logMaintenanceAvailabilityFutureToleranceMs = 5000;

const policySchema = v.picklist(
    logMaintenancePolicyIds,
    "Log maintenance availability policy is invalid"
);

function policiesAreInContractOrder(
    policies: (typeof logMaintenancePolicyIds)[number][]
): boolean {
    const available = new Set(policies);
    return (
        available.size === policies.length &&
        logMaintenancePolicyIds
            .filter((policyId) => available.has(policyId))
            .every((policyId, index) => policies[index] === policyId)
    );
}

export const logMaintenanceAvailabilityProjectionSchema = v.strictObject({
    observedAtMs: nonnegativeSafeIntegerSchema(
        "Log maintenance availability timestamp is invalid"
    ),
    policies: v.pipe(
        v.array(policySchema, "Log maintenance availability policies are invalid"),
        v.maxLength(
            logMaintenancePolicyIds.length,
            "Log maintenance availability policies are outside their budget"
        ),
        v.check(
            policiesAreInContractOrder,
            "Log maintenance availability policies are not canonical"
        )
    ),
    version: v.literal(1, "Log maintenance availability version is invalid"),
});

export type LogMaintenanceAvailabilityProjection = v.InferOutput<
    typeof logMaintenanceAvailabilityProjectionSchema
>;
