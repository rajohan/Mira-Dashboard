import * as v from "valibot";

import { openClawGatewayProtocolVersion } from "./gatewayCredentialProtocol.ts";

/** Installed OpenClaw's hard application-frame ceiling after authentication. */
export const persistentGatewayAuthenticatedFrameMaximumBytes = 25 * 1024 * 1024;
/** Installed OpenClaw's outbound WebSocket buffered-amount policy. */
export const persistentGatewayBufferedAmountPolicyMaximumBytes = 50 * 1024 * 1024;
/** Dashboard's intentionally tighter outbound buffered-amount ceiling. */
export const persistentGatewayBufferedAmountMaximumBytes = 4 * 1024 * 1024;
/** Dashboard's tighter bound for the challenge that precedes credential disclosure. */
export const persistentGatewayChallengeFrameMaximumBytes = 4 * 1024;
/** Conservative default for Dashboard-originated request frames, including attachments. */
export const persistentGatewayOutboundFrameMaximumBytes = 1024 * 1024;

export const persistentGatewayWebReadScopes = Object.freeze(["operator.read"] as const);
export const persistentGatewayTaskNotificationScopes = Object.freeze([
    "operator.write",
] as const);
export const persistentGatewayAdminScopes = Object.freeze(["operator.admin"] as const);
export const persistentGatewaySessionScopedEventsCapability =
    "session-scoped-events" as const;

export type PersistentGatewayConnectionProfile =
    | "admin"
    | "task-notification-worker"
    | "web-read";

/** Exact Phase 4A application-event surface delivered beyond the transport boundary. */
export const persistentGatewayEventNames = Object.freeze([
    "cron",
    "sessions.changed",
] as const);

export type PersistentGatewayEventName = (typeof persistentGatewayEventNames)[number];

/** chat.send stays behind the task-notification port rather than the generic RPC port. */
export const persistentGatewayTaskNotificationMethod = "chat.send" as const;

/** Installed protocol-v4 top-level request error discriminants. */
export const persistentGatewayErrorCodes = Object.freeze([
    "AGENT_TIMEOUT",
    "APPROVAL_NOT_FOUND",
    "FORBIDDEN",
    "INVALID_REQUEST",
    "NOT_LINKED",
    "NOT_PAIRED",
    "UNAVAILABLE",
] as const);

export type PersistentGatewayErrorCode = (typeof persistentGatewayErrorCodes)[number];

/**
 * Exact long-lived data-plane surface. Dynamic session methods are additionally
 * constrained below so this lane can never silently require operator.admin.
 */
export const persistentGatewayWebReadMethods = Object.freeze([
    "cron.get",
    "cron.list",
    "cron.runs",
    "sessions.list",
    "system.info",
] as const);

/** @deprecated Use persistentGatewayWebReadMethods. */
export const persistentGatewayReadWriteMethods = persistentGatewayWebReadMethods;

/** Exact control-plane methods permitted on a fresh, single-use admin socket. */
export const persistentGatewayAdminMethods = Object.freeze([
    "cron.remove",
    "cron.run",
    "cron.update",
    "sessions.compact",
    "sessions.delete",
    "sessions.reset",
] as const);

export type PersistentGatewayWebReadMethod =
    (typeof persistentGatewayWebReadMethods)[number];
/** @deprecated Use PersistentGatewayWebReadMethod. */
export type PersistentGatewayReadWriteMethod = PersistentGatewayWebReadMethod;
export type PersistentGatewayAdminMethod = (typeof persistentGatewayAdminMethods)[number];

const webReadMethodSet = new Set<string>(persistentGatewayWebReadMethods);
const adminMethodSet = new Set<string>(persistentGatewayAdminMethods);
const eventNameSet = new Set<string>(persistentGatewayEventNames);

