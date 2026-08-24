import { Effect, Layer, Redacted } from "effect";
import * as v from "valibot";

import {
    miraMainSessionKey,
    taskNotificationEventIdSchema,
    type TaskNotificationChatSender,
    taskNotificationMessageSchema,
    taskNotificationSendTimeoutMilliseconds,
} from "../../../shared/taskNotifications.ts";
import { parseGatewayCredentialVerifierUrl } from "./gatewayCredentialVerifier.ts";
import {
    assertPersistentGatewayAdminParameters,
    assertPersistentGatewayChatReadParameters,
    assertPersistentGatewayChatReadMutationParameters,
    assertPersistentGatewayChatWriteParameters,
    assertPersistentGatewayOpenClawSettingsReadParameters,
    assertPersistentGatewayOpenClawSettingsWriteParameters,
    assertPersistentGatewayOpenClawServiceActionParameters,
    assertPersistentGatewayReadWriteParameters,
    assertPersistentGatewayTaskReadParameters,
    assertPersistentGatewayTaskWriteParameters,
    createPersistentGatewayConnectFrame,
    isPersistentGatewayAdminMethod,
    isPersistentGatewayChatReadMethod,
    isPersistentGatewayChatReadMutationMethod,
    isPersistentGatewayChatWriteMethod,
    isPersistentGatewayOpenClawSettingsReadMethod,
    isPersistentGatewayOpenClawSettingsWriteMethod,
    isPersistentGatewayOpenClawServiceActionMethod,
    isPersistentGatewayReadWriteMethod,
    isPersistentGatewayTaskReadMethod,
    isPersistentGatewayTaskWriteMethod,
    parsePersistentGatewayChatSendAcknowledgement,
    type PersistentGatewayConnectionProfile,
    type PersistentGatewayErrorCode,
    type PersistentGatewayAdminMethod,
    persistentGatewayAuthenticatedFrameMaximumBytes,
    persistentGatewayBufferedAmountMaximumBytes,
    persistentGatewayChallengeFrameMaximumBytes,
    type PersistentGatewayChatReadMethod,
    type PersistentGatewayChatReadMutationMethod,
    persistentGatewayChatOutboundFrameMaximumBytes,
    type PersistentGatewayChatWriteMethod,
    type PersistentGatewayEventEnvelope,
    type PersistentGatewayEventFrame,
    type PersistentGatewayHello,
    type PersistentGatewayPrivateChatEvent,
    type PersistentGatewayOpenClawSettingsReadMethod,
    type PersistentGatewayOpenClawSettingsWriteMethod,
    type PersistentGatewayOpenClawServiceActionMethod,
    type PersistentGatewayOpenClawServiceActionResponse,
    persistentGatewayOpenClawServiceActionRequestTimeoutMs,
    persistentGatewayOutboundFrameMaximumBytes,
    type PersistentGatewayReadWriteMethod,
    type PersistentGatewayTaskReadMethod,
    type PersistentGatewayTaskWriteMethod,
    persistentGatewayTaskNotificationMethod,
    parsePersistentGatewayChallenge,
    parsePersistentGatewayEvent,
    parsePersistentGatewayEventEnvelope,
    parsePersistentGatewayHello,
    parsePersistentGatewayPrivateChatEvent,
    parsePersistentGatewayOpenClawServiceActionResponse,
    parsePersistentGatewayResponse,
    parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement,
    parsePersistentGatewaySessionsSubscriptionAcknowledgement,
} from "./persistentGatewayProtocol.ts";

const socketConnectingState = 0;
const socketOpenState = 1;
const socketClosedState = 3;
const normalCloseCode = 1000;
const policyCloseCode = 1008;
const watchdogCloseCode = 4000;
const safeCloseReasonMaximumBytes = 123;
const taskNotificationIdempotencyKeyPrefix = "tasks-notify-";
const requestTimeoutMaximumDefaultMs = 5 * 60_000;
export const persistentGatewayChatEventQueueMaximum = 256;
/** Per-listener encoded projection budget retained while async delivery is blocked. */
export const persistentGatewayChatEventQueueMaximumBytes = 2 * 1024 * 1024;
export const persistentGatewayChatSubscriptionMaximum = 64;
/** Maximum active provider run identities tracked by one session subscription. */
export const persistentGatewayChatTrackedRunMaximum = 256;

const terminalAuthenticationDetailCodes = new Set([
    "AUTH_BOOTSTRAP_TOKEN_INVALID",
    "AUTH_DEVICE_TOKEN_MISMATCH",
    "AUTH_PASSWORD_MISMATCH",
    "AUTH_PASSWORD_MISSING",
    "AUTH_RATE_LIMITED",
    "AUTH_SCOPE_MISMATCH",
    "AUTH_TOKEN_MISMATCH",
    "AUTH_TOKEN_MISSING",
    "CLIENT_VERSION_MISMATCH",
    "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    "DEVICE_IDENTITY_REQUIRED",
    "PAIRING_REQUIRED",
]);

type TimerHandle = number | object;

/** Injectable timer authority used by deterministic transport tests. */
export interface PersistentGatewayScheduler {
    readonly clearTimeout: (handle: TimerHandle) => void;
    readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
}

const defaultScheduler: PersistentGatewayScheduler = Object.freeze({
    clearTimeout(handle: TimerHandle) {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        const handle = globalThis.setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
    },
});

export type PersistentGatewayFailureKind =
    | "authentication"
    | "event-gap"
    | "handshake-timeout"
    | "protocol"
    | "tick-timeout"
    | "transport"
    | "upstream";

export type PersistentGatewayConnectionPhase =
    | "connected"
    | "connecting"
    | "degraded"
    | "stopped"
    | "stopping";

export interface PersistentGatewayLastKnownGood {
    readonly connectedAtMs: number;
    readonly connectionId: string;
    readonly protocol: 4;
    readonly serverVersion: string;
}

/** Safe connection projection. It intentionally contains no endpoint or credential data. */
export interface PersistentGatewayConnectionSnapshot {
    readonly connectedAtMs?: number;
    readonly connectionGeneration: number;
    readonly lastActivityAtMs?: number;
    readonly lastDisconnectedAtMs?: number;
    readonly lastEventSequence?: number;
    readonly lastFailure?: PersistentGatewayFailureKind;
    readonly lastKnownGood?: PersistentGatewayLastKnownGood;
    readonly nextReconnectAtMs?: number;
    readonly phase: PersistentGatewayConnectionPhase;
    readonly reconnectAttempt: number;
}

export interface PersistentGatewayDeliveredEvent {
    readonly connectionGeneration: number;
    readonly frame: PersistentGatewayEventFrame;
    readonly receivedAtMs: number;
}

export interface PersistentGatewayDeliveredChatEvent {
    readonly connectionGeneration: number;
    readonly frame: PersistentGatewayPrivateChatEvent;
    readonly receivedAtMs: number;
}

export interface PersistentGatewayChatEventGap {
    readonly connectionGeneration: number;
    readonly expectedSequence: number;
    readonly receivedSequence: number;
    readonly runId: string;
    readonly sessionKey: string;
}

export type PersistentGatewayChatReconciliationReason =
    | "backpressure"
    | "subscription"
    | "transport";

export interface PersistentGatewayChatListener {
    readonly onEvent?: (
        event: PersistentGatewayDeliveredChatEvent
    ) => void | Promise<void>;
    readonly onEventGap?: (gap: PersistentGatewayChatEventGap) => void | Promise<void>;
    readonly onReconciliationRequired?: (
        reason: PersistentGatewayChatReconciliationReason
    ) => void | Promise<void>;
}

export interface PersistentGatewayChatRunWatermark {
    readonly lastProviderSequence: number;
    readonly providerRunId: string;
}

export interface PersistentGatewayChatSubscription {
    readonly agentId?: string;
    readonly runWatermarks: readonly PersistentGatewayChatRunWatermark[];
    readonly sessionKey: string;
}

export interface PersistentGatewayEventGap {
    readonly connectionGeneration: number;
    readonly expectedSequence: number;
    readonly receivedSequence: number;
}

export interface PersistentGatewayListener {
    readonly onEvent?: (event: PersistentGatewayDeliveredEvent) => void;
    readonly onEventGap?: (gap: PersistentGatewayEventGap) => void;
    readonly onState?: (snapshot: PersistentGatewayConnectionSnapshot) => void;
}

export interface PersistentGatewayRequestOptions {
    /** Receives the exact authenticated response-frame byte count before payload projection. */
    readonly onResponseBytes?: (responseBytes: number) => void;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

export interface PersistentGatewayOpenClawSettingsWriteOptions extends PersistentGatewayRequestOptions {
    /** Runs after the admin handshake and immediately before the mutation frame. */
    readonly beforeDispatch: () => Promise<void>;
}

interface PersistentGatewayOneShotRequestOptions extends PersistentGatewayRequestOptions {
    readonly beforeDispatch?: () => Promise<void>;
}

interface GatewaySocketLaneRequestOptions extends PersistentGatewayRequestOptions {
    /** Runs synchronously only after the native socket accepted the encoded frame. */
    readonly onDispatched?: () => void;
    /** Internal per-method ceiling; callers retain the five-minute default. */
    readonly timeoutMaximumMs?: number;
}

export type PersistentGatewayWebSocketFactory = (url: string) => WebSocket;

export interface PersistentGatewayTransportOptions {
    readonly adminConcurrencyMaximum?: number;
    readonly bufferedAmountMaximumBytes?: number;
    readonly chatOutboundFrameMaximumBytes?: number;
    readonly clientVersion: string;
    readonly createRequestId?: () => string;
    readonly gracefulStopTimeoutMs?: number;
    readonly handshakeTimeoutMs?: number;
    readonly instanceId?: string;
    readonly nowMs?: () => number;
    readonly outboundFrameMaximumBytes?: number;
    readonly pendingRequestMaximum?: number;
    readonly random?: () => number;
    readonly reconnect?: {
        readonly factor?: number;
        readonly initialDelayMs?: number;
        readonly jitterRatio?: number;
        readonly maximumDelayMs?: number;
    };
    readonly requestTimeoutMs?: number;
    readonly scheduler?: PersistentGatewayScheduler;
    readonly tickTimeoutMultiplier?: number;
    readonly token: Redacted.Redacted<string>;
    readonly url: string;
    readonly webSocketFactory?: PersistentGatewayWebSocketFactory;
}

/** Safe operational failure used for disconnected, closed, and malformed upstream state. */
export class PersistentGatewayUnavailableError extends Error {
    constructor() {
        super("Persistent Gateway is unavailable");
        this.name = "PersistentGatewayUnavailableError";
    }
}

/** Local admission or encoded-byte budget rejection. */
export class PersistentGatewayCapacityError extends Error {
    constructor() {
        super("Persistent Gateway request capacity is exhausted");
        this.name = "PersistentGatewayCapacityError";
    }
}

/** Abort outcome that contains no upstream or credential material. */
export class PersistentGatewayAbortError extends Error {
    constructor() {
        super("Persistent Gateway request was aborted");
        this.name = "AbortError";
    }
}

/** Request deadline outcome with only the allowlisted method name. */
export class PersistentGatewayTimeoutError extends Error {
    readonly method: string;

