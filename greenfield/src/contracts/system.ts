import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { nonnegativeSafeIntegerSchema } from "../shared/validation.ts";
import {
    gatewayConnectionFreshnessSchema,
    gatewayConnectionPhaseSchema,
} from "./gatewayConnection.ts";
import { gatewaySessionProjectionMaximum } from "./gatewaySessions.ts";
import { jobWorkerCapacityMaximum, jobWorkerSummaryMaximum } from "./jobLimits.ts";
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

const systemHealthDiagnosticsTimestampSchema = timestampMillisecondsSchema(
    "System health diagnostics timestamp is invalid"
);
const systemHealthDiagnosticsCountSchema = nonnegativeSafeIntegerSchema(
    "System health diagnostics count is invalid"
);

/** Sanitized process-owned Gateway state, with provider failures made explicit. */
const systemHealthDiagnosticsGatewayVariantSchema = v.variant("status", [
    v.strictObject({
        freshness: gatewayConnectionFreshnessSchema,
        phase: gatewayConnectionPhaseSchema,
        status: v.literal("observed"),
    }),
    v.strictObject({ status: v.literal("unavailable") }),
]);

/** @returns Whether connected phase and fresh state agree. */
export function systemHealthDiagnosticsGatewayIsConsistent(
    gateway: v.InferOutput<typeof systemHealthDiagnosticsGatewayVariantSchema>
): boolean {
    return (
        gateway.status === "unavailable" ||
        (gateway.freshness === "fresh") === (gateway.phase === "connected")
    );
}

export const systemHealthDiagnosticsGatewaySchema = v.pipe(
    systemHealthDiagnosticsGatewayVariantSchema,
    v.check(
        systemHealthDiagnosticsGatewayIsConsistent,
        "System health Gateway projection is inconsistent"
    )
);

/** Identity-free cached Gateway-session count with explicit source freshness. */
const systemHealthDiagnosticsSessionsVariantSchema = v.variant("state", [
    v.strictObject({ state: v.literal("unavailable") }),
    v.strictObject({
        count: v.pipe(
            systemHealthDiagnosticsCountSchema,
            v.maxValue(
                gatewaySessionProjectionMaximum,
                "System health session count is outside its budget"
            )
        ),
        observedAtMs: systemHealthDiagnosticsTimestampSchema,
        state: v.literal("fresh"),
        truncated: v.boolean(),
    }),
    v.strictObject({
        count: v.pipe(
            systemHealthDiagnosticsCountSchema,
            v.maxValue(
                gatewaySessionProjectionMaximum,
                "System health session count is outside its budget"
            )
        ),
        observedAtMs: systemHealthDiagnosticsTimestampSchema,
        staleSinceMs: systemHealthDiagnosticsTimestampSchema,
        state: v.literal("last-known-good"),
        truncated: v.boolean(),
    }),
]);

/** @returns Whether last-known-good session timestamps remain ordered. */
export function systemHealthDiagnosticsSessionsAreConsistent(
    sessions: v.InferOutput<typeof systemHealthDiagnosticsSessionsVariantSchema>
): boolean {
    return (
        sessions.state !== "last-known-good" ||
        sessions.staleSinceMs >= sessions.observedAtMs
    );
}

export const systemHealthDiagnosticsSessionsSchema = v.pipe(
    systemHealthDiagnosticsSessionsVariantSchema,
    v.check(
        systemHealthDiagnosticsSessionsAreConsistent,
        "System health session projection is inconsistent"
    )
);

const systemHealthDiagnosticsWorkerCountSchema = v.pipe(
    systemHealthDiagnosticsCountSchema,
    v.maxValue(
        jobWorkerSummaryMaximum,
        "System health worker count is outside its budget"
    )
);
const systemHealthDiagnosticsWorkerCapacitySchema = v.pipe(
    systemHealthDiagnosticsCountSchema,
    v.maxValue(
        jobWorkerSummaryMaximum * jobWorkerCapacityMaximum,
        "System health worker capacity is outside its budget"
    )
);