const boundedIdentifierSchema = v.pipe(
    v.string("Gateway frame identifier is invalid"),
    v.minLength(1, "Gateway frame identifier is invalid"),
    v.maxLength(128, "Gateway frame identifier is invalid")
);
const boundedProtocolNameSchema = v.pipe(
    v.string("Gateway protocol name is invalid"),
    v.minLength(1, "Gateway protocol name is invalid"),
    v.maxLength(256, "Gateway protocol name is invalid")
);
const nonnegativeSafeIntegerSchema = v.pipe(
    v.number("Gateway integer is invalid"),
    v.safeInteger("Gateway integer is invalid"),
    v.minValue(0, "Gateway integer is invalid")
);
const positiveSafeIntegerSchema = v.pipe(
    nonnegativeSafeIntegerSchema,
    v.minValue(1, "Gateway integer is invalid")
);
const gatewayScopeSchema = v.pipe(
    v.string("Gateway scope is invalid"),
    v.minLength(1, "Gateway scope is invalid"),
    v.maxLength(128, "Gateway scope is invalid")
);
const gatewayErrorSchema = v.object({
    code: v.picklist(persistentGatewayErrorCodes, "Gateway error code is invalid"),
    details: v.optional(v.unknown()),
    message: v.pipe(
        v.string("Gateway error message is invalid"),
        v.maxLength(4096, "Gateway error message is invalid")
    ),
    retryable: v.optional(v.boolean("Gateway retry policy is invalid")),
    retryAfterMs: v.optional(nonnegativeSafeIntegerSchema),
});

const gatewayResponseFrameSchema = v.object({
    error: v.optional(gatewayErrorSchema),
    id: boundedIdentifierSchema,
    ok: v.boolean("Gateway response outcome is invalid"),
    payload: v.optional(v.unknown()),
    type: v.literal("res"),
});

const gatewayStateVersionSchema = v.strictObject({
    health: nonnegativeSafeIntegerSchema,
    presence: nonnegativeSafeIntegerSchema,
});

const gatewayEventFrameSchema = v.strictObject({
    event: boundedProtocolNameSchema,
    payload: v.optional(v.unknown()),
    seq: v.optional(positiveSafeIntegerSchema),
    stateVersion: v.optional(gatewayStateVersionSchema),
    type: v.literal("event"),
});

const gatewayChallengeFrameSchema = v.object({
    event: v.literal("connect.challenge"),
    payload: v.object({
        nonce: v.pipe(
            v.string("Gateway challenge nonce is invalid"),
            v.minLength(1, "Gateway challenge nonce is invalid"),
            v.maxLength(256, "Gateway challenge nonce is invalid")
        ),
    }),
    type: v.literal("event"),
});

const gatewayHelloSchema = v.object({
    auth: v.object({
        role: v.literal("operator"),
        scopes: v.pipe(
            v.array(gatewayScopeSchema, "Gateway scopes are invalid"),
            v.maxLength(32, "Gateway scopes are invalid")
        ),
    }),
    features: v.object({
        events: v.pipe(
            v.array(boundedProtocolNameSchema, "Gateway event catalog is invalid"),
            v.maxLength(4096, "Gateway event catalog is invalid")
        ),
        methods: v.pipe(
            v.array(boundedProtocolNameSchema, "Gateway method catalog is invalid"),
            v.maxLength(4096, "Gateway method catalog is invalid")
        ),
    }),
    policy: v.object({
        maxBufferedBytes: positiveSafeIntegerSchema,
        maxPayload: positiveSafeIntegerSchema,
        tickIntervalMs: v.pipe(
            positiveSafeIntegerSchema,
            v.maxValue(5 * 60 * 1000, "Gateway tick policy is invalid")
        ),
    }),
    protocol: v.literal(openClawGatewayProtocolVersion),
    server: v.object({
        connId: boundedIdentifierSchema,
        version: v.pipe(
            v.string("Gateway server version is invalid"),
            v.minLength(1, "Gateway server version is invalid"),
            v.maxLength(256, "Gateway server version is invalid")
        ),
    }),
    snapshot: v.object({}),
    type: v.literal("hello-ok"),
});

const gatewayChatSendAcknowledgementSchema = v.object({
    runId: boundedIdentifierSchema,
    status: v.picklist(["started", "in_flight", "ok"]),
});

const gatewaySessionsSubscriptionAcknowledgementSchema = v.strictObject({
    subscribed: v.literal(true),
});

export interface PersistentGatewayResponseFrame {
    readonly error?: {
        readonly code: PersistentGatewayErrorCode;
        readonly details?: unknown;
        readonly message: string;
        readonly retryable?: boolean;
        readonly retryAfterMs?: number;
    };
    readonly id: string;
    readonly ok: boolean;
    readonly payload?: unknown;
    readonly type: "res";
}

export interface PersistentGatewayEventFrame {
    readonly event: PersistentGatewayEventName;
    readonly seq?: number;
    readonly type: "event";
}