    constructor(method: string) {
        super(`Persistent Gateway request timed out: ${method}`);
        this.name = "PersistentGatewayTimeoutError";
        this.method = method;
    }
}

/**
 * A mutating request crossed the native send boundary, but no definitive Gateway
 * acknowledgement was observed. Callers must reconcile before any manual retry.
 */
export class PersistentGatewayUnknownOutcomeError extends Error {
    constructor() {
        super("Persistent Gateway request outcome could not be confirmed");
        this.name = "PersistentGatewayUnknownOutcomeError";
    }
}

/** Audited session-generation detail allowed to cross the transport boundary. */
export const persistentGatewaySessionChangedReason = "session-changed" as const;

/** Canonicalized base-hash conflict from the installed config.patch handler. */
export const persistentGatewayConfigurationChangedReason =
    "configuration-changed" as const;

/** Canonicalized audited cron definition-generation conflict. */
export const persistentGatewayCronJobChangedReason = "cron-job-changed" as const;
/** Audited INVALID_REQUEST projection used only by tasks.get. */
export const persistentGatewayTaskNotFoundReason = "task-not-found" as const;
/** Audited companion saturation detail; raw Gateway details remain transport-private. */
export const persistentGatewaySessionCompanionBusyReason =
    "session-companion-busy" as const;

export type PersistentGatewayRequestReason =
    | typeof persistentGatewayConfigurationChangedReason
    | typeof persistentGatewayCronJobChangedReason
    | typeof persistentGatewaySessionChangedReason
    | typeof persistentGatewaySessionCompanionBusyReason
    | typeof persistentGatewayTaskNotFoundReason;

/** Sanitized upstream rejection. Raw messages and details never cross this boundary. */
export class PersistentGatewayRequestError extends Error {
    readonly code: PersistentGatewayErrorCode;
    readonly reason?: PersistentGatewayRequestReason;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;

    constructor(input: {
        readonly code: PersistentGatewayErrorCode;
        readonly reason?: PersistentGatewayRequestReason;
        readonly retryable?: boolean;
        readonly retryAfterMs?: number;
    }) {
        super("Persistent Gateway rejected the request");
        this.name = "PersistentGatewayRequestError";
        this.code = input.code;
        if (input.reason !== undefined) this.reason = input.reason;
        this.retryable = input.retryable === true;
        if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
    }
}

/** Graceful shutdown failed to observe native WebSocket close inside its budget. */
export class PersistentGatewayStopTimeoutError extends Error {
    constructor() {
        super("Persistent Gateway did not stop inside its deadline");
        this.name = "PersistentGatewayStopTimeoutError";
    }
}

interface ResolvedPersistentGatewayOptions {
    readonly adminConcurrencyMaximum: number;
    readonly bufferedAmountMaximumBytes: number;
    readonly chatOutboundFrameMaximumBytes: number;
    readonly clientVersion: string;
    readonly createRequestId: () => string;
    readonly gracefulStopTimeoutMs: number;
    readonly handshakeTimeoutMs: number;
    readonly instanceId: string;
    readonly nowMs: () => number;
    readonly outboundFrameMaximumBytes: number;
    readonly pendingRequestMaximum: number;
    readonly profile: Exclude<
        PersistentGatewayConnectionProfile,
        "admin" | "chat-read-mutation" | "chat-write"
    >;
    readonly random: () => number;
    readonly reconnect: {
        readonly factor: number;
        readonly initialDelayMs: number;
        readonly jitterRatio: number;
        readonly maximumDelayMs: number;
    };
    readonly requestTimeoutMs: number;
    readonly scheduler: PersistentGatewayScheduler;
    readonly tickTimeoutMultiplier: number;
    readonly token: Redacted.Redacted<string>;
    readonly url: string;
    readonly webSocketFactory: PersistentGatewayWebSocketFactory;
}

interface PendingRequest {
    readonly method: string;
    readonly onResponseBytes?: (responseBytes: number) => void;
    readonly reject: (error: Error) => void;
    readonly resolve: (payload: unknown) => void;
    readonly signal?: AbortSignal;
    timeoutHandle?: TimerHandle;
    abortListener?: () => void;
}

type ChatSubscriberQueueItem =
    | Readonly<{
          event: PersistentGatewayDeliveredChatEvent;
          kind: "event";
          retainedBytes: number;
      }>
    | Readonly<{
          gap: PersistentGatewayChatEventGap;
          kind: "gap";
      }>
    | Readonly<{
          kind: "reconciliation";
          reason: PersistentGatewayChatReconciliationReason;
      }>;

interface ChatSubscriberState {
    readonly identity: object;
    readonly listener: PersistentGatewayChatListener;
    readonly queue: ChatSubscriberQueueItem[];
    draining: boolean;
    queuedEventBytes: number;
    terminalBoundaryQueued: boolean;
}

interface ChatSubscriptionScope {
    readonly agentId?: string;
    readonly key: string;
    readonly initialRunSequences: ReadonlyMap<string, number>;
    readonly subscribers: Map<object, ChatSubscriberState>;
    readonly runSequences: Map<string, number>;
    canonicalKey?: string;
    reconciliationRequired?: PersistentGatewayChatReconciliationReason;
    subscribedGeneration?: number;
    synchronizingGeneration?: number;
}

interface LaneCloseDisposition {
    readonly failure?: PersistentGatewayFailureKind;
    readonly reconnect: boolean;
    readonly reconnectDelayMs?: number;
    readonly requested: boolean;
}

interface LaneCloseReport extends LaneCloseDisposition {
    readonly connected: boolean;
    readonly generation: number;
}

interface GatewaySocketLaneCallbacks {
    readonly onActivity: (atMs: number, lastEventSequence?: number) => void;
    readonly onClosed: (report: LaneCloseReport) => void;
    readonly onConnected: (hello: PersistentGatewayHello) => void;
    readonly onChatEvent: (
        event: PersistentGatewayPrivateChatEvent,
        receivedAtMs: number
    ) => void;
    readonly onEvent: (event: PersistentGatewayEventFrame, receivedAtMs: number) => void;
    readonly onEventGap: (expected: number, received: number) => void;
}

interface GatewaySocketLaneOptions {
    readonly bufferedAmountMaximumBytes?: number;
    readonly callbacks: GatewaySocketLaneCallbacks;
    readonly generation: number;
    readonly outboundFrameMaximumBytes?: number;
    readonly profile: PersistentGatewayConnectionProfile;
    readonly resolved: ResolvedPersistentGatewayOptions;
}

type GatewayLaneStage =
    | "awaiting-challenge"
    | "awaiting-hello"
    | "awaiting-subscription"
    | "closed"
    | "connected"
    | "opening";

function boundedInteger(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    label: string
): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return resolved;
}

function boundedNumber(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    label: string
): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return resolved;
}

function boundedNonblank(value: string, maximum: number, label: string): string {
    if (
        value.length === 0 ||
        value.length > maximum ||
        value !== value.trim() ||
        containsControlCharacter(value)
    ) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function containsControlCharacter(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
            return true;
        }
    }
    return false;
}

function chatSubscriptionScopeIdentifier(
    input: PersistentGatewayChatSubscription
): string {
    const sessionKey = boundedNonblank(
        input.sessionKey,
        512,
        "Persistent Gateway chat session key"
    );
    const agentId =
        input.agentId === undefined
            ? undefined
            : boundedNonblank(input.agentId, 512, "Persistent Gateway chat agent id");
    return JSON.stringify([sessionKey, agentId ?? null]);
}

function chatRunWatermarkMap(
    watermarks: readonly PersistentGatewayChatRunWatermark[]
): ReadonlyMap<string, number> {
    if (watermarks.length > 32) {
        throw new TypeError("Persistent Gateway chat run watermarks are invalid");
    }
    const resolved = new Map<string, number>();
    for (const watermark of watermarks) {
        const runId = boundedNonblank(
            watermark.providerRunId,
            256,
            "Persistent Gateway chat run watermark id"
        );
        if (
            !Number.isSafeInteger(watermark.lastProviderSequence) ||
            watermark.lastProviderSequence < 0 ||
            resolved.has(runId)
        ) {
            throw new TypeError("Persistent Gateway chat run watermarks are invalid");
        }
        resolved.set(runId, watermark.lastProviderSequence);
    }
    return resolved;
}

function chatRunWatermarkMapsEqual(
    left: ReadonlyMap<string, number>,
    right: ReadonlyMap<string, number>
): boolean {
    if (left.size !== right.size) return false;
    for (const [runId, sequence] of left) {
        if (right.get(runId) !== sequence) return false;
    }
    return true;
}