const systemHealthDiagnosticsWorkersObjectSchema = v.strictObject({
    capacity: systemHealthDiagnosticsWorkerCapacitySchema,
    drainingCount: systemHealthDiagnosticsWorkerCountSchema,
    freshCount: systemHealthDiagnosticsWorkerCountSchema,
    onlineCount: systemHealthDiagnosticsWorkerCountSchema,
});

/** @returns Whether the fresh worker count matches its lifecycle partitions. */
export function systemHealthDiagnosticsWorkersAreConsistent(
    workers: v.InferOutput<typeof systemHealthDiagnosticsWorkersObjectSchema>
): boolean {
    const maximumCapacity = workers.freshCount * jobWorkerCapacityMaximum;
    return (
        workers.freshCount === workers.drainingCount + workers.onlineCount &&
        workers.capacity >= workers.freshCount &&
        workers.capacity <= maximumCapacity
    );
}

const systemHealthDiagnosticsWorkersSchema = v.pipe(
    systemHealthDiagnosticsWorkersObjectSchema,
    v.check(
        systemHealthDiagnosticsWorkersAreConsistent,
        "System health worker projection is inconsistent"
    )
);

/** Bounded content-free queue state, or an explicit unavailable component. */
const systemHealthDiagnosticsQueueVariantSchema = v.variant("status", [
    v.strictObject({
        claimingPaused: v.boolean(),
        oldestQueuedAtMs: v.optional(systemHealthDiagnosticsTimestampSchema),
        runs: v.strictObject({
            queued: systemHealthDiagnosticsCountSchema,
            running: systemHealthDiagnosticsCountSchema,
        }),
        status: v.literal("observed"),
        workers: systemHealthDiagnosticsWorkersSchema,
    }),
    v.strictObject({ status: v.literal("unavailable") }),
]);

/** @returns Whether queue count and oldest-row presence agree. */
export function systemHealthDiagnosticsQueueIsConsistent(
    queue: v.InferOutput<typeof systemHealthDiagnosticsQueueVariantSchema>
): boolean {
    return (
        queue.status === "unavailable" ||
        queue.runs.queued > 0 === (queue.oldestQueuedAtMs !== undefined)
    );
}

export const systemHealthDiagnosticsQueueSchema = v.pipe(
    systemHealthDiagnosticsQueueVariantSchema,
    v.check(
        systemHealthDiagnosticsQueueIsConsistent,
        "System health queue projection is inconsistent"
    )
);

const systemHealthDiagnosticsChecksSchema = v.strictObject({
    application: v.strictObject({
        status: v.picklist(["not-ready", "ready"]),
    }),
    database: v.strictObject({
        status: v.picklist(["ready", "unavailable"]),
    }),
    frontend: v.strictObject({
        status: v.picklist(["ready", "unavailable"]),
    }),
    release: v.strictObject({
        status: v.picklist(["unavailable", "verified"]),
    }),
    worker: v.strictObject({
        status: v.picklist(["not-ready", "ready", "unavailable"]),
    }),
});

type SystemHealthDiagnosticsValue = {
    readonly checkedAtMs: number;
    readonly checks: v.InferOutput<typeof systemHealthDiagnosticsChecksSchema>;
    readonly dependencies: {
        readonly gateway: v.InferOutput<typeof systemHealthDiagnosticsGatewaySchema>;
        readonly sessions: v.InferOutput<typeof systemHealthDiagnosticsSessionsSchema>;
    };
    readonly queue: v.InferOutput<typeof systemHealthDiagnosticsQueueSchema>;
    readonly status: "not-ready" | "ready";
};