/** Payload-free projection used to consume every valid authenticated event safely. */
export interface PersistentGatewayEventEnvelope {
    readonly event: string;
    readonly seq?: number;
    readonly type: "event";
}

export interface PersistentGatewayHello {
    readonly auth: { readonly role: "operator"; readonly scopes: readonly string[] };
    readonly features: {
        readonly events: readonly string[];
        readonly methods: readonly string[];
    };
    readonly policy: {
        readonly maxBufferedBytes: number;
        readonly maxPayload: number;
        readonly tickIntervalMs: number;
    };
    readonly protocol: typeof openClawGatewayProtocolVersion;
    readonly server: { readonly connId: string; readonly version: string };
    readonly snapshot: Readonly<Record<string, never>>;
    readonly type: "hello-ok";
}

export interface PersistentGatewayConnectFrameInput {
    readonly clientVersion: string;
    readonly credential: string;
    readonly instanceId: string;
    readonly profile: PersistentGatewayConnectionProfile;
    readonly requestId: string;
}

function hasExactScopes(actual: readonly string[], expected: readonly string[]): boolean {
    return (
        actual.length === expected.length &&
        new Set(actual).size === actual.length &&
        expected.every((scope) => actual.includes(scope))
    );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopesForProfile(
    profile: PersistentGatewayConnectionProfile
):
    | typeof persistentGatewayAdminScopes
    | typeof persistentGatewayTaskNotificationScopes
    | typeof persistentGatewayWebReadScopes {
    switch (profile) {
        case "admin": {
            return persistentGatewayAdminScopes;
        }
        case "task-notification-worker": {
            return persistentGatewayTaskNotificationScopes;
        }
        case "web-read": {
            return persistentGatewayWebReadScopes;
        }
    }
}

function displayNameForProfile(profile: PersistentGatewayConnectionProfile): string {
    switch (profile) {
        case "admin": {
            return "Mira Dashboard bounded admin request";
        }
        case "task-notification-worker": {
            return "Mira Dashboard task notification worker";
        }
        case "web-read": {
            return "Mira Dashboard persistent web reads";
        }
    }
}

function capabilitiesForProfile(
    _profile: PersistentGatewayConnectionProfile
): readonly string[] {
    return [persistentGatewaySessionScopedEventsCapability];
}

/**
 * Returns whether an untrusted name belongs to the long-lived lane.
 * @param method Candidate Gateway method.
 * @returns Whether the method belongs to the generic data-plane allowlist.
 */
export function isPersistentGatewayReadWriteMethod(
    method: string
): method is PersistentGatewayReadWriteMethod {
    return webReadMethodSet.has(method);
}

/**
 * Returns whether an untrusted name belongs to the single-use admin lane.
 * @param method Candidate Gateway method.
 * @returns Whether the method belongs to the bounded control-plane allowlist.
 */
export function isPersistentGatewayAdminMethod(
    method: string
): method is PersistentGatewayAdminMethod {
    return adminMethodSet.has(method);
}

/**
 * Enforces the installed Gateway's dynamic least-privilege rules before a
 * request reaches the long-lived read/write socket.
 */
export function assertPersistentGatewayReadWriteParameters(
    _method: PersistentGatewayReadWriteMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!isRecord(parameters)) {
        throw new TypeError("Persistent Gateway request parameters are invalid");
    }
}

/** Admin parameters remain method-bound and must at least be one JSON object. */
export function assertPersistentGatewayAdminParameters(
    _method: PersistentGatewayAdminMethod,
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    if (!isRecord(parameters)) {
        throw new TypeError("Persistent Gateway request parameters are invalid");
    }
}

/**
 * Builds the only credential-bearing frame for either Phase 4 lane.
 * @param input Redacted-lifetime handshake inputs and requested lane.
 * @returns One protocol-v4 connect request.
 */
export function createPersistentGatewayConnectFrame(
    input: PersistentGatewayConnectFrameInput
): Readonly<Record<string, unknown>> {
    const scopes = scopesForProfile(input.profile);
    return Object.freeze({
        id: input.requestId,
        method: "connect",
        params: Object.freeze({
            auth: Object.freeze({ token: input.credential }),
            caps: Object.freeze(capabilitiesForProfile(input.profile)),
            client: Object.freeze({
                deviceFamily: "server",
                displayName: displayNameForProfile(input.profile),
                id: "gateway-client",
                instanceId: input.instanceId,
                mode: "backend",
                platform: process.platform,
                version: input.clientVersion,
            }),
            maxProtocol: openClawGatewayProtocolVersion,
            minProtocol: openClawGatewayProtocolVersion,
            role: "operator",
            scopes,
        }),
        type: "req",
    });
}