function safeNow(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Persistent Gateway clock is invalid");
    }
    return value;
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function deliveredChatEventRetainedBytes(
    event: PersistentGatewayDeliveredChatEvent
): number {
    try {
        return byteLength(JSON.stringify(event));
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function closeReason(value: string): string {
    return byteLength(value) <= safeCloseReasonMaximumBytes ? value : "gateway failure";
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function detailCode(details: unknown): string | undefined {
    if (details === null || typeof details !== "object" || Array.isArray(details)) {
        return undefined;
    }
    const value = (details as Readonly<Record<string, unknown>>).code;
    return typeof value === "string" && value.length <= 128 ? value : undefined;
}

function sanitizedRequestReason(
    details: unknown,
    method: string,
    code: PersistentGatewayErrorCode,
    message: string
): PersistentGatewayRequestReason | undefined {
    if (
        method === "config.patch" &&
        code === "INVALID_REQUEST" &&
        message === "config changed since last load; re-run config.get and retry"
    ) {
        return persistentGatewayConfigurationChangedReason;
    }
    if (
        method === "tasks.get" &&
        code === "INVALID_REQUEST" &&
        message.startsWith("task not found: ")
    ) {
        return persistentGatewayTaskNotFoundReason;
    }
    if (
        method === "sessions.companion.ask" &&
        code === "UNAVAILABLE" &&
        detailCode(details) === "SESSION_COMPANION_BUSY"
    ) {
        return persistentGatewaySessionCompanionBusyReason;
    }
    if (details === null || typeof details !== "object" || Array.isArray(details)) {
        return undefined;
    }
    const record = details as Readonly<Record<string, unknown>>;
    if (record.reason === persistentGatewaySessionChangedReason) {
        return persistentGatewaySessionChangedReason;
    }
    return record.code === "CRON_JOB_CHANGED"
        ? persistentGatewayCronJobChangedReason
        : undefined;
}

function isTerminalAuthenticationFailure(error: {
    readonly code: PersistentGatewayErrorCode;
    readonly details?: unknown;
}): boolean {
    return terminalAuthenticationDetailCodes.has(detailCode(error.details) ?? "");
}

function frozenSnapshot(
    snapshot: PersistentGatewayConnectionSnapshot
): PersistentGatewayConnectionSnapshot {
    if (snapshot.lastKnownGood !== undefined) Object.freeze(snapshot.lastKnownGood);
    return Object.freeze(snapshot);
}

function resolveOptions(
    options: PersistentGatewayTransportOptions,
    profile: Exclude<
        PersistentGatewayConnectionProfile,
        "admin" | "chat-read-mutation" | "chat-write"
    >
): ResolvedPersistentGatewayOptions {
    const token = Redacted.value(options.token);
    if (token.length === 0 || byteLength(token) > 16 * 1024) {
        throw new TypeError("Persistent Gateway credential is invalid");
    }
    const reconnectInitial = boundedInteger(
        options.reconnect?.initialDelayMs,
        1000,
        1,
        5 * 60 * 1000,
        "Persistent Gateway reconnect delay"
    );
    const reconnectMaximum = boundedInteger(
        options.reconnect?.maximumDelayMs,
        30_000,
        reconnectInitial,
        30 * 60 * 1000,
        "Persistent Gateway maximum reconnect delay"
    );
    const instanceId = boundedNonblank(
        options.instanceId ?? Bun.randomUUIDv7(),
        128,
        "Persistent Gateway instance id"
    );
    return Object.freeze({
        adminConcurrencyMaximum: boundedInteger(
            options.adminConcurrencyMaximum,
            2,
            1,
            8,
            "Persistent Gateway admin concurrency"
        ),
        bufferedAmountMaximumBytes: boundedInteger(
            options.bufferedAmountMaximumBytes,
            persistentGatewayBufferedAmountMaximumBytes,
            1024,
            persistentGatewayBufferedAmountMaximumBytes,
            "Persistent Gateway buffered amount"
        ),
        chatOutboundFrameMaximumBytes: boundedInteger(
            options.chatOutboundFrameMaximumBytes,
            persistentGatewayChatOutboundFrameMaximumBytes,
            1024,
            persistentGatewayChatOutboundFrameMaximumBytes,
            "Persistent Gateway chat outbound frame limit"
        ),
        clientVersion: boundedNonblank(
            options.clientVersion,
            128,
            "Persistent Gateway client version"
        ),
        createRequestId: options.createRequestId ?? (() => Bun.randomUUIDv7()),
        gracefulStopTimeoutMs: boundedInteger(
            options.gracefulStopTimeoutMs,
            2000,
            1,
            60_000,
            "Persistent Gateway stop timeout"
        ),
        handshakeTimeoutMs: boundedInteger(
            options.handshakeTimeoutMs,
            10_000,
            1,
            60_000,
            "Persistent Gateway handshake timeout"
        ),
        instanceId,
        nowMs: options.nowMs ?? Date.now,
        outboundFrameMaximumBytes: boundedInteger(
            options.outboundFrameMaximumBytes,
            persistentGatewayOutboundFrameMaximumBytes,
            1024,
            persistentGatewayAuthenticatedFrameMaximumBytes,
            "Persistent Gateway outbound frame limit"
        ),
        pendingRequestMaximum: boundedInteger(
            options.pendingRequestMaximum,
            128,
            1,
            256,
            "Persistent Gateway pending request limit"
        ),
        profile,
        random: options.random ?? Math.random,
        reconnect: Object.freeze({
            factor: boundedNumber(
                options.reconnect?.factor,
                2,
                1,
                10,
                "Persistent Gateway reconnect factor"
            ),
            initialDelayMs: reconnectInitial,
            jitterRatio: boundedNumber(
                options.reconnect?.jitterRatio,
                0.2,
                0,
                1,
                "Persistent Gateway reconnect jitter"
            ),
            maximumDelayMs: reconnectMaximum,
        }),
        requestTimeoutMs: boundedInteger(
            options.requestTimeoutMs,
            15_000,
            1,
            5 * 60 * 1000,
            "Persistent Gateway request timeout"
        ),
        scheduler: options.scheduler ?? defaultScheduler,
        tickTimeoutMultiplier: boundedNumber(
            options.tickTimeoutMultiplier,
            2,
            1,
            10,
            "Persistent Gateway tick timeout multiplier"
        ),
        token: options.token,
        url: parseGatewayCredentialVerifierUrl(options.url),
        webSocketFactory: options.webSocketFactory ?? ((url) => new WebSocket(url)),
    });
}

class GatewaySocketLane {
    readonly #callbacks: GatewaySocketLaneCallbacks;
    readonly #configuredBufferedAmountMaximumBytes: number;
    readonly #generation: number;
    readonly #profile: PersistentGatewayConnectionProfile;
    readonly #resolved: ResolvedPersistentGatewayOptions;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #retiredRequestIds = new Set<string>();
    readonly #closePromise: Promise<void>;
    readonly #resolveClose: () => void;
    #advertisedMethods = new Set<string>();
    #connectRequestId: string | undefined;
    #connected = false;
    readonly #configuredOutboundFrameMaximumBytes: number;
    #disposition: LaneCloseDisposition = Object.freeze({
        reconnect: true,
        requested: false,
    });
    #handshakeTimer: TimerHandle | undefined;
    #hello: PersistentGatewayHello | undefined;
    #lastActivityAtMs: number | undefined;
    #lastSequence: number | undefined;
    #negotiatedBufferedAmountMaximumBytes: number;
    #negotiatedOutboundFrameMaximumBytes: number;
    #socket: WebSocket | undefined;
    #stage: GatewayLaneStage = "opening";
    #subscriptionRequestId: string | undefined;
    #watchdogTimer: TimerHandle | undefined;
    #watchdogTimeoutMs: number | undefined;

    constructor(options: GatewaySocketLaneOptions) {
        this.#callbacks = options.callbacks;
        this.#configuredBufferedAmountMaximumBytes =
            options.bufferedAmountMaximumBytes ??
            options.resolved.bufferedAmountMaximumBytes;
        this.#configuredOutboundFrameMaximumBytes =
            options.outboundFrameMaximumBytes ??
            options.resolved.outboundFrameMaximumBytes;
        this.#generation = options.generation;
        this.#profile = options.profile;
        this.#resolved = options.resolved;
        this.#negotiatedBufferedAmountMaximumBytes =
            this.#configuredBufferedAmountMaximumBytes;
        this.#negotiatedOutboundFrameMaximumBytes =
            this.#configuredOutboundFrameMaximumBytes;
        const close = Promise.withResolvers<void>();
        this.#closePromise = close.promise;
        this.#resolveClose = close.resolve;
    }

    get connected(): boolean {
        return this.#connected && this.#stage === "connected";
    }

    get pendingCount(): number {
        return this.#pending.size;
    }

    open(): void {
        if (this.#stage !== "opening") return;
        let socket: WebSocket;
        try {
            socket = this.#resolved.webSocketFactory(this.#resolved.url);
        } catch {
            this.#disposition = Object.freeze({
                failure: "transport",
                reconnect: true,
                requested: false,
            });
            this.#finishClose();
            return;
        }
        this.#socket = socket;
        this.#stage = "awaiting-challenge";
        const onOpen = () => this.#onOpen(socket);
        const onMessage = (event: Event) =>
            this.#onMessage(socket, event as MessageEvent);
        const onClose = () => this.#onClose(socket);
        const onError = () => this.#onError(socket);
        try {
            socket.addEventListener("open", onOpen, { once: true });
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose, { once: true });
            socket.addEventListener("error", onError, { once: true });
        } catch {
            this.#fail("transport", true, policyCloseCode, "transport setup failed");
            return;
        }
        this.#armHandshakeTimeout();
    }

    async closeAndWait(timeoutMs: number): Promise<void> {
        this.#requestClose(normalCloseCode, "gateway lane complete");
        if (this.#stage === "closed") return;
        let timeoutHandle: TimerHandle | undefined;
        try {
            await Promise.race([
                this.#closePromise,
                new Promise<never>((_resolve, reject) => {
                    timeoutHandle = this.#resolved.scheduler.setTimeout(
                        () => reject(new PersistentGatewayStopTimeoutError()),
                        timeoutMs
                    );
                }),
            ]);
        } finally {
            if (timeoutHandle !== undefined) {
                this.#resolved.scheduler.clearTimeout(timeoutHandle);
            }
        }
    }

    abort(): void {
        this.#disposition = Object.freeze({ reconnect: false, requested: true });
        this.#requestClose(normalCloseCode, "gateway request aborted");
    }

    request(
        method: string,
        parameters: Readonly<Record<string, unknown>>,
        options: GatewaySocketLaneRequestOptions = {}
    ): Promise<unknown> {
        if (!this.connected || this.#socket?.readyState !== socketOpenState) {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        if (!this.#advertisedMethods.has(method)) {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        if (this.#pending.size >= this.#resolved.pendingRequestMaximum) {
            return Promise.reject(new PersistentGatewayCapacityError());
        }
        if (options.signal?.aborted === true) {
            return Promise.reject(new PersistentGatewayAbortError());
        }
        const timeoutMs = boundedInteger(
            options.timeoutMs,
            this.#resolved.requestTimeoutMs,
            1,
            options.timeoutMaximumMs ?? requestTimeoutMaximumDefaultMs,
            "Persistent Gateway request timeout"
        );
        let id: string;
        try {
            id = boundedNonblank(
                this.#resolved.createRequestId(),
                128,
                "Persistent Gateway request id"
            );
        } catch {
            return Promise.reject(new PersistentGatewayCapacityError());
        }
        if (
            this.#pending.has(id) ||
            this.#retiredRequestIds.has(id) ||
            id === this.#connectRequestId
        ) {
            return Promise.reject(new PersistentGatewayCapacityError());
        }

        return new Promise<unknown>((resolve, reject) => {
            const pending: PendingRequest = {
                method,
                onResponseBytes: options.onResponseBytes,
                reject,
                resolve,
                signal: options.signal,
                timeoutHandle: undefined,
            };
            const abortListener = (): void => {
                if (this.#pending.delete(id)) {
                    this.#cleanupPending(pending);
                    this.#retireRequestId(id);
                    reject(new PersistentGatewayAbortError());
                }
            };
            pending.abortListener = abortListener;
            pending.timeoutHandle = this.#resolved.scheduler.setTimeout(() => {
                if (this.#pending.delete(id)) {
                    this.#cleanupPending(pending);
                    this.#retireRequestId(id);
                    reject(new PersistentGatewayTimeoutError(method));
                }
            }, timeoutMs);
            options.signal?.addEventListener("abort", abortListener, { once: true });
            this.#pending.set(id, pending);
            try {
                this.#send({ id, method, params: parameters, type: "req" });
            } catch (error) {
                this.#pending.delete(id);
                this.#cleanupPending(pending);
                if (error instanceof PersistentGatewayCapacityError) {
                    reject(error);
                    return;
                }
                reject(new PersistentGatewayUnavailableError());
                this.#fail("transport", true, policyCloseCode, "request send failed");
                return;
            }
            // Do not move this before #send: a capacity rejection or native send
            // throw is a known pre-dispatch failure. The callback is internal and
            // must never alter the already-dispatched request.
            try {
                options.onDispatched?.();
            } catch {
                // Dispatch observation is bookkeeping, not request execution.
            }
        });
    }

    #armHandshakeTimeout(): void {
        this.#clearHandshakeTimeout();
        this.#handshakeTimer = this.#resolved.scheduler.setTimeout(
            () =>
                this.#fail(
                    "handshake-timeout",
                    true,
                    policyCloseCode,
                    "gateway handshake timeout"
                ),
            this.#resolved.handshakeTimeoutMs
        );
    }

    #armWatchdog(hello: PersistentGatewayHello): void {
        this.#clearWatchdog();
        this.#watchdogTimeoutMs = Math.max(
            1,
            Math.floor(hello.policy.tickIntervalMs * this.#resolved.tickTimeoutMultiplier)
        );
        this.#scheduleWatchdogCheck(this.#watchdogTimeoutMs);
    }

    #clearHandshakeTimeout(): void {
        if (this.#handshakeTimer !== undefined) {
            this.#resolved.scheduler.clearTimeout(this.#handshakeTimer);
            this.#handshakeTimer = undefined;
        }
    }

    #clearWatchdog(): void {
        if (this.#watchdogTimer !== undefined) {
            this.#resolved.scheduler.clearTimeout(this.#watchdogTimer);
            this.#watchdogTimer = undefined;
        }
        this.#watchdogTimeoutMs = undefined;
    }

    #cleanupPending(pending: PendingRequest): void {
        if (pending.timeoutHandle !== undefined) {
            this.#resolved.scheduler.clearTimeout(pending.timeoutHandle);
        }
        if (pending.abortListener !== undefined) {
            pending.signal?.removeEventListener("abort", pending.abortListener);
        }
    }

    #fail(
        failure: PersistentGatewayFailureKind,
        reconnect: boolean,
        code: number,
        reason: string,
        reconnectDelayMs?: number
    ): void {
        if (this.#stage === "closed") return;
        this.#disposition = Object.freeze({
            failure,
            reconnect,
            ...(reconnectDelayMs === undefined ? {} : { reconnectDelayMs }),
            requested: false,
        });
        this.#requestClose(code, reason);
    }

    #finishClose(): void {
        if (this.#stage === "closed") return;
        const wasConnected = this.#connected;
        this.#stage = "closed";
        this.#connected = false;
        this.#clearHandshakeTimeout();
        this.#clearWatchdog();
        this.#rejectAllPending();
        this.#resolveClose();
        this.#callbacks.onClosed({
            ...this.#disposition,
            connected: wasConnected,
            generation: this.#generation,
        });
    }

    #isActive(socket: WebSocket): boolean {
        return this.#socket === socket && this.#stage !== "closed";
    }

    #markActivity(hello?: PersistentGatewayHello, lastEventSequence?: number): void {
        const atMs = safeNow(this.#resolved.nowMs);
        this.#lastActivityAtMs = atMs;
        this.#callbacks.onActivity(atMs, lastEventSequence);
        if (hello !== undefined) this.#armWatchdog(hello);
    }

    #onClose(socket: WebSocket): void {
        if (!this.#isActive(socket)) return;
        this.#socket = undefined;
        if (!this.#disposition.requested && this.#disposition.failure === undefined) {
            this.#disposition = Object.freeze({
                failure: "transport",
                reconnect: true,
                requested: false,
            });
        }
        this.#finishClose();
    }

    #onError(socket: WebSocket): void {
        if (!this.#isActive(socket)) return;
        this.#fail("transport", true, policyCloseCode, "gateway transport failed");
    }

    #onEvent(
        envelope: PersistentGatewayEventEnvelope,
        frame: PersistentGatewayEventFrame | undefined,
        chatEvent: PersistentGatewayPrivateChatEvent | undefined
    ): void {
        if (envelope.seq !== undefined) {
            const expected =
                this.#lastSequence === undefined ? 1 : this.#lastSequence + 1;
            if (envelope.seq !== expected) {
                this.#callbacks.onEventGap(expected, envelope.seq);
                this.#fail(
                    "event-gap",
                    true,
                    policyCloseCode,
                    "gateway event sequence gap"
                );
                return;
            }
            this.#lastSequence = envelope.seq;
        }
        const receivedAtMs = safeNow(this.#resolved.nowMs);
        this.#lastActivityAtMs = receivedAtMs;
        this.#callbacks.onActivity(receivedAtMs, envelope.seq);
        if (frame !== undefined) this.#callbacks.onEvent(frame, receivedAtMs);
        if (chatEvent !== undefined) {
            this.#callbacks.onChatEvent(chatEvent, receivedAtMs);
        }
    }

    #onAuthenticatedEvent(value: unknown, deliver: boolean): boolean {
        const envelope = parsePersistentGatewayEventEnvelope(value);
        if (envelope === undefined) return false;
        if (envelope.event === "connect.challenge") {
            this.#fail("protocol", false, policyCloseCode, "duplicate gateway challenge");
            return true;
        }
        const privateChatEnvelope =
            envelope.event === "chat" ||
            envelope.event === "agent" ||
            envelope.event === "session.tool";
        const chatEvent =
            deliver && privateChatEnvelope
                ? parsePersistentGatewayPrivateChatEvent(value)
                : undefined;
        if (
            deliver &&
            (envelope.event === "chat" || envelope.event === "agent") &&
            chatEvent === undefined
        ) {
            this.#fail("protocol", true, policyCloseCode, "invalid gateway chat event");
            return true;
        }
        this.#onEvent(
            envelope,
            deliver ? parsePersistentGatewayEvent(value) : undefined,
            chatEvent
        );
        return true;
    }

    #finishHandshake(hello: PersistentGatewayHello): void {
        this.#clearHandshakeTimeout();
        this.#hello = undefined;
        this.#subscriptionRequestId = undefined;
        this.#stage = "connected";
        this.#connected = true;
        this.#markActivity(hello);
        this.#callbacks.onConnected(hello);
    }

    #onHello(response: ReturnType<typeof parsePersistentGatewayResponse>): void {
        if (response === undefined || response.id !== this.#connectRequestId) {
            this.#fail("protocol", false, policyCloseCode, "invalid gateway hello");
            return;
        }
        if (!response.ok) {
            const error = response.error;
            if (error === undefined) {
                this.#fail("protocol", false, policyCloseCode, "invalid gateway hello");
                return;
            }
            const terminal = isTerminalAuthenticationFailure(error);
            this.#fail(
                terminal ? "authentication" : "upstream",
                !terminal,
                policyCloseCode,
                "gateway connect rejected",
                error.retryable === true ? error.retryAfterMs : undefined
            );
            return;
        }
        const hello = parsePersistentGatewayHello(response.payload, this.#profile);
        if (hello === undefined) {
            this.#fail("protocol", false, policyCloseCode, "invalid gateway hello");
            return;
        }
        this.#advertisedMethods = new Set(hello.features.methods);
        this.#negotiatedBufferedAmountMaximumBytes = Math.min(
            this.#configuredBufferedAmountMaximumBytes,
            hello.policy.maxBufferedBytes
        );
        this.#negotiatedOutboundFrameMaximumBytes = Math.min(
            this.#configuredOutboundFrameMaximumBytes,
            hello.policy.maxPayload
        );
        this.#markActivity();
        if (this.#profile !== "web-read") {
            this.#finishHandshake(hello);
            return;
        }

        // Only the web-read lane subscribes to public Gateway events. Worker and
        // one-shot admin lanes complete their handshakes without a subscription.
        if (!this.#advertisedMethods.has("sessions.subscribe")) {
            this.#fail(
                "protocol",
                true,
                policyCloseCode,
                "gateway subscription unavailable"
            );
            return;
        }
        let requestId: string;
        try {
            requestId = boundedNonblank(
                this.#resolved.createRequestId(),
                128,
                "Persistent Gateway request id"
            );
        } catch {
            this.#fail(
                "protocol",
                true,
                policyCloseCode,
                "gateway subscription unavailable"
            );
            return;
        }
        if (requestId === this.#connectRequestId) {
            this.#fail(
                "protocol",
                true,
                policyCloseCode,
                "gateway subscription unavailable"
            );
            return;
        }
        this.#hello = hello;
        this.#subscriptionRequestId = requestId;
        this.#stage = "awaiting-subscription";
        this.#armHandshakeTimeout();
        try {
            this.#send({
                id: requestId,
                method: "sessions.subscribe",
                params: {},
                type: "req",
            });
        } catch {
            this.#fail("transport", true, policyCloseCode, "gateway subscription failed");
        }
    }

    #onSubscription(response: ReturnType<typeof parsePersistentGatewayResponse>): void {
        if (response === undefined || response.id !== this.#subscriptionRequestId) {
            this.#fail("protocol", true, policyCloseCode, "invalid gateway subscription");
            return;
        }
        if (!response.ok) {
            this.#fail(
                "upstream",
                true,
                policyCloseCode,
                "gateway subscription rejected",
                response.error?.retryable === true
                    ? response.error.retryAfterMs
                    : undefined
            );
            return;
        }
        const hello = this.#hello;
        if (
            hello === undefined ||
            parsePersistentGatewaySessionsSubscriptionAcknowledgement(
                response.payload
            ) !== true
        ) {
            this.#fail("protocol", true, policyCloseCode, "invalid gateway subscription");
            return;
        }
        this.#finishHandshake(hello);
    }

    #onMessage(socket: WebSocket, event: MessageEvent): void {
        if (!this.#isActive(socket)) return;
        const maximumBytes =
            this.#stage === "awaiting-challenge"
                ? persistentGatewayChallengeFrameMaximumBytes
                : persistentGatewayAuthenticatedFrameMaximumBytes;
        if (typeof event.data !== "string") {
            this.#fail("protocol", false, policyCloseCode, "invalid gateway frame");
            return;
        }
        const responseBytes = byteLength(event.data);
        if (responseBytes > maximumBytes) {
            this.#fail("protocol", false, policyCloseCode, "invalid gateway frame");
            return;
        }
        const decoded = parseJson(event.data);
        if (decoded === undefined) {
            this.#fail("protocol", false, policyCloseCode, "invalid gateway frame");
            return;
        }

        if (this.#stage === "awaiting-challenge") {
            const challenge = parsePersistentGatewayChallenge(decoded);
            if (challenge === undefined || socket.readyState !== socketOpenState) {
                this.#fail(
                    "protocol",
                    false,
                    policyCloseCode,
                    "invalid gateway challenge"
                );
                return;
            }
            const requestId = boundedNonblank(
                this.#resolved.createRequestId(),
                128,
                "Persistent Gateway request id"
            );
            this.#connectRequestId = requestId;
            try {
                this.#send(
                    createPersistentGatewayConnectFrame({
                        clientVersion: this.#resolved.clientVersion,
                        credential: Redacted.value(this.#resolved.token),
                        instanceId: this.#resolved.instanceId,
                        profile: this.#profile,
                        requestId,
                    })
                );
            } catch {
                this.#fail("transport", true, policyCloseCode, "gateway connect failed");
                return;
            }
            this.#stage = "awaiting-hello";
            return;
        }

        if (this.#stage === "awaiting-hello") {
            this.#onHello(parsePersistentGatewayResponse(decoded));
            return;
        }

        if (this.#stage === "awaiting-subscription") {
            const response = parsePersistentGatewayResponse(decoded);
            if (response !== undefined) {
                this.#markActivity();
                this.#onSubscription(response);
                return;
            }
            if (this.#onAuthenticatedEvent(decoded, false)) return;
            this.#fail(
                "protocol",
                true,
                policyCloseCode,
                "invalid gateway subscription frame"
            );
            return;
        }

        if (this.#stage !== "connected") {
            this.#fail("protocol", false, policyCloseCode, "invalid gateway frame order");
            return;
        }

        const response = parsePersistentGatewayResponse(decoded);
        if (response !== undefined) {
            this.#markActivity();
            this.#settleResponse(response, responseBytes);
            return;
        }
        if (this.#onAuthenticatedEvent(decoded, true)) return;
        this.#fail("protocol", false, policyCloseCode, "invalid gateway frame");
    }

    #onOpen(socket: WebSocket): void {
        if (!this.#isActive(socket) || socket.readyState !== socketOpenState) {
            this.#fail("transport", true, policyCloseCode, "gateway open failed");
        }
    }

    #rejectAllPending(): void {
        const error = new PersistentGatewayUnavailableError();
        for (const pending of this.#pending.values()) {
            this.#cleanupPending(pending);
            pending.reject(error);
        }
        this.#pending.clear();
    }

    #retireRequestId(id: string): void {
        this.#retiredRequestIds.delete(id);
        this.#retiredRequestIds.add(id);
        const maximum = Math.min(512, this.#resolved.pendingRequestMaximum * 2);
        while (this.#retiredRequestIds.size > maximum) {
            const oldest = this.#retiredRequestIds.values().next().value;
            if (typeof oldest === "string") this.#retiredRequestIds.delete(oldest);
        }
    }

    #requestClose(code: number, reason: string): void {
        if (this.#stage === "closed") return;
        const socket = this.#socket;
        if (socket === undefined) {
            this.#finishClose();
            return;
        }
        if (this.#disposition.requested === false && code === normalCloseCode) {
            this.#disposition = Object.freeze({ reconnect: false, requested: true });
        }
        this.#clearHandshakeTimeout();
        this.#clearWatchdog();
        this.#rejectAllPending();
        try {
            if (socket.readyState === socketClosedState) {
                this.#socket = undefined;
                this.#finishClose();
                return;
            }
            if (
                socket.readyState === socketConnectingState ||
                socket.readyState === socketOpenState
            ) {
                socket.close(code, closeReason(reason));
            }
        } catch {
            try {
                if (socket.readyState === socketClosedState) {
                    this.#socket = undefined;
                    this.#finishClose();
                }
            } catch {
                // Native close observation remains authoritative.
            }
        }
    }

    #send(frame: Readonly<Record<string, unknown>>): void {
        const socket = this.#socket;
        if (socket === undefined || socket.readyState !== socketOpenState) {
            throw new PersistentGatewayUnavailableError();
        }
        let encoded: string;
        try {
            encoded = JSON.stringify(frame);
        } catch {
            throw new PersistentGatewayCapacityError();
        }
        const encodedBytes = byteLength(encoded);
        const bufferedAmount =
            Number.isSafeInteger(socket.bufferedAmount) && socket.bufferedAmount >= 0
                ? socket.bufferedAmount
                : this.#negotiatedBufferedAmountMaximumBytes;
        if (
            encodedBytes > this.#negotiatedOutboundFrameMaximumBytes ||
            bufferedAmount + encodedBytes > this.#negotiatedBufferedAmountMaximumBytes
        ) {
            throw new PersistentGatewayCapacityError();
        }
        socket.send(encoded);
    }

    #scheduleWatchdogCheck(delayMs: number): void {
        this.#watchdogTimer = this.#resolved.scheduler.setTimeout(() => {
            const lastActivityAtMs = this.#lastActivityAtMs;
            const timeoutMs = this.#watchdogTimeoutMs;
            if (
                lastActivityAtMs === undefined ||
                timeoutMs === undefined ||
                this.#stage !== "connected"
            ) {
                return;
            }
            const elapsed = safeNow(this.#resolved.nowMs) - lastActivityAtMs;
            if (elapsed >= timeoutMs) {
                this.#fail(
                    "tick-timeout",
                    true,
                    watchdogCloseCode,
                    "gateway tick timeout"
                );
                return;
            }
            this.#scheduleWatchdogCheck(timeoutMs - elapsed);
        }, delayMs);
    }

    #settleResponse(
        response: NonNullable<ReturnType<typeof parsePersistentGatewayResponse>>,
        responseBytes: number
    ): void {
        const pending = this.#pending.get(response.id);
        if (pending === undefined) {
            if (this.#retiredRequestIds.delete(response.id)) return;
            this.#fail("protocol", true, policyCloseCode, "unmatched gateway response");
            return;
        }
        this.#pending.delete(response.id);
        this.#cleanupPending(pending);
        if (response.ok) {
            try {
                pending.onResponseBytes?.(responseBytes);
            } catch {
                // Byte observation is internal bookkeeping and cannot replace a response.
            }
            pending.resolve(response.payload);
            return;
        }
        const error = response.error;
        if (error === undefined) {
            pending.reject(new PersistentGatewayUnavailableError());
            this.#fail("protocol", false, policyCloseCode, "invalid gateway response");
            return;
        }
        pending.reject(
            new PersistentGatewayRequestError({
                code: error.code,
                reason: sanitizedRequestReason(
                    error.details,
                    pending.method,
                    error.code,
                    error.message
                ),
                retryable: error.retryable,
                retryAfterMs: error.retryAfterMs,
            })
        );
    }
}