/** @returns Whether the aggregate state exactly reflects every gating check. */
export function systemHealthDiagnosticsIsConsistent(
    diagnostics: SystemHealthDiagnosticsValue
): boolean {
    const checks = diagnostics.checks;
    const ready =
        checks.application.status === "ready" &&
        checks.database.status === "ready" &&
        checks.frontend.status === "ready" &&
        checks.release.status === "verified" &&
        checks.worker.status === "ready";
    const queueTimeIsConsistent =
        diagnostics.queue.status === "unavailable" ||
        diagnostics.queue.oldestQueuedAtMs === undefined ||
        diagnostics.queue.oldestQueuedAtMs <= diagnostics.checkedAtMs;
    const sessions = diagnostics.dependencies.sessions;
    const gateway = diagnostics.dependencies.gateway;
    const sessionTimeIsConsistent =
        sessions.state === "unavailable" ||
        (sessions.observedAtMs <= diagnostics.checkedAtMs &&
            (sessions.state !== "last-known-good" ||
                sessions.staleSinceMs <= diagnostics.checkedAtMs));
    const dependencyFreshnessIsConsistent =
        sessions.state !== "fresh" ||
        (gateway.status === "observed" && gateway.freshness === "fresh");
    const queueChecksAreConsistent =
        diagnostics.queue.status === "observed"
            ? checks.database.status === "ready" &&
              (checks.release.status === "verified") ===
                  (checks.worker.status !== "unavailable") &&
              (checks.worker.status !== "ready" ||
                  diagnostics.queue.workers.onlineCount > 0)
            : checks.database.status === "unavailable" &&
              checks.worker.status === "unavailable";
    return (
        queueTimeIsConsistent &&
        sessionTimeIsConsistent &&
        dependencyFreshnessIsConsistent &&
        queueChecksAreConsistent &&
        (diagnostics.status === "ready") === ready
    );
}

/** Session-only readiness, dependency, and queue diagnostics without identities. */
export const systemHealthDiagnosticsSchema = v.pipe(
    v.strictObject({
        checkedAtMs: systemHealthDiagnosticsTimestampSchema,
        checks: systemHealthDiagnosticsChecksSchema,
        dependencies: v.strictObject({
            gateway: systemHealthDiagnosticsGatewaySchema,
            sessions: systemHealthDiagnosticsSessionsSchema,
        }),
        queue: systemHealthDiagnosticsQueueSchema,
        status: v.picklist(["not-ready", "ready"]),
    }),
    v.check(
        systemHealthDiagnosticsIsConsistent,
        "System health diagnostics aggregate is inconsistent"
    )
);

export type SystemHealthDiagnostics = v.InferOutput<typeof systemHealthDiagnosticsSchema>;

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

/** Session-only detailed health contract without automation or control authority. */
export const systemHealthDiagnosticsContract = {
    access: {
        capabilities: [],
        capabilityPolicy: "all",
        kind: "authenticated",
        principalKinds: ["session"],
    },
    domain: "system",
    errors: ["FORBIDDEN", "UNAUTHORIZED"],
    input: emptyInputSchema,
    inputSchemaId: "system.healthDiagnostics.input",
    kind: "query",
    name: "system.healthDiagnostics",
    output: systemHealthDiagnosticsSchema,
    outputSchemaId: "system.healthDiagnostics.output",
    summary:
        "Returns bounded readiness, dependency, and queue diagnostics without operational identities.",
    transport: {
        batching: "adapter-default",
        handler: "default",
        requestBody: "default",
    },
} as const satisfies ProcedureContract;

/** Implemented system tRPC contracts. */
export const systemProcedureContracts = [
    systemHealthDiagnosticsContract,
    systemMetricsContract,
    runtimeIdentityContract,
] as const;

/** Implemented raw health-route contracts. */
export const systemRawHttpContracts = [
    {
        access: { kind: "public" },
        method: "GET",
        path: healthLivenessPath,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: {
            contentTypes: ["application/json"],
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
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: { kind: "none" },
        statusCodes: [200],
        summary: "Checks Bun web-process liveness without a response body.",
    },
    {
        access: { kind: "public" },
        method: "GET",
        path: healthReadinessPath,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: {
            contentTypes: ["application/json"],
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
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: { kind: "none" },
        statusCodes: [200, 503],
        summary: "Checks application readiness without a response body.",
    },
] as const satisfies readonly RawHttpContract[];
