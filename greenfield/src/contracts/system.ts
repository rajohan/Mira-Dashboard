import * as v from "valibot";

import type { ProcedureContract, RawHttpContract } from "./registry.ts";

/** Stable raw HTTP liveness endpoint shared by contracts and runtime dispatch. */
export const healthLivenessPath = "/api/health/live";
/** Stable raw HTTP readiness endpoint shared by contracts and runtime dispatch. */
export const healthReadinessPath = "/api/health/ready";

/** Empty object accepted by procedures without user input. */
export const emptyInputSchema = v.optional(v.strictObject({}), {});

const systemMetricByteCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const systemMetricPercentSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(100));
const systemMetricLoadSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(100_000));

function roundedCapacityPercent(usedBytes: number, totalBytes: number): number {
    return totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10;
}

/**
 * @param capacity - Capacity fields emitted by the sampler.
 * @returns Whether the bytes and rounded percentage describe one state.
 */
export function systemMetricCapacityIsConsistent(capacity: {
    freeBytes: number;
    totalBytes: number;
    usedBytes: number;
    usedPercent: number;
}): boolean {
    return (
        capacity.freeBytes <= capacity.totalBytes &&
        capacity.usedBytes === capacity.totalBytes - capacity.freeBytes &&
        capacity.usedPercent ===
            roundedCapacityPercent(capacity.usedBytes, capacity.totalBytes)
    );
}

/** Capacity projection with explicit byte and percentage units. */
export const systemMetricCapacitySchema = v.pipe(
    v.strictObject({
        freeBytes: systemMetricByteCountSchema,
        totalBytes: systemMetricByteCountSchema,
        usedBytes: systemMetricByteCountSchema,
        usedPercent: systemMetricPercentSchema,
    }),
    v.check(
        systemMetricCapacityIsConsistent,
        "System metric capacity fields are inconsistent"
    )
);

/** Bounded session-only host metrics returned to the operational overview. */
export const systemMetricsSchema = v.strictObject({
    cpu: v.strictObject({
        loadAverage: v.tuple([
            systemMetricLoadSchema,
            systemMetricLoadSchema,
            systemMetricLoadSchema,
        ]),
        loadPercent: v.pipe(systemMetricLoadSchema, v.maxValue(10_000)),
        logicalCoreCount: v.pipe(
            v.number(),
            v.safeInteger(),
            v.minValue(1),
            v.maxValue(8192)
        ),
    }),
    disk: systemMetricCapacitySchema,
    freshness: v.picklist(["fresh", "stale"]),
    memory: systemMetricCapacitySchema,
    network: v.strictObject({
        downloadBitsPerSecond: systemMetricByteCountSchema,
        state: v.picklist(["ready", "warming"]),
        uploadBitsPerSecond: systemMetricByteCountSchema,
    }),
    sampledAtMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    uptimeSeconds: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type SystemMetrics = v.InferOutput<typeof systemMetricsSchema>;

/** Public runtime identity returned by the system procedure. */
export const runtimeIdentitySchema = v.strictObject({
    revision: v.pipe(v.string(), v.description("Full Bun Git revision.")),
    version: v.pipe(v.string(), v.description("Bun semantic version.")),
    versionWithRevision: v.pipe(
        v.string(),
        v.description("Human-readable Bun version and short diagnostic revision.")
    ),
});

/** Liveness response returned while the Bun process can answer requests. */
export const livenessStatusSchema = v.strictObject({
    status: v.literal("live"),
});

/** Readiness response returned before and after critical initialization. */
export const readinessStatusSchema = v.strictObject({
    status: v.picklist(["not-ready", "ready"]),
});

/** Runtime identity contract shared by tRPC wiring and generated documentation. */
export const runtimeIdentityContract = {
    access: { kind: "public" },
    domain: "system",
    errors: [],
    input: emptyInputSchema,
    inputSchemaId: "system.runtimeIdentity.input",
    kind: "query",
    name: "system.runtimeIdentity",
    output: runtimeIdentitySchema,
    outputSchemaId: "system.runtimeIdentity.output",
    summary: "Returns the Bun runtime identity of the serving process.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Session-only metrics contract without automation authority or host identity. */
export const systemMetricsContract = {
    access: {
        capabilities: [],
        capabilityPolicy: "all",
        kind: "authenticated",
        principalKinds: ["session"],
    },
    domain: "system",
    errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    input: emptyInputSchema,
    inputSchemaId: "system.metrics.input",
    kind: "query",
    name: "system.metrics",
    output: systemMetricsSchema,
    outputSchemaId: "system.metrics.output",
    summary:
        "Returns bounded host gauges and throughput without host identity or control authority.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Implemented system tRPC contracts. */
export const systemProcedureContracts = [
    systemMetricsContract,
    runtimeIdentityContract,
] as const;

/** Implemented raw health-route contracts. */
export const systemRawHttpContracts = [
    {
        access: { kind: "public" },
        method: "GET",
        path: healthLivenessPath,
        response: {
            kind: "schema",
            schema: livenessStatusSchema,
            schemaId: "health.liveness.response",
        },
        statusCodes: [200],
        summary: "Confirms that the Bun web process can answer requests.",
    },
    {
        access: { kind: "public" },
        method: "HEAD",
        path: healthLivenessPath,
        response: { kind: "none" },
        statusCodes: [200],
        summary: "Checks Bun web-process liveness without a response body.",
    },
    {
        access: { kind: "public" },
        method: "GET",
        path: healthReadinessPath,
        response: {
            kind: "schema",
            schema: readinessStatusSchema,
            schemaId: "health.readiness.response",
        },
        statusCodes: [200, 503],
        summary: "Reports whether critical application initialization is complete.",
    },
    {
        access: { kind: "public" },
        method: "HEAD",
        path: healthReadinessPath,
        response: { kind: "none" },
        statusCodes: [200, 503],
        summary: "Checks application readiness without a response body.",
    },
] as const satisfies readonly RawHttpContract[];