interface PersistentGatewayTransportLifecycle {
    start(): void;
    stop(): Promise<void>;
}

/** Public web process port: persistent reads, events, and bounded fresh admin lanes. */
export interface PersistentGatewayTransport extends PersistentGatewayTransportLifecycle {
    readonly snapshot: PersistentGatewayConnectionSnapshot;
    request(
        method: PersistentGatewayReadWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestAdmin(
        method: PersistentGatewayAdminMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestOpenClawSettingsRead(
        method: PersistentGatewayOpenClawSettingsReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestOpenClawSettingsWrite(
        method: PersistentGatewayOpenClawSettingsWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayOpenClawSettingsWriteOptions
    ): Promise<unknown>;
    requestChatRead(
        method: PersistentGatewayChatReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestChatReadMutation(
        method: PersistentGatewayChatReadMutationMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestChatWrite(
        method: PersistentGatewayChatWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestTaskRead(
        method: PersistentGatewayTaskReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    requestTaskWrite(
        method: PersistentGatewayTaskWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown>;
    subscribe(listener: PersistentGatewayListener): () => void;
    subscribeChat(
        subscription: PersistentGatewayChatSubscription,
        listener: PersistentGatewayChatListener
    ): () => void;
}

/** Worker-only port with notification sending and exact privileged operation methods. */
export interface PersistentGatewayTaskNotificationTransport extends PersistentGatewayTransportLifecycle {
    readonly taskNotificationSender: TaskNotificationChatSender;
    requestOpenClawServiceAction(
        method: PersistentGatewayOpenClawServiceActionMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<PersistentGatewayOpenClawServiceActionResponse>;
}

class PersistentGatewayTransportImplementation
    implements PersistentGatewayTransport, PersistentGatewayTaskNotificationTransport
{
    readonly taskNotificationSender: TaskNotificationChatSender;
    readonly #adminLanes = new Set<GatewaySocketLane>();
    readonly #companionAskAdmissions: number[] = [];
    readonly #chatScopes = new Map<string, ChatSubscriptionScope>();
    readonly #listeners = new Map<PersistentGatewayListener, object>();
    readonly #resolved: ResolvedPersistentGatewayOptions;
    #generation = 0;
    #lane: GatewaySocketLane | undefined;
    #permanentlyStopped = false;
    #reconnectAttempt = 0;
    #reconnectTimer: TimerHandle | undefined;
    #snapshot: PersistentGatewayConnectionSnapshot = frozenSnapshot({
        connectionGeneration: 0,
        phase: "stopped",
        reconnectAttempt: 0,
    });
    #started = false;
    #stopPromise: Promise<void> | undefined;

    constructor(
        options: PersistentGatewayTransportOptions,
        profile: Exclude<
            PersistentGatewayConnectionProfile,
            "admin" | "chat-read-mutation" | "chat-write"
        >
    ) {
        this.#resolved = resolveOptions(options, profile);
        this.taskNotificationSender = Object.freeze<TaskNotificationChatSender>({
            send: (
                input: Parameters<TaskNotificationChatSender["send"]>[0],
                signal: AbortSignal
            ) => this.#sendTaskNotification(input, signal),
        });
    }

    get snapshot(): PersistentGatewayConnectionSnapshot {
        return this.#snapshot;
    }

    request(
        method: PersistentGatewayReadWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayReadWriteMethod(method)
        ) {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        try {
            assertPersistentGatewayReadWriteParameters(method, parameters);
        } catch {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        return (
            this.#lane?.request(method, parameters, options) ??
            Promise.reject(new PersistentGatewayUnavailableError())
        );
    }

    requestOpenClawSettingsRead(
        method: PersistentGatewayOpenClawSettingsReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayOpenClawSettingsReadMethod(method)
        ) {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        try {
            assertPersistentGatewayOpenClawSettingsReadParameters(method, parameters);
        } catch {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        return (
            this.#lane?.request(method, parameters, options) ??
            Promise.reject(new PersistentGatewayUnavailableError())
        );
    }

    requestChatRead(
        method: PersistentGatewayChatReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayChatReadMethod(method)
        ) {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        try {
            assertPersistentGatewayChatReadParameters(method, parameters);
        } catch {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        return (
            this.#lane?.request(method, parameters, options) ??
            Promise.reject(new PersistentGatewayUnavailableError())
        );
    }

    async requestChatReadMutation(
        method: PersistentGatewayChatReadMutationMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayRequestOptions = {}
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayChatReadMutationMethod(method)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        try {
            assertPersistentGatewayChatReadMutationParameters(method, parameters);
        } catch {
            throw new PersistentGatewayUnavailableError();
        }
        this.#assertOneShotAdmission(options);
        const admission = this.#reserveCompanionAskRateAdmission();
        try {
            return await this.#runOneShotRequest(
                "chat-read-mutation",
                method,
                parameters,
                options,
                this.#resolved.bufferedAmountMaximumBytes,
                this.#resolved.outboundFrameMaximumBytes
            );
        } catch (error) {
            if (
                !(error instanceof PersistentGatewayUnknownOutcomeError) &&
                (!(error instanceof PersistentGatewayRequestError) ||
                    error.reason === persistentGatewaySessionCompanionBusyReason)
            ) {
                this.#releaseCompanionAskRateAdmission(admission);
            }
            throw error;
        }
    }

    async requestChatWrite(
        method: PersistentGatewayChatWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayRequestOptions = {}
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayChatWriteMethod(method)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        try {
            assertPersistentGatewayChatWriteParameters(method, parameters);
        } catch {
            throw new PersistentGatewayUnavailableError();
        }
        this.#assertOneShotAdmission(options);
        return this.#runOneShotRequest(
            "chat-write",
            method,
            parameters,
            options,
            this.#resolved.chatOutboundFrameMaximumBytes,
            this.#resolved.chatOutboundFrameMaximumBytes
        );
    }

    requestTaskRead(
        method: PersistentGatewayTaskReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayTaskReadMethod(method)
        ) {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        try {
            assertPersistentGatewayTaskReadParameters(method, parameters);
        } catch {
            return Promise.reject(new PersistentGatewayUnavailableError());
        }
        return (
            this.#lane?.request(method, parameters, options) ??
            Promise.reject(new PersistentGatewayUnavailableError())
        );
    }

    async requestTaskWrite(
        method: PersistentGatewayTaskWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayRequestOptions = {}
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayTaskWriteMethod(method)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        try {
            assertPersistentGatewayTaskWriteParameters(method, parameters);
        } catch {
            throw new PersistentGatewayUnavailableError();
        }
        this.#assertOneShotAdmission(options);
        return this.#runOneShotRequest(
            "chat-write",
            method,
            parameters,
            options,
            this.#resolved.bufferedAmountMaximumBytes,
            this.#resolved.outboundFrameMaximumBytes
        );
    }

    async requestAdmin(
        method: PersistentGatewayAdminMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayRequestOptions = {}
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayAdminMethod(method)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        try {
            assertPersistentGatewayAdminParameters(method, parameters);
        } catch {
            throw new PersistentGatewayUnavailableError();
        }
        this.#assertOneShotAdmission(options);
        return this.#runOneShotRequest(
            "admin",
            method,
            parameters,
            options,
            this.#resolved.bufferedAmountMaximumBytes,
            this.#resolved.outboundFrameMaximumBytes
        );
    }

    async requestOpenClawSettingsWrite(
        method: PersistentGatewayOpenClawSettingsWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayOpenClawSettingsWriteOptions
    ): Promise<unknown> {
        if (
            this.#resolved.profile !== "web-read" ||
            !isPersistentGatewayOpenClawSettingsWriteMethod(method)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        try {
            assertPersistentGatewayOpenClawSettingsWriteParameters(method, parameters);
        } catch {
            throw new PersistentGatewayUnavailableError();
        }
        this.#assertOneShotAdmission(options);
        return this.#runOneShotRequest(
            "admin",
            method,
            parameters,
            options,
            this.#resolved.bufferedAmountMaximumBytes,
            this.#resolved.outboundFrameMaximumBytes
        );
    }

    async requestOpenClawServiceAction(
        method: PersistentGatewayOpenClawServiceActionMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayRequestOptions = {}
    ): Promise<PersistentGatewayOpenClawServiceActionResponse> {
        if (
            this.#resolved.profile !== "task-notification-worker" ||
            !isPersistentGatewayOpenClawServiceActionMethod(method)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        try {
            assertPersistentGatewayOpenClawServiceActionParameters(method, parameters);
        } catch {
            throw new PersistentGatewayUnavailableError();
        }
        this.#assertOneShotAdmission(options);
        const response = await this.#runOneShotRequest(
            "admin",
            method,
            parameters,
            options,
            this.#resolved.bufferedAmountMaximumBytes,
            this.#resolved.outboundFrameMaximumBytes,
            persistentGatewayOpenClawServiceActionRequestTimeoutMs[method]
        );
        try {
            return parsePersistentGatewayOpenClawServiceActionResponse(method, response);
        } catch {
            throw new PersistentGatewayUnknownOutcomeError();
        }
    }

    start(): void {
        if (this.#permanentlyStopped) {
            throw new TypeError("Persistent Gateway transport is stopped");
        }
        if (this.#started) return;
        this.#started = true;
        this.#connect();
    }

    stop(): Promise<void> {
        this.#stopPromise ??= this.#stop();
        return this.#stopPromise;
    }

    subscribe(listener: PersistentGatewayListener): () => void {
        if (this.#permanentlyStopped) {
            this.#invokeListener(() => listener.onState?.(this.#snapshot));
            return () => {};
        }
        const identity = {};
        this.#listeners.set(listener, identity);
        this.#invokeListener(() => listener.onState?.(this.#snapshot));
        return () => {
            if (this.#listeners.get(listener) === identity)
                this.#listeners.delete(listener);
        };
    }

    subscribeChat(
        subscription: PersistentGatewayChatSubscription,
        listener: PersistentGatewayChatListener
    ): () => void {
        if (this.#permanentlyStopped || this.#resolved.profile !== "web-read") {
            queueMicrotask(() => {
                void Promise.resolve()
                    .then(() => listener.onReconciliationRequired?.("transport"))
                    .catch(() => {
                        // Admission-boundary listener failures are contained.
                    });
            });
            return () => {};
        }
        const scopeId = chatSubscriptionScopeIdentifier(subscription);
        const initialRunSequences = chatRunWatermarkMap(subscription.runWatermarks);
        let scope = this.#chatScopes.get(scopeId);
        if (scope === undefined) {
            if (this.#chatScopes.size >= persistentGatewayChatSubscriptionMaximum) {
                throw new PersistentGatewayCapacityError();
            }
            scope = {
                ...(subscription.agentId === undefined
                    ? {}
                    : { agentId: subscription.agentId }),
                initialRunSequences,
                key: subscription.sessionKey,
                runSequences: new Map(),
                subscribers: new Map(),
            };
            this.#chatScopes.set(scopeId, scope);
        } else if (
            !chatRunWatermarkMapsEqual(scope.initialRunSequences, initialRunSequences)
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        const identity = {};
        scope.subscribers.set(identity, {
            draining: false,
            identity,
            listener,
            queue: [],
            queuedEventBytes: 0,
            terminalBoundaryQueued: false,
        });
        if (scope.reconciliationRequired === undefined) {
            this.#synchronizeChatScope(scope);
        } else {
            const subscriber = scope.subscribers.get(identity);
            if (subscriber !== undefined) {
                this.#enqueueChatBoundary(scope, subscriber, {
                    kind: "reconciliation",
                    reason: scope.reconciliationRequired,
                });
            }
        }
        return () => {
            const current = this.#chatScopes.get(scopeId);
            const subscriber = scope.subscribers.get(identity);
            if (current !== scope || subscriber === undefined) return;
            this.#deleteChatSubscriber(scope, subscriber);
        };
    }

    #assertOneShotAdmission(options: PersistentGatewayRequestOptions): void {
        if (this.#permanentlyStopped || options.signal?.aborted === true) {
            throw options.signal?.aborted === true
                ? new PersistentGatewayAbortError()
                : new PersistentGatewayUnavailableError();
        }
        if (this.#adminLanes.size >= this.#resolved.adminConcurrencyMaximum) {
            throw new PersistentGatewayCapacityError();
        }
    }

    #reserveCompanionAskRateAdmission(): number {
        const now = this.#resolved.nowMs();
        const cutoff = now - 60_000;
        while ((this.#companionAskAdmissions[0] ?? now) < cutoff) {
            this.#companionAskAdmissions.shift();
        }
        if (this.#companionAskAdmissions.length >= 4) {
            throw new PersistentGatewayCapacityError();
        }
        this.#companionAskAdmissions.push(now);
        return now;
    }

    #releaseCompanionAskRateAdmission(admission: number): void {
        const index = this.#companionAskAdmissions.indexOf(admission);
        if (index !== -1) this.#companionAskAdmissions.splice(index, 1);
    }

    #clearReconnect(): void {
        if (this.#reconnectTimer !== undefined) {
            this.#resolved.scheduler.clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = undefined;
        }
    }

    #connect(): void {
        if (this.#permanentlyStopped || !this.#started || this.#lane !== undefined)
            return;
        this.#clearReconnect();
        this.#generation += 1;
        const generation = this.#generation;
        this.#setSnapshot({
            ...this.#snapshot,
            connectionGeneration: generation,
            lastFailure: this.#snapshot.lastFailure,
            lastEventSequence: undefined,
            nextReconnectAtMs: undefined,
            phase: "connecting",
            reconnectAttempt: this.#reconnectAttempt,
        });
        const lane = new GatewaySocketLane({
            callbacks: {
                onActivity: (atMs, lastEventSequence) => {
                    if (this.#lane !== lane) return;
                    this.#snapshot = frozenSnapshot({
                        ...this.#snapshot,
                        lastActivityAtMs: atMs,
                        ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
                    });
                },
                onClosed: (report) => this.#handleLaneClosed(lane, report),
                onConnected: (hello) => this.#handleConnected(lane, hello),
                onChatEvent: (frame, receivedAtMs) =>
                    this.#handleChatEvent(lane, frame, receivedAtMs),
                onEvent: (frame, receivedAtMs) =>
                    this.#handleEvent(lane, frame, receivedAtMs),
                onEventGap: (expectedSequence, receivedSequence) => {
                    if (this.#lane !== lane) return;
                    this.#notify((listener) =>
                        listener.onEventGap?.({
                            connectionGeneration: generation,
                            expectedSequence,
                            receivedSequence,
                        })
                    );
                },
            },
            generation,
            profile: this.#resolved.profile,
            resolved: this.#resolved,
        });
        this.#lane = lane;
        lane.open();
    }

    #handleConnected(lane: GatewaySocketLane, hello: PersistentGatewayHello): void {
        if (this.#lane !== lane || this.#permanentlyStopped) return;
        const connectedAtMs = safeNow(this.#resolved.nowMs);
        const lastEventSequence = this.#snapshot.lastEventSequence;
        this.#reconnectAttempt = 0;
        this.#setSnapshot({
            connectedAtMs,
            connectionGeneration: this.#generation,
            lastActivityAtMs: connectedAtMs,
            lastKnownGood: {
                connectedAtMs,
                connectionId: hello.server.connId,
                protocol: hello.protocol,
                serverVersion: hello.server.version,
            },
            ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
            phase: "connected",
            reconnectAttempt: 0,
        });
        for (const scope of this.#chatScopes.values()) {
            this.#synchronizeChatScope(scope);
        }
    }

