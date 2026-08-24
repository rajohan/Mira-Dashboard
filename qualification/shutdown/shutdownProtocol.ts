import * as v from "valibot";

export const shutdownLifecycleEventSchema = v.picklist([
    "signal-handler-installed",
    "listener-open",
    "database-open",
    "worker-lease-acquired",
    "statement-prepared",
    "child-process-started",
    "gateway-fixture-open",
    "gateway-socket-open",
    "readiness-up",
    "shutdown-requested",
    "readiness-down",
    "listener-drained",
    "listener-force-stopped",
    "sse-server-closed",
    "gateway-socket-closed",
    "gateway-fixture-closed",
    "child-process-reaped",
    "statement-finalized",
    "worker-lease-released",
    "database-checkpointed",
    "database-closed",
    "stopped",
]);

export type ShutdownLifecycleEvent = v.InferOutput<typeof shutdownLifecycleEventSchema>;

const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonnegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const portSchema = v.pipe(positiveIntegerSchema, v.maxValue(65_535));
const gatewayNonceSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const gatewayOperatorReadSchema = v.literal("operator.read");
const gatewayOperatorReadScopesSchema = v.tuple([gatewayOperatorReadSchema]);

export const shutdownServiceStatusSchema = v.strictObject({
    events: v.array(shutdownLifecycleEventSchema),
    gatewaySocketOpen: v.boolean(),
    generation: positiveIntegerSchema,
    grandchildPid: v.optional(positiveIntegerSchema),
    leaseActive: v.boolean(),
    phase: v.picklist(["starting", "ready", "draining", "stopped"]),
    pid: positiveIntegerSchema,
    port: portSchema,
    readiness: v.boolean(),
    recoveredGenerationCount: nonnegativeIntegerSchema,
    schemaVersion: v.literal(1),
    sseConnectionCount: nonnegativeIntegerSchema,
});

export type ShutdownServiceStatus = v.InferOutput<typeof shutdownServiceStatusSchema>;

const gatewayChallengePayloadSchema = v.strictObject({
    nonce: gatewayNonceSchema,
    ts: nonnegativeIntegerSchema,
});
const gatewayChallengeSchema = v.strictObject({
    event: v.literal("connect.challenge"),
    payload: gatewayChallengePayloadSchema,
    type: v.literal("event"),
});

const gatewayConnectAuthSchema = v.strictObject({
    token: v.literal("shutdown-fixture-token"),
});
const gatewayConnectClientSchema = v.strictObject({
    displayName: v.literal("Mira shutdown qualification"),
    id: v.literal("gateway-client"),
    mode: v.literal("cli"),
    platform: v.literal("linux"),
    version: v.literal("qualification"),
});
const gatewayConnectParametersSchema = v.strictObject({
    auth: gatewayConnectAuthSchema,
    client: gatewayConnectClientSchema,
    maxProtocol: v.literal(4),
    minProtocol: v.literal(4),
    nonce: gatewayNonceSchema,
    role: v.literal("operator"),
    scopes: gatewayOperatorReadScopesSchema,
});
const gatewayConnectRequestSchema = v.strictObject({
    id: v.literal("shutdown-qualification-connect"),
    method: v.literal("connect"),
    params: gatewayConnectParametersSchema,
    type: v.literal("req"),
});

const gatewayHelloAuthSchema = v.strictObject({
    role: v.literal("operator"),
    scopes: gatewayOperatorReadScopesSchema,
});
const gatewayHelloServerSchema = v.strictObject({
    connId: v.literal("shutdown-qualification"),
    version: v.literal("2026.7.2-beta.7"),
});
const gatewayHelloSnapshotSchema = v.strictObject({
    authMode: v.literal("token"),
});
const gatewayHelloPayloadSchema = v.strictObject({
    auth: gatewayHelloAuthSchema,
    protocol: v.literal(4),
    server: gatewayHelloServerSchema,
    snapshot: gatewayHelloSnapshotSchema,
    type: v.literal("hello-ok"),
});
const gatewayHelloResponseSchema = v.strictObject({
    id: v.literal("shutdown-qualification-connect"),
    ok: v.literal(true),
    payload: gatewayHelloPayloadSchema,
    type: v.literal("res"),
});

function parseBoundedJson(text: string, maximumBytes: number): unknown {
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
        throw new Error("Shutdown qualification Gateway frame exceeded its bound");
    }
    return JSON.parse(text) as unknown;
}

export function parseGatewayChallenge(text: string) {
    return v.parse(gatewayChallengeSchema, parseBoundedJson(text, 16 * 1024));
}

export function parseGatewayConnectRequest(text: string) {
    return v.parse(gatewayConnectRequestSchema, parseBoundedJson(text, 16 * 1024));
}

export function parseGatewayHelloResponse(text: string) {
    return v.parse(gatewayHelloResponseSchema, parseBoundedJson(text, 16 * 1024));
}

export function createGatewayConnectRequest(nonce: string) {
    if (nonce.length === 0 || nonce.length > 128) {
        throw new Error("Shutdown qualification Gateway nonce is invalid");
    }
    return {
        id: "shutdown-qualification-connect" as const,
        method: "connect" as const,
        params: {
            auth: { token: "shutdown-fixture-token" as const },
            client: {
                displayName: "Mira shutdown qualification" as const,
                id: "gateway-client" as const,
                mode: "cli" as const,
                platform: "linux" as const,
                version: "qualification" as const,
            },
            maxProtocol: 4 as const,
            minProtocol: 4 as const,
            nonce,
            role: "operator" as const,
            scopes: ["operator.read" as const] as const,
        },
        type: "req" as const,
    };
}

export function createGatewayHelloResponse() {
    return {
        id: "shutdown-qualification-connect" as const,
        ok: true as const,
        payload: {
            auth: {
                role: "operator" as const,
                scopes: ["operator.read" as const] as const,
            },
            protocol: 4 as const,
            server: {
                connId: "shutdown-qualification" as const,
                version: "2026.7.2-beta.7" as const,
            },
            snapshot: { authMode: "token" as const },
            type: "hello-ok" as const,
        },
        type: "res" as const,
    };
}

export function parseShutdownServiceStatus(value: unknown): ShutdownServiceStatus {
    return v.parse(shutdownServiceStatusSchema, value);
}