export function parsePersistentGatewayChallenge(
    value: unknown
): { readonly nonce: string } | undefined {
    const parsed = v.safeParse(gatewayChallengeFrameSchema, value);
    return parsed.success
        ? Object.freeze({ nonce: parsed.output.payload.nonce })
        : undefined;
}

export function parsePersistentGatewayResponse(
    value: unknown
): PersistentGatewayResponseFrame | undefined {
    const parsed = v.safeParse(gatewayResponseFrameSchema, value);
    if (!parsed.success) return undefined;
    const response = parsed.output;
    if (
        (response.ok && response.error !== undefined) ||
        (!response.ok && (response.error === undefined || response.payload !== undefined))
    ) {
        return undefined;
    }
    return response;
}

export function parsePersistentGatewayHello(
    value: unknown,
    profile: PersistentGatewayConnectionProfile
): PersistentGatewayHello | undefined {
    const parsed = v.safeParse(gatewayHelloSchema, value);
    if (!parsed.success) return undefined;
    const expectedScopes = scopesForProfile(profile);
    if (!hasExactScopes(parsed.output.auth.scopes, expectedScopes)) return undefined;
    if (!parsed.output.features.events.includes("tick")) return undefined;
    if (
        profile === "web-read" &&
        !persistentGatewayEventNames.every((event) =>
            parsed.output.features.events.includes(event)
        )
    ) {
        return undefined;
    }
    if (
        parsed.output.policy.maxPayload >
            persistentGatewayAuthenticatedFrameMaximumBytes ||
        parsed.output.policy.maxBufferedBytes >
            persistentGatewayBufferedAmountPolicyMaximumBytes
    ) {
        return undefined;
    }
    return parsed.output;
}

/**
 * Projects the installed chat.send acknowledgement onto its stable success fields.
 * @param value Untrusted successful response payload.
 * @returns The bounded acknowledgement projection, or undefined when incompatible.
 */
export function parsePersistentGatewayChatSendAcknowledgement(value: unknown):
    | {
          readonly runId: string;
          readonly status: "in_flight" | "ok" | "started";
      }
    | undefined {
    const parsed = v.safeParse(gatewayChatSendAcknowledgementSchema, value);
    if (!parsed.success) return undefined;
    return Object.freeze({ runId: parsed.output.runId, status: parsed.output.status });
}

export function parsePersistentGatewayEvent(
    value: unknown
): PersistentGatewayEventFrame | undefined {
    const parsed = v.safeParse(gatewayEventFrameSchema, value);
    if (!parsed.success || !eventNameSet.has(parsed.output.event)) return undefined;
    return Object.freeze({
        event: parsed.output.event as PersistentGatewayEventName,
        ...(parsed.output.seq === undefined ? {} : { seq: parsed.output.seq }),
        type: parsed.output.type,
    });
}

/**
 * Validates an authenticated event envelope without exposing an unreviewed payload.
 * Domain payloads are projected separately only for the explicit event allowlist.
 * @param value Untrusted decoded Gateway frame.
 * @returns A payload-free event envelope, or undefined for malformed input.
 */
export function parsePersistentGatewayEventEnvelope(
    value: unknown
): PersistentGatewayEventEnvelope | undefined {
    const parsed = v.safeParse(gatewayEventFrameSchema, value);
    if (!parsed.success) return undefined;
    return Object.freeze({
        event: parsed.output.event,
        ...(parsed.output.seq === undefined ? {} : { seq: parsed.output.seq }),
        type: parsed.output.type,
    });
}

/**
 * Accepts only the installed sessions.subscribe success projection.
 * @param value Untrusted successful response payload.
 * @returns True only for the exact subscribed acknowledgement.
 */
export function parsePersistentGatewaySessionsSubscriptionAcknowledgement(
    value: unknown
): true | undefined {
    return v.safeParse(gatewaySessionsSubscriptionAcknowledgementSchema, value).success
        ? true
        : undefined;
}