    #synchronizeChatScope(scope: ChatSubscriptionScope): void {
        const lane = this.#lane;
        const generation = this.#generation;
        if (
            lane === undefined ||
            !lane.connected ||
            this.#snapshot.phase !== "connected" ||
            scope.subscribers.size === 0 ||
            scope.reconciliationRequired !== undefined ||
            scope.subscribedGeneration === generation ||
            scope.synchronizingGeneration === generation
        ) {
            return;
        }
        scope.synchronizingGeneration = generation;
        void lane
            .request(
                "sessions.messages.subscribe",
                {
                    ...(scope.agentId === undefined ? {} : { agentId: scope.agentId }),
                    key: scope.key,
                },
                { timeoutMs: 15_000 }
            )
            .then(
                (payload) => {
                    if (
                        this.#lane !== lane ||
                        this.#generation !== generation ||
                        scope.synchronizingGeneration !== generation
                    ) {
                        return null;
                    }
                    scope.synchronizingGeneration = undefined;
                    const acknowledgement =
                        parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement(
                            payload,
                            true
                        );
                    if (acknowledgement === undefined) {
                        this.#notifyChatScope(scope, "subscription");
                        return null;
                    }
                    scope.canonicalKey = acknowledgement.key;
                    scope.subscribedGeneration = generation;
                    scope.runSequences.clear();
                    for (const [runId, sequence] of scope.initialRunSequences) {
                        scope.runSequences.set(runId, sequence);
                    }
                    if (scope.subscribers.size === 0) this.#unsubscribeChatScope(scope);
                    return null;
                },
                () => {
                    if (scope.synchronizingGeneration === generation) {
                        scope.synchronizingGeneration = undefined;
                    }
                    if (this.#generation === generation) {
                        this.#notifyChatScope(scope, "subscription");
                    }
                    return null;
                }
            );
    }

    #unsubscribeChatScope(scope: ChatSubscriptionScope): void {
        const lane = this.#lane;
        const generation = this.#generation;
        if (
            lane === undefined ||
            !lane.connected ||
            scope.subscribedGeneration !== generation
        ) {
            return;
        }
        scope.subscribedGeneration = undefined;
        void lane
            .request(
                "sessions.messages.unsubscribe",
                {
                    ...(scope.agentId === undefined ? {} : { agentId: scope.agentId }),
                    key: scope.canonicalKey ?? scope.key,
                },
                { timeoutMs: 15_000 }
            )
            .then((payload) => {
                parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement(
                    payload,
                    false
                );
                return null;
            })
            .catch(() => {
                // Closing a local subscription is authoritative. Reconnect clears
                // any surviving upstream connection-scoped subscription.
            });
    }

    #quarantineChatScope(
        scope: ChatSubscriptionScope,
        reason: PersistentGatewayChatReconciliationReason
    ): void {
        scope.reconciliationRequired ??= reason;
        scope.runSequences.clear();
        this.#unsubscribeChatScope(scope);
    }

    #notifyChatScope(
        scope: ChatSubscriptionScope,
        reason: PersistentGatewayChatReconciliationReason
    ): void {
        this.#quarantineChatScope(scope, reason);
        const reconciliationReason = scope.reconciliationRequired ?? reason;
        for (const subscriber of scope.subscribers.values()) {
            this.#enqueueChatBoundary(scope, subscriber, {
                kind: "reconciliation",
                reason: reconciliationReason,
            });
        }
    }

    #clearChatSubscriberQueue(subscriber: ChatSubscriberState): void {
        subscriber.queue.length = 0;
        subscriber.queuedEventBytes = 0;
    }

    #deleteChatSubscriber(
        scope: ChatSubscriptionScope,
        subscriber: ChatSubscriberState
    ): void {
        if (!scope.subscribers.delete(subscriber.identity)) return;
        this.#clearChatSubscriberQueue(subscriber);
        if (scope.subscribers.size > 0) return;
        for (const [scopeId, candidate] of this.#chatScopes) {
            if (candidate === scope) {
                this.#chatScopes.delete(scopeId);
                break;
            }
        }
        this.#unsubscribeChatScope(scope);
    }

    #startChatSubscriberDrain(
        scope: ChatSubscriptionScope,
        subscriber: ChatSubscriberState
    ): void {
        if (subscriber.draining) return;
        subscriber.draining = true;
        queueMicrotask(() => void this.#drainChatSubscriber(scope, subscriber));
    }

    #enqueueChatBoundary(
        scope: ChatSubscriptionScope,
        subscriber: ChatSubscriberState,
        boundary: Exclude<ChatSubscriberQueueItem, { readonly kind: "event" }>
    ): void {
        if (
            subscriber.terminalBoundaryQueued ||
            scope.subscribers.get(subscriber.identity) !== subscriber
        ) {
            return;
        }
        if (boundary.kind === "reconciliation") {
            this.#clearChatSubscriberQueue(subscriber);
        }
        subscriber.terminalBoundaryQueued = true;
        subscriber.queue.push(boundary);
        this.#startChatSubscriberDrain(scope, subscriber);
    }

    #enqueueChatEvent(
        scope: ChatSubscriptionScope,
        subscriber: ChatSubscriberState,
        event: PersistentGatewayDeliveredChatEvent,
        retainedBytes: number
    ): void {
        if (subscriber.terminalBoundaryQueued) return;
        if (
            !Number.isSafeInteger(retainedBytes) ||
            retainedBytes < 0 ||
            retainedBytes > persistentGatewayChatEventQueueMaximumBytes ||
            subscriber.queue.length >= persistentGatewayChatEventQueueMaximum ||
            subscriber.queuedEventBytes + retainedBytes >
                persistentGatewayChatEventQueueMaximumBytes
        ) {
            this.#enqueueChatBoundary(scope, subscriber, {
                kind: "reconciliation",
                reason: "backpressure",
            });
            return;
        }
        subscriber.queuedEventBytes += retainedBytes;
        subscriber.queue.push({ event, kind: "event", retainedBytes });
        this.#startChatSubscriberDrain(scope, subscriber);
    }

    async #drainChatSubscriber(
        scope: ChatSubscriptionScope,
        subscriber: ChatSubscriberState
    ): Promise<void> {
        try {
            while (scope.subscribers.get(subscriber.identity) === subscriber) {
                const item = subscriber.queue.shift();
                if (item === undefined) break;
                try {
                    if (item.kind === "event") {
                        subscriber.queuedEventBytes = Math.max(
                            0,
                            subscriber.queuedEventBytes - item.retainedBytes
                        );
                        await subscriber.listener.onEvent?.(item.event);
                        continue;
                    }
                    await (item.kind === "gap"
                        ? subscriber.listener.onEventGap?.(item.gap)
                        : subscriber.listener.onReconciliationRequired?.(item.reason));
                } catch {
                    if (item.kind !== "reconciliation") {
                        this.#clearChatSubscriberQueue(subscriber);
                        subscriber.terminalBoundaryQueued = true;
                        try {
                            await subscriber.listener.onReconciliationRequired?.(
                                "backpressure"
                            );
                        } catch {
                            // Subscriber failures are contained at this boundary.
                        }
                    }
                }
                this.#deleteChatSubscriber(scope, subscriber);
                return;
            }
        } finally {
            subscriber.draining = false;
            if (
                subscriber.queue.length > 0 &&
                scope.subscribers.get(subscriber.identity) === subscriber
            ) {
                subscriber.draining = true;
                queueMicrotask(() => void this.#drainChatSubscriber(scope, subscriber));
            }
        }
    }

    #handleChatEvent(
        lane: GatewaySocketLane,
        frame: PersistentGatewayPrivateChatEvent,
        receivedAtMs: number
    ): void {
        if (this.#lane !== lane || this.#snapshot.phase !== "connected") return;
        for (const scope of this.#chatScopes.values()) {
            if (
                scope.subscribedGeneration !== this.#generation ||
                scope.reconciliationRequired !== undefined ||
                (scope.canonicalKey ?? scope.key) !== frame.payload.sessionKey ||
                (scope.agentId !== undefined && scope.agentId !== frame.payload.agentId)
            ) {
                continue;
            }
            const sequenceKey = frame.payload.runId;
            const terminal =
                frame.event === "chat" &&
                (frame.payload.state === "final" ||
                    frame.payload.state === "aborted" ||
                    frame.payload.state === "error");
            const previousSequence = scope.runSequences.get(sequenceKey);
            if (previousSequence !== undefined && frame.payload.seq <= previousSequence) {
                // A reconnect can replay provider frames already represented by the
                // durable watermark. They are not a gap and must not cross again.
                continue;
            }
            const expectedSequence = (previousSequence ?? 0) + 1;
            if (previousSequence !== undefined && frame.payload.seq > expectedSequence) {
                const gap: PersistentGatewayChatEventGap = Object.freeze({
                    connectionGeneration: this.#generation,
                    expectedSequence,
                    receivedSequence: frame.payload.seq,
                    runId: frame.payload.runId,
                    sessionKey: frame.payload.sessionKey,
                });
                this.#quarantineChatScope(scope, "backpressure");
                for (const subscriber of scope.subscribers.values()) {
                    this.#enqueueChatBoundary(scope, subscriber, {
                        gap,
                        kind: "gap",
                    });
                }
                continue;
            }
            // sessions.messages.subscribe is a future-event subscription. A run
            // started outside this process can therefore first be observed after
            // sequence one. With no durable watermark, that first frame establishes
            // the baseline; subsequent frames remain strictly contiguous.
            if (terminal) {
                scope.runSequences.delete(sequenceKey);
            } else {
                if (
                    previousSequence === undefined &&
                    scope.runSequences.size >= persistentGatewayChatTrackedRunMaximum
                ) {
                    this.#notifyChatScope(scope, "backpressure");
                    continue;
                }
                scope.runSequences.set(sequenceKey, frame.payload.seq);
            }
            const delivered = Object.freeze({
                connectionGeneration: this.#generation,
                frame,
                receivedAtMs,
            });
            const retainedBytes = deliveredChatEventRetainedBytes(delivered);
            for (const subscriber of scope.subscribers.values()) {
                this.#enqueueChatEvent(scope, subscriber, delivered, retainedBytes);
            }
        }
    }

    #handleEvent(
        lane: GatewaySocketLane,
        frame: PersistentGatewayEventFrame,
        receivedAtMs: number
    ): void {
        if (this.#lane !== lane || this.#snapshot.phase !== "connected") return;
        this.#snapshot = frozenSnapshot({
            ...this.#snapshot,
            lastActivityAtMs: receivedAtMs,
        });
        this.#notify((listener) =>
            listener.onEvent?.({
                connectionGeneration: this.#generation,
                frame,
                receivedAtMs,
            })
        );
    }

    #handleLaneClosed(lane: GatewaySocketLane, report: LaneCloseReport): void {
        if (this.#lane !== lane || report.generation !== this.#generation) return;
        this.#lane = undefined;
        for (const scope of this.#chatScopes.values()) {
            const wasSubscribed =
                scope.subscribedGeneration === this.#generation ||
                scope.synchronizingGeneration === this.#generation;
            scope.subscribedGeneration = undefined;
            scope.synchronizingGeneration = undefined;
            scope.canonicalKey = undefined;
            scope.runSequences.clear();
            if (wasSubscribed) this.#notifyChatScope(scope, "transport");
        }
        const disconnectedAtMs = safeNow(this.#resolved.nowMs);
        if (this.#permanentlyStopped) {
            this.#setSnapshot({
                ...this.#snapshot,
                lastDisconnectedAtMs: disconnectedAtMs,
                nextReconnectAtMs: undefined,
                phase: "stopping",
                reconnectAttempt: 0,
            });
            return;
        }
        const failure = report.failure ?? "transport";
        this.#setSnapshot({
            ...this.#snapshot,
            connectedAtMs: undefined,
            lastDisconnectedAtMs: disconnectedAtMs,
            lastFailure: failure,
            nextReconnectAtMs: undefined,
            phase: "degraded",
            reconnectAttempt: this.#reconnectAttempt,
        });
        if (report.reconnect) this.#scheduleReconnect(report.reconnectDelayMs);
    }

    #invokeListener(callback: () => void): void {
        try {
            callback();
        } catch {
            // Listener defects never alter the transport state machine.
        }
    }

    #notify(callback: (listener: PersistentGatewayListener) => void): void {
        const listeners = [...this.#listeners.entries()];
        for (const [listener, identity] of listeners) {
            if (this.#listeners.get(listener) === identity) {
                this.#invokeListener(() => callback(listener));
            }
        }
    }

    #reconnectDelay(attempt: number): number {
        const reconnect = this.#resolved.reconnect;
        const base = Math.min(
            reconnect.maximumDelayMs,
            reconnect.initialDelayMs * reconnect.factor ** Math.max(0, attempt - 1)
        );
        const random = this.#resolved.random();
        if (!Number.isFinite(random) || random < 0 || random > 1) {
            throw new TypeError("Persistent Gateway random source is invalid");
        }
        const multiplier = 1 - reconnect.jitterRatio + 2 * reconnect.jitterRatio * random;
        return Math.max(
            1,
            Math.min(reconnect.maximumDelayMs, Math.round(base * multiplier))
        );
    }

    async #sendTaskNotification(
        input: Parameters<TaskNotificationChatSender["send"]>[0],
        signal: AbortSignal
    ): Promise<void> {
        if (this.#resolved.profile !== "task-notification-worker") {
            throw new PersistentGatewayUnavailableError();
        }
        const eventId = input.idempotencyKey.startsWith(
            taskNotificationIdempotencyKeyPrefix
        )
            ? input.idempotencyKey.slice(taskNotificationIdempotencyKeyPrefix.length)
            : "";
        if (
            input.sessionKey !== miraMainSessionKey ||
            !v.safeParse(taskNotificationMessageSchema, input.message, {
                abortEarly: true,
            }).success ||
            !v.safeParse(taskNotificationEventIdSchema, eventId, {
                abortEarly: true,
            }).success
        ) {
            throw new PersistentGatewayUnavailableError();
        }
        const payload = await (this.#lane?.request(
            persistentGatewayTaskNotificationMethod,
            {
                idempotencyKey: input.idempotencyKey,
                message: input.message,
                sessionKey: input.sessionKey,
            },
            { signal, timeoutMs: taskNotificationSendTimeoutMilliseconds }
        ) ?? Promise.reject(new PersistentGatewayUnavailableError()));
        const acknowledgement = parsePersistentGatewayChatSendAcknowledgement(payload);
        if (
            acknowledgement === undefined ||
            acknowledgement.runId !== input.idempotencyKey
        ) {
            throw new PersistentGatewayUnavailableError();
        }
    }

    async #runOneShotRequest(
        profile: "admin" | "chat-read-mutation" | "chat-write",
        method:
            | PersistentGatewayAdminMethod
            | PersistentGatewayChatReadMutationMethod
            | PersistentGatewayChatWriteMethod
            | PersistentGatewayOpenClawServiceActionMethod
            | PersistentGatewayOpenClawSettingsWriteMethod
            | PersistentGatewayTaskWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options: PersistentGatewayOneShotRequestOptions,
        bufferedAmountMaximumBytes: number,
        outboundFrameMaximumBytes: number,
        timeoutMaximumMs: number = requestTimeoutMaximumDefaultMs
    ): Promise<unknown> {
        let dispatched = false;
        let settled = false;
        const outcome = Promise.withResolvers<unknown>();
        const resolveOutcome = (payload: unknown): void => {
            if (!settled) {
                settled = true;
                outcome.resolve(payload);
            }
        };
        const rejectOutcome = (error: unknown): void => {
            if (!settled) {
                settled = true;
                outcome.reject(
                    dispatched && !(error instanceof PersistentGatewayRequestError)
                        ? new PersistentGatewayUnknownOutcomeError()
                        : error
                );
            }
        };
        const lane = new GatewaySocketLane({
            callbacks: {
                onActivity: () => {},
                onClosed: () => {
                    this.#adminLanes.delete(lane);
                    rejectOutcome(new PersistentGatewayUnavailableError());
                },
                onConnected: () => {
                    const dispatch = (): void => {
                        let request: Promise<unknown>;
                        try {
                            request = lane.request(method, parameters, {
                                ...options,
                                onDispatched: () => {
                                    dispatched = true;
                                },
                                timeoutMaximumMs,
                            });
                        } catch (error) {
                            rejectOutcome(error);
                            return;
                        }
                        void request.then(resolveOutcome, rejectOutcome);
                    };
                    const beforeDispatch = options.beforeDispatch;
                    if (beforeDispatch === undefined) {
                        dispatch();
                        return;
                    }
                    void (async () => {
                        let timeoutHandle: TimerHandle | undefined;
                        try {
                            await Promise.race([
                                beforeDispatch(),
                                new Promise<never>((_resolve, reject) => {
                                    timeoutHandle = this.#resolved.scheduler.setTimeout(
                                        () =>
                                            reject(
                                                new PersistentGatewayTimeoutError(method)
                                            ),
                                        options.timeoutMs ??
                                            this.#resolved.requestTimeoutMs
                                    );
                                }),
                            ]);
                            if (settled) return;
                            dispatch();
                        } catch (error) {
                            rejectOutcome(error);
                        } finally {
                            if (timeoutHandle !== undefined) {
                                this.#resolved.scheduler.clearTimeout(timeoutHandle);
                            }
                        }
                    })();
                },
                onChatEvent: () => {},
                onEvent: () => {},
                onEventGap: () => {},
            },
            generation: 1,
            bufferedAmountMaximumBytes,
            outboundFrameMaximumBytes,
            profile,
            resolved: this.#resolved,
        });
        this.#adminLanes.add(lane);
        const abortListener = (): void => {
            rejectOutcome(new PersistentGatewayAbortError());
            lane.abort();
        };
        try {
            try {
                options.signal?.addEventListener("abort", abortListener, { once: true });
                if (options.signal?.aborted === true) abortListener();
                lane.open();
                const payload = await outcome.promise;
                try {
                    await lane.closeAndWait(this.#resolved.gracefulStopTimeoutMs);
                } catch (error) {
                    if (!(error instanceof PersistentGatewayStopTimeoutError)) {
                        throw error;
                    }
                    // A confirmed mutation remains truthful even when native close
                    // is late. The lane stays in #adminLanes and retains its permit
                    // until the authoritative close event arrives.
                }
                return payload;
            } catch (error) {
                settled = true;
                try {
                    await lane.closeAndWait(this.#resolved.gracefulStopTimeoutMs);
                } catch {
                    // Preserve the request or handshake failure.
                }
                throw error;
            }
        } finally {
            options.signal?.removeEventListener("abort", abortListener);
        }
    }

    #scheduleReconnect(overrideDelayMs?: number): void {
        if (this.#permanentlyStopped || this.#reconnectTimer !== undefined) return;
        this.#reconnectAttempt += 1;
        let delayMs: number;
        try {
            delayMs =
                overrideDelayMs === undefined
                    ? this.#reconnectDelay(this.#reconnectAttempt)
                    : Math.max(
                          1,
                          boundedInteger(
                              overrideDelayMs,
                              0,
                              0,
                              30 * 60 * 1000,
                              "Persistent Gateway retry delay"
                          )
                      );
        } catch {
            this.#setSnapshot({
                ...this.#snapshot,
                lastFailure: "transport",
                nextReconnectAtMs: undefined,
                reconnectAttempt: this.#reconnectAttempt,
            });
            return;
        }
        const nextReconnectAtMs = safeNow(this.#resolved.nowMs) + delayMs;
        this.#setSnapshot({
            ...this.#snapshot,
            nextReconnectAtMs,
            reconnectAttempt: this.#reconnectAttempt,
        });
        try {
            this.#reconnectTimer = this.#resolved.scheduler.setTimeout(() => {
                this.#reconnectTimer = undefined;
                this.#connect();
            }, delayMs);
        } catch {
            this.#setSnapshot({
                ...this.#snapshot,
                lastFailure: "transport",
                nextReconnectAtMs: undefined,
            });
        }
    }

    #setSnapshot(snapshot: PersistentGatewayConnectionSnapshot): void {
        this.#snapshot = frozenSnapshot(snapshot);
        this.#notify((listener) => listener.onState?.(this.#snapshot));
    }

    async #stop(): Promise<void> {
        this.#permanentlyStopped = true;
        this.#clearReconnect();
        const lane = this.#lane;
        const adminLanes = [...this.#adminLanes];
        if (lane === undefined && adminLanes.length === 0) {
            this.#setSnapshot({
                ...this.#snapshot,
                connectedAtMs: undefined,
                nextReconnectAtMs: undefined,
                phase: "stopped",
                reconnectAttempt: 0,
            });
            return;
        }
        this.#setSnapshot({
            ...this.#snapshot,
            nextReconnectAtMs: undefined,
            phase: "stopping",
            reconnectAttempt: 0,
        });
        await Promise.all([
            ...(lane === undefined
                ? []
                : [lane.closeAndWait(this.#resolved.gracefulStopTimeoutMs)]),
            ...adminLanes.map((adminLane) =>
                adminLane.closeAndWait(this.#resolved.gracefulStopTimeoutMs)
            ),
        ]);
        if (lane !== undefined && this.#lane === lane) this.#lane = undefined;
        this.#setSnapshot({
            ...this.#snapshot,
            connectedAtMs: undefined,
            lastDisconnectedAtMs: safeNow(this.#resolved.nowMs),
            nextReconnectAtMs: undefined,
            phase: "stopped",
            reconnectAttempt: 0,
        });
    }
}

/**
 * Creates one unstarted process transport. The owning Effect layer controls its lifetime.
 * @param options Explicit endpoint, redacted credential, and bounded transport policy.
 * @returns One process-owned persistent transport.
 */
export function createPersistentGatewayTransport(
    options: PersistentGatewayTransportOptions
): PersistentGatewayTransport {
    return new PersistentGatewayTransportImplementation(options, "web-read");
}

/**
 * Creates the worker's write-only notification transport without generic RPC ports.
 * @param options Explicit endpoint, redacted credential, and bounded transport policy.
 * @returns A lifecycle plus the typed task-notification sender only.
 */
export function createPersistentGatewayTaskNotificationTransport(
    options: PersistentGatewayTransportOptions
): PersistentGatewayTaskNotificationTransport {
    return new PersistentGatewayTransportImplementation(
        options,
        "task-notification-worker"
    );
}

/**
 * Starts one already-constructed transport for the lifetime of its owning Effect scope.
 * @param transport Process-owned transport merged into the production runtime separately.
 * @returns A service-free scoped lifecycle layer.
 */
export function persistentGatewayTransportLifecycleLayer(
    transport: PersistentGatewayTransportLifecycle
): Layer.Layer<never> {
    return Layer.effectDiscard(
        Effect.acquireRelease(
            Effect.sync(() => transport.start()),
            () => Effect.promise(() => transport.stop())
        )
    );
}
