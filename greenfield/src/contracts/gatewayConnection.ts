import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { nonnegativeSafeIntegerSchema } from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";

/** Sanitized process-transport phases safe for an authenticated browser session. */
export const gatewayConnectionPhases = [
    "connected",
    "connecting",
    "degraded",
    "stopped",
    "stopping",
] as const;

export type GatewayConnectionPhase = (typeof gatewayConnectionPhases)[number];

export const gatewayConnectionPhaseSchema = v.picklist(
    gatewayConnectionPhases,
    "Gateway connection phase is invalid"
);

export const gatewayConnectionFreshnessValues = [
    "fresh",
    "stale",
    "unavailable",
] as const;

export type GatewayConnectionFreshness =
    (typeof gatewayConnectionFreshnessValues)[number];

export const gatewayConnectionFreshnessSchema = v.picklist(
    gatewayConnectionFreshnessValues,
    "Gateway connection freshness is invalid"
);

/** Empty query input prevents callers from requesting upstream or secret-bearing fields. */
export const getGatewayConnectionInputSchema = v.strictObject({});

const gatewayConnectionTimestampSchema = timestampMillisecondsSchema(
    "Gateway connection timestamp is invalid"
);

const gatewayConnectionSnapshotObjectSchema = v.strictObject({
    checkedAtMs: gatewayConnectionTimestampSchema,
    connectedAtMs: v.optional(gatewayConnectionTimestampSchema),
    connectionGeneration: nonnegativeSafeIntegerSchema(
        "Gateway connection generation is invalid"
    ),
    freshness: gatewayConnectionFreshnessSchema,
    lastActivityAtMs: v.optional(gatewayConnectionTimestampSchema),
    lastDisconnectedAtMs: v.optional(gatewayConnectionTimestampSchema),
    nextReconnectAtMs: v.optional(gatewayConnectionTimestampSchema),
    phase: gatewayConnectionPhaseSchema,
    reconnectAttempt: nonnegativeSafeIntegerSchema(
        "Gateway reconnect attempt is invalid"
    ),
});

export type GatewayConnectionSnapshot = v.InferOutput<
    typeof gatewayConnectionSnapshotObjectSchema
>;

/** @returns Whether phase, freshness, and past observation timestamps agree. */
export function gatewayConnectionSnapshotIsConsistent(
    snapshot: GatewayConnectionSnapshot
): boolean {
    const isConnected = snapshot.phase === "connected";
    if ((snapshot.freshness === "fresh") !== isConnected) return false;
    if (isConnected && snapshot.connectedAtMs === undefined) return false;
    return [
        snapshot.connectedAtMs,
        snapshot.lastActivityAtMs,
        snapshot.lastDisconnectedAtMs,
    ].every((timestamp) => timestamp === undefined || timestamp <= snapshot.checkedAtMs);
}

/** Current non-secret native Gateway transport state and explicit freshness. */
export const getGatewayConnectionResultSchema = v.pipe(
    gatewayConnectionSnapshotObjectSchema,
    v.check(
        gatewayConnectionSnapshotIsConsistent,
        "Gateway connection snapshot is inconsistent"
    )
);

/** Implemented session-only native Gateway connection snapshot metadata. */
export const gatewayConnectionProcedureContracts = [
    {
        access: {
            capabilities: ["gateway-sessions:read"],
            capabilityPolicy: "all",
            kind: "authenticated",
            principalKinds: ["session"],
        },
        domain: "gateway",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getGatewayConnectionInputSchema,
        inputSchemaId: "gateway.connection.get.input",
        kind: "query",
        name: "gateway.connection.get",
        output: getGatewayConnectionResultSchema,
        outputSchemaId: "gateway.connection.get.output",
        summary:
            "Returns the sanitized process-owned native Gateway connection phase and freshness.",
        transport: {
            batching: "adapter-default",
            handler: "default",
            requestBody: "default",
        },
    },
] as const satisfies readonly ProcedureContract[];
