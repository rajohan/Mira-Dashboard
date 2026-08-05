import {
    addMilliseconds,
    compareAsc,
    differenceInMilliseconds,
    getTime,
    hoursToMilliseconds,
    minutesToMilliseconds,
    secondsToMilliseconds,
} from "date-fns";

import {
    browserSessionMaximumPerUser,
    browserSessionUserAgentMaximumLength,
    type AuthSessionSummary,
    type AuthUser,
    type FirstUserBootstrapInput,
    type PasswordChangeInput,
    type PasswordLoginInput,
} from "../../../contracts/auth.ts";
import type { AuthenticationMethod } from "../../../contracts/security.ts";
import type { AuthenticationRateLimitKind } from "../../database/schema/authRateLimitBuckets.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    generateOpaqueToken,
    type GeneratedOpaqueToken,
} from "../../shared/opaqueToken.ts";
import { createSecurityAuditEvent, type SecurityAuditActor } from "./audit.ts";
import {
    browserSessionAbsoluteDurationMs,
    browserSessionIdleDurationDefaultMs,
    browserSessionIdleDurationMaximumMs,
    browserSessionIdleDurationMinimumMs,
} from "./authenticationPolicy.ts";
import {
    createAuthenticationWorkBudget,
    type AuthenticationWorkBudget,
} from "./authenticationWorkBudget.ts";
import {
    createAuthenticationWorkGate,
    type AuthenticationWorkGate,
} from "./authenticationWorkGate.ts";
import type {
    AuthenticationLifecycleRepository,
    AuthenticationLifecycleUnitOfWork,
    AuthRateLimitBucket,
    BrowserSessionRecord,
    SecurityUserRecord,
} from "./lifecycleRepository.ts";
import { hashDashboardPassword, verifyDashboardPassword } from "./password.ts";

const sessionActivityWriteIntervalMs = minutesToMilliseconds(1);
const rateLimitFailureWindowMs = hoursToMilliseconds(1);
const saturatedAuthenticationRetryAfterSeconds = 1;
const gatewayVerificationTimeoutDefaultMs = secondsToMilliseconds(5);
const gatewayVerificationTimeoutMinimumMs = 100;
const gatewayVerificationTimeoutMaximumMs = secondsToMilliseconds(30);
const gatewayVerificationMaximumConcurrent = 2;
const gatewayVerificationMaximumQueued = 4;
const sourceRateLimitBucketMaximum = 256;
const sourceRateLimitBucketRetentionMs = hoursToMilliseconds(24);
const passwordWorkBudgetMaximumUnits = 30;
const passwordWorkBudgetWindowMs = minutesToMilliseconds(1);

const sourceRateLimitBlockDurations = [
    { failures: 10, milliseconds: minutesToMilliseconds(15) },
    { failures: 8, milliseconds: minutesToMilliseconds(5) },
    { failures: 5, milliseconds: minutesToMilliseconds(1) },
    { failures: 3, milliseconds: 15_000 },
] as const;
const globalRateLimitBlockDurations = [
    { failures: 50, milliseconds: minutesToMilliseconds(15) },
    { failures: 40, milliseconds: minutesToMilliseconds(5) },
    { failures: 30, milliseconds: minutesToMilliseconds(1) },
    { failures: 20, milliseconds: 15_000 },
] as const;

// A non-secret Argon2id verifier keeps unknown-user and wrong-password work comparable.
// It uses the same m=65536,t=3 policy as new Dashboard passwords.
const unknownUserPasswordHash =
    "$argon2id$v=19$m=65536,t=3,p=1$MDsAhQmsM0gKFDPO1S/bJ84KkrIm1Mo2O8GOuFgx0vE$No7wOmqZQ2kag02Z+R1HguKc3iTXaAMmK4n4bW7yoE4";

interface AuthenticationRateLimitTarget {
    readonly blockDurations: readonly {
        readonly failures: number;
        readonly milliseconds: number;
    }[];
    readonly kind: AuthenticationRateLimitKind;
    readonly sourceScoped?: boolean;
    readonly subject: string;
}

export interface AuthenticatedBrowserIdentity {
    readonly sessionId: string;
    readonly userId: string;
}

export interface AuthenticationRequestMetadata {
    readonly clientSourceId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
    readonly userAgent?: string;
}

export type VerifyGatewayCredential = (
    credential: string,
    signal?: AbortSignal
) => Promise<boolean>;

export interface AuthenticationLifecycleDependencies {
    readonly generateId?: () => string;
    readonly generateSessionToken?: () => GeneratedOpaqueToken;
    readonly gatewayVerificationTimeoutMs?: number;
    readonly hashPassword?: (password: string) => Promise<string>;
    readonly now?: () => Date;
    readonly gatewayWorkGate?: AuthenticationWorkGate;
    readonly passwordWorkGate?: AuthenticationWorkGate;
    readonly passwordWorkBudget?: AuthenticationWorkBudget;
    readonly repository: AuthenticationLifecycleRepository;
    readonly sessionIdleDurationMs?: number;
    readonly verifyGatewayCredential: VerifyGatewayCredential;
    readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

interface IssuedSessionResult {
    readonly session: AuthSessionSummary;
    readonly token: string;
    readonly user: AuthUser;
}

export type BootstrapResult =
    | ({ readonly status: "created" } & IssuedSessionResult)
    | { readonly status: "closed" }
    | { readonly status: "gateway-unavailable" }
    | { readonly status: "invalid-gateway" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" };

export type LoginResult =
    | ({ readonly status: "created" } & IssuedSessionResult)
    | { readonly status: "bootstrap-required" }
    | { readonly status: "invalid-credentials" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" };

export type ChangePasswordResult =
    | ({
          readonly revokedSessions: number;
          readonly status: "changed";
      } & IssuedSessionResult)
    | { readonly status: "invalid-current-password" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" }
    | { readonly status: "same-password" }
    | { readonly status: "session-changed" };

export type AuthenticationStatus =
    | { readonly authenticated: false; readonly isBootstrapRequired: boolean }
    | {
          readonly authenticated: true;
          readonly isBootstrapRequired: false;
          readonly session: AuthSessionSummary;
          readonly user: AuthUser;
      };

export interface AuthenticationLifecycleService {
    bootstrap(
        input: FirstUserBootstrapInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<BootstrapResult>;
    changePassword(
        identity: AuthenticatedBrowserIdentity,
        input: PasswordChangeInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<ChangePasswordResult>;
    listSessions(
        identity: AuthenticatedBrowserIdentity
    ): AuthSessionSummary[] | undefined;
    login(
        input: PasswordLoginInput,
        metadata: AuthenticationRequestMetadata,
        currentIdentity?: AuthenticatedBrowserIdentity
    ): Promise<LoginResult>;
    logout(
        identity: AuthenticatedBrowserIdentity | undefined,
        metadata: AuthenticationRequestMetadata
    ): boolean;
    revokeSession(
        identity: AuthenticatedBrowserIdentity,
        sessionId: string,
        metadata: AuthenticationRequestMetadata
    ): { readonly revoked: boolean } | undefined;
    status(identity?: AuthenticatedBrowserIdentity): AuthenticationStatus;
    touchSession(
        identity: AuthenticatedBrowserIdentity
    ): { readonly lastSeenAtMs: number } | undefined;
}

class AuthenticationStateChangedError extends Error {}
class GatewayVerificationCapacityError extends Error {}

function authUser(user: SecurityUserRecord): AuthUser {
    return Object.freeze({ id: user.id, username: user.username });
}

function authSession(
    session: BrowserSessionRecord,
    currentSessionId: string
): AuthSessionSummary {
    return Object.freeze({
        authenticatedAtMs: getTime(session.authenticatedAt),
        authMethod: session.authMethod,
        createdAtMs: getTime(session.createdAt),
        expiresAtMs: getTime(session.expiresAt),
        id: session.id,
        isCurrent: session.id === currentSessionId,
        lastSeenAtMs: getTime(session.lastSeenAt),
        ...(session.userAgent !== null && { userAgent: session.userAgent }),
    });
}

function sessionActor(identity: AuthenticatedBrowserIdentity): SecurityAuditActor {
    return {
        authenticatorId: identity.sessionId,
        id: identity.userId,
        kind: "user",
    };
}

function normalizeUserAgent(userAgent: string | undefined): string | null {
    const normalized = userAgent
        ?.replaceAll(/\p{Cc}/gu, " ")
        .trim()
        .replaceAll(/\s+/gu, " ");
    if (!normalized) return null;
    const codePoints: string[] = [];
    for (const codePoint of normalized) {
        if (codePoints.length >= browserSessionUserAgentMaximumLength) break;
        codePoints.push(codePoint);
    }
    return codePoints.join("");
}

function blockDurationMs(
    failureCount: number,
    blockDurations: AuthenticationRateLimitTarget["blockDurations"]
): number {
    return (
        blockDurations.find(({ failures }) => failureCount >= failures)?.milliseconds ?? 0
    );
}

function retryAfterSeconds(blockedUntil: Date, now: Date): number {
    return Math.max(1, Math.ceil(differenceInMilliseconds(blockedUntil, now) / 1000));
}

function authenticationAbortReason(signal: AbortSignal): unknown {
    return (
        signal.reason ?? new DOMException("Authentication request aborted", "AbortError")
    );
}

async function verifyGatewayCredentialWithDeadline(
    verifyGatewayCredential: VerifyGatewayCredential,
    credential: string,
    requestSignal: AbortSignal | undefined,
    timeoutMs: number,
    unsettledVerifications: Set<Promise<boolean>>
): Promise<boolean> {
    requestSignal?.throwIfAborted();
    if (unsettledVerifications.size >= gatewayVerificationMaximumConcurrent) {
        throw new GatewayVerificationCapacityError();
    }
    const controller = new AbortController();
    const forwardRequestAbort = (): void =>
        controller.abort(
            requestSignal === undefined
                ? new DOMException("Authentication request aborted", "AbortError")
                : authenticationAbortReason(requestSignal)
        );
    requestSignal?.addEventListener("abort", forwardRequestAbort, { once: true });
    const timeout = setTimeout(
        () =>
            controller.abort(
                new DOMException(
                    "Gateway credential verification timed out",
                    "TimeoutError"
                )
            ),
        timeoutMs
    );
    const abort = Promise.withResolvers<never>();
    const rejectOnAbort = (): void =>
        abort.reject(authenticationAbortReason(controller.signal));
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    const verification = Promise.resolve().then(() =>
        verifyGatewayCredential(credential, controller.signal)
    );
    unsettledVerifications.add(verification);
    void verification.then(
        () => unsettledVerifications.delete(verification),
        () => unsettledVerifications.delete(verification)
    );
    try {
        return await Promise.race([verification, abort.promise]);
    } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", rejectOnAbort);
        requestSignal?.removeEventListener("abort", forwardRequestAbort);
    }
}

function rateLimitBucketKey(kind: AuthenticationRateLimitKind, subject: string): string {
    return sha256Hex(`mira-dashboard:auth-rate-limit:v1:${kind}:${subject}`);
}

function activeRateLimit(
    bucket: AuthRateLimitBucket | undefined,
    now: Date
): { readonly retryAfterSeconds: number } | undefined {
    return bucket?.blockedUntil !== null &&
        bucket?.blockedUntil !== undefined &&
        compareAsc(bucket.blockedUntil, now) > 0
        ? { retryAfterSeconds: retryAfterSeconds(bucket.blockedUntil, now) }
        : undefined;
}

function recordAuthenticationFailure(
    unit: AuthenticationLifecycleUnitOfWork,
    target: AuthenticationRateLimitTarget,
    now: Date
): { readonly retryAfterSeconds?: number } {
    const bucketKey = rateLimitBucketKey(target.kind, target.subject);
    const existing = unit.findRateLimitBucket(bucketKey);
    const firstFailureAge =
        existing === undefined
            ? -1
            : differenceInMilliseconds(now, existing.firstFailedAt);
    const continuesWindow =
        existing !== undefined &&
        firstFailureAge >= 0 &&
        firstFailureAge <= rateLimitFailureWindowMs;
    const failureCount = continuesWindow
        ? Math.min(Number.MAX_SAFE_INTEGER, existing.failureCount + 1)
        : 1;
    const durationMs = blockDurationMs(failureCount, target.blockDurations);
    const blockedUntil = durationMs === 0 ? null : addMilliseconds(now, durationMs);
    unit.upsertRateLimitBucket({
        blockedUntil,
        bucketKey,
        failureCount,
        firstFailedAt: continuesWindow && existing ? existing.firstFailedAt : now,
        kind: target.kind,
        updatedAt: now,
    });
    if (target.sourceScoped === true) {
        unit.pruneRateLimitBuckets({
            kind: target.kind,
            maximumBuckets: sourceRateLimitBucketMaximum,
            retainedBucketKey: bucketKey,
            staleBefore: addMilliseconds(now, -sourceRateLimitBucketRetentionMs),
        });
    }
    return blockedUntil === null
        ? {}
        : { retryAfterSeconds: retryAfterSeconds(blockedUntil, now) };
}

function activeRateLimitForTargets(
    findBucket: (bucketKey: string) => AuthRateLimitBucket | undefined,
    targets: readonly AuthenticationRateLimitTarget[],
    now: Date
): { readonly retryAfterSeconds: number } | undefined {
    let longestRetryAfterSeconds = 0;
    for (const target of targets) {
        const active = activeRateLimit(
            findBucket(rateLimitBucketKey(target.kind, target.subject)),
            now
        );
        longestRetryAfterSeconds = Math.max(
            longestRetryAfterSeconds,
            active?.retryAfterSeconds ?? 0
        );
    }
    return longestRetryAfterSeconds === 0
        ? undefined
        : { retryAfterSeconds: longestRetryAfterSeconds };
}

function recordAuthenticationFailures(
    unit: AuthenticationLifecycleUnitOfWork,
    targets: readonly AuthenticationRateLimitTarget[],
    now: Date
): { readonly retryAfterSeconds?: number } {
    let longestRetryAfterSeconds = 0;
    for (const target of targets) {
        const recorded = recordAuthenticationFailure(unit, target, now);
        longestRetryAfterSeconds = Math.max(
            longestRetryAfterSeconds,
            recorded.retryAfterSeconds ?? 0
        );
    }
    return longestRetryAfterSeconds === 0
        ? {}
        : { retryAfterSeconds: longestRetryAfterSeconds };
}

function sessionIsActive(
    session: BrowserSessionRecord,
    now: Date,
    sessionIdleDurationMs: number
): boolean {
    return (
        compareAsc(session.expiresAt, now) > 0 &&
        differenceInMilliseconds(now, session.lastSeenAt) < sessionIdleDurationMs
    );
}

/**
 * Creates the mutable browser-authentication service above validated repositories.
 * @param dependencies Validated persistence, cryptography, clocks, and resource budgets.
 * @returns A process-owned browser-authentication lifecycle service.
 */
export function createAuthenticationLifecycleService(
    dependencies: AuthenticationLifecycleDependencies
): AuthenticationLifecycleService {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const generateSessionToken =
        dependencies.generateSessionToken ?? (() => generateOpaqueToken("session"));
    const hashPassword = dependencies.hashPassword ?? hashDashboardPassword;
    const verifyPassword = dependencies.verifyPassword ?? verifyDashboardPassword;
    const clock = dependencies.now ?? (() => new Date());
    const now = (): Date => {
        const value = clock();
        if (!Number.isFinite(value.getTime()) || value.getTime() < 0) {
            throw new RangeError("Authentication clock is invalid");
        }
        return value;
    };
    const sessionIdleDurationMs =
        dependencies.sessionIdleDurationMs ?? browserSessionIdleDurationDefaultMs;
    if (
        !Number.isSafeInteger(sessionIdleDurationMs) ||
        sessionIdleDurationMs < browserSessionIdleDurationMinimumMs ||
        sessionIdleDurationMs > browserSessionIdleDurationMaximumMs
    ) {
        throw new RangeError("Session idle duration is invalid");
    }
    const gatewayVerificationTimeoutMs =
        dependencies.gatewayVerificationTimeoutMs ?? gatewayVerificationTimeoutDefaultMs;
    if (
        !Number.isSafeInteger(gatewayVerificationTimeoutMs) ||
        gatewayVerificationTimeoutMs < gatewayVerificationTimeoutMinimumMs ||
        gatewayVerificationTimeoutMs > gatewayVerificationTimeoutMaximumMs
    ) {
        throw new RangeError("Gateway verification timeout is invalid");
    }
    const gatewayWorkGate =
        dependencies.gatewayWorkGate ??
        createAuthenticationWorkGate(
            gatewayVerificationMaximumConcurrent,
            gatewayVerificationMaximumQueued
        );
    const unsettledGatewayVerifications = new Set<Promise<boolean>>();
    const passwordWorkGate =
        dependencies.passwordWorkGate ?? createAuthenticationWorkGate(1, 3);
    const passwordWorkBudget =
        dependencies.passwordWorkBudget ??
        createAuthenticationWorkBudget(
            passwordWorkBudgetMaximumUnits,
            passwordWorkBudgetWindowMs
        );
    const bootstrapRateLimitTargets = (
        clientSourceId: string
    ): readonly AuthenticationRateLimitTarget[] => [
        {
            blockDurations: sourceRateLimitBlockDurations,
            kind: "bootstrap-gateway-source",
            sourceScoped: true,
            subject: clientSourceId,
        },
        {
            blockDurations: globalRateLimitBlockDurations,
            kind: "bootstrap-gateway-global",
            subject: "all-sources",
        },
    ];
    const loginRateLimitTargets = (
        clientSourceId: string
    ): readonly AuthenticationRateLimitTarget[] => [
        {
            blockDurations: sourceRateLimitBlockDurations,
            kind: "login-password-source",
            sourceScoped: true,
            subject: clientSourceId,
        },
        {
            blockDurations: globalRateLimitBlockDurations,
            kind: "login-password-global",
            subject: "all-sources",
        },
    ];
    const accountPasswordRateLimitTargets = (
        userId: string
    ): readonly AuthenticationRateLimitTarget[] => [
        {
            blockDurations: sourceRateLimitBlockDurations,
            kind: "account-password",
            subject: userId,
        },
    ];

    const newSession = (
        unit: AuthenticationLifecycleUnitOfWork,
        user: SecurityUserRecord,
        createdAt: Date,
        userAgent: string | undefined,
        method: AuthenticationMethod = "password"
    ): { readonly record: BrowserSessionRecord; readonly token: string } => {
        const token = generateSessionToken();
        const record = unit.insertSession({
            authenticatedAt: createdAt,
            authenticationVersion: user.authenticationVersion,
            authMethod: method,
            createdAt,
            elevatedAt: createdAt,
            elevatedMethod: method,
            expiresAt: addMilliseconds(createdAt, browserSessionAbsoluteDurationMs),
            id: token.prefix,
            lastSeenAt: createdAt,
            mfaVerifiedAt: null,
            userAgent: normalizeUserAgent(userAgent),
            userId: user.id,
            validatorHash: token.validatorHash,
        });
        return { record, token: token.token };
    };

    const pruneUserSessions = (
        unit: AuthenticationLifecycleUnitOfWork,
        user: SecurityUserRecord,
        retainedSessionId: string,
        checkedAt: Date
    ): void => {
        unit.pruneUserSessions({
            checkedAt,
            expectedAuthenticationVersion: user.authenticationVersion,
            idleBefore: addMilliseconds(checkedAt, -sessionIdleDurationMs),
            maximumSessions: browserSessionMaximumPerUser,
            retainedSessionId,
            userId: user.id,
        });
    };

    const audit = (
        unit: AuthenticationLifecycleUnitOfWork,
        input: {
            readonly action: string;
            readonly actor: SecurityAuditActor;
            readonly metadata?: Readonly<Record<string, unknown>>;
            readonly occurredAt: Date;
            readonly outcome: "denied" | "failed" | "succeeded";
            readonly requestId: string;
            readonly targetId: string;
            readonly targetType: string;
        }
    ): void => {
        unit.insertAuditEvent(
            createSecurityAuditEvent({
                ...input,
                id: generateId(),
            })
        );
    };

    const anonymousActor: SecurityAuditActor = Object.freeze({
        authenticatorId: null,
        id: "browser",
        kind: "anonymous",
    });

    const service: AuthenticationLifecycleService = {
        async bootstrap(input, metadata) {
            if (dependencies.repository.countUsers() !== 0) {
                return { status: "closed" };
            }
            const rateLimitTargets = bootstrapRateLimitTargets(metadata.clientSourceId);
            const gatewayAdmission = await gatewayWorkGate.run(async () => {
                if (dependencies.repository.countUsers() !== 0) {
                    return { status: "closed" } as const;
                }
                const checkedAt = now();
                const rateLimit = activeRateLimitForTargets(
                    (bucketKey) => dependencies.repository.findRateLimitBucket(bucketKey),
                    rateLimitTargets,
                    checkedAt
                );
                if (rateLimit !== undefined) {
                    return { ...rateLimit, status: "rate-limited" } as const;
                }

                let gatewayCredentialIsValid: boolean;
                try {
                    gatewayCredentialIsValid = await verifyGatewayCredentialWithDeadline(
                        dependencies.verifyGatewayCredential,
                        input.gatewayCredential,
                        metadata.signal,
                        gatewayVerificationTimeoutMs,
                        unsettledGatewayVerifications
                    );
                } catch (error) {
                    metadata.signal?.throwIfAborted();
                    if (error instanceof GatewayVerificationCapacityError) {
                        return {
                            retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                            status: "rate-limited",
                        } as const;
                    }
                    const failedAt = now();
                    const failure = dependencies.repository.withImmediateTransaction(
                        (unit) => {
                            if (unit.countUsers() !== 0) {
                                return { kind: "closed" } as const;
                            }
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                failedAt
                            );
                            audit(unit, {
                                action: "auth.bootstrap",
                                actor: anonymousActor,
                                metadata: { reason: "gateway_unavailable" },
                                occurredAt: failedAt,
                                outcome: "failed",
                                requestId: metadata.requestId,
                                targetId: "bootstrap",
                                targetType: "user",
                            });
                            return { kind: "recorded", ...recorded } as const;
                        }
                    );
                    if (failure.kind === "closed") return { status: "closed" } as const;
                    return failure.retryAfterSeconds === undefined
                        ? ({ status: "gateway-unavailable" } as const)
                        : ({
                              retryAfterSeconds: failure.retryAfterSeconds,
                              status: "rate-limited",
                          } as const);
                }

                metadata.signal?.throwIfAborted();
                if (!gatewayCredentialIsValid) {
                    const failedAt = now();
                    const failure = dependencies.repository.withImmediateTransaction(
                        (unit) => {
                            if (unit.countUsers() !== 0) {
                                return { kind: "closed" } as const;
                            }
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                failedAt
                            );
                            audit(unit, {
                                action: "auth.bootstrap",
                                actor: anonymousActor,
                                metadata: { reason: "invalid_gateway" },
                                occurredAt: failedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: "bootstrap",
                                targetType: "user",
                            });
                            return { kind: "recorded", ...recorded } as const;
                        }
                    );
                    if (failure.kind === "closed") return { status: "closed" } as const;
                    return failure.retryAfterSeconds === undefined
                        ? ({ status: "invalid-gateway" } as const)
                        : ({
                              retryAfterSeconds: failure.retryAfterSeconds,
                              status: "rate-limited",
                          } as const);
                }
                return { status: "verified" } as const;
            }, metadata.signal);
            if (!gatewayAdmission.accepted) {
                return {
                    retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited",
                };
            }
            if (gatewayAdmission.value.status !== "verified") {
                return gatewayAdmission.value;
            }

            const passwordAdmission = await passwordWorkGate.run(async () => {
                if (dependencies.repository.countUsers() !== 0) {
                    return { status: "closed" } as const;
                }
                const workBudget = passwordWorkBudget.consume();
                if (!workBudget.accepted) {
                    return {
                        retryAfterSeconds: workBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const passwordHash = await hashPassword(input.password);
                metadata.signal?.throwIfAborted();
                const createdAt = now();
                return dependencies.repository.withImmediateTransaction((unit) => {
                    if (unit.countUsers() !== 0) {
                        return { status: "closed" } as const;
                    }
                    const user = unit.insertUser({
                        createdAt,
                        disabledAt: null,
                        id: generateId(),
                        passwordHash,
                        updatedAt: createdAt,
                        username: input.username,
                    });
                    const issued = newSession(unit, user, createdAt, metadata.userAgent);
                    pruneUserSessions(unit, user, issued.record.id, createdAt);
                    unit.deleteRateLimitBuckets("bootstrap-gateway-source");
                    unit.deleteRateLimitBuckets("bootstrap-gateway-global");
                    audit(unit, {
                        action: "auth.bootstrap",
                        actor: {
                            authenticatorId: issued.record.id,
                            id: user.id,
                            kind: "user",
                        },
                        occurredAt: createdAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: user.id,
                        targetType: "user",
                    });
                    return {
                        session: authSession(issued.record, issued.record.id),
                        status: "created" as const,
                        token: issued.token,
                        user: authUser(user),
                    };
                });
            }, metadata.signal);
            return passwordAdmission.accepted
                ? passwordAdmission.value
                : {
                      retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                      status: "rate-limited",
                  };
        },

        async changePassword(identity, input, metadata) {
            const rateLimitTargets = accountPasswordRateLimitTargets(identity.userId);
            const passwordAdmission = await passwordWorkGate.run(async () => {
                const checkedAt = now();
                const user = dependencies.repository.findUserById(identity.userId);
                const session = dependencies.repository.findSession(
                    identity.userId,
                    identity.sessionId
                );
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    session === undefined ||
                    session.authenticationVersion !== user.authenticationVersion ||
                    !sessionIsActive(session, checkedAt, sessionIdleDurationMs)
                ) {
                    return { status: "session-changed" } as const;
                }
                const rateLimit = activeRateLimitForTargets(
                    (bucketKey) => dependencies.repository.findRateLimitBucket(bucketKey),
                    rateLimitTargets,
                    checkedAt
                );
                if (rateLimit !== undefined) {
                    return { ...rateLimit, status: "rate-limited" } as const;
                }
                const verificationBudget = passwordWorkBudget.consume();
                if (!verificationBudget.accepted) {
                    return {
                        retryAfterSeconds: verificationBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const isCurrentPassword = await verifyPassword(
                    input.currentPassword,
                    user.passwordHash
                );
                metadata.signal?.throwIfAborted();
                if (!isCurrentPassword) {
                    const failedAt = now();
                    const failure = dependencies.repository.withImmediateTransaction(
                        (unit) => {
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                failedAt
                            );
                            audit(unit, {
                                action: "auth.password.change",
                                actor: sessionActor(identity),
                                metadata: { reason: "invalid_current_password" },
                                occurredAt: failedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: identity.userId,
                                targetType: "user",
                            });
                            return recorded;
                        }
                    );
                    return failure.retryAfterSeconds === undefined
                        ? ({ status: "invalid-current-password" } as const)
                        : ({
                              retryAfterSeconds: failure.retryAfterSeconds,
                              status: "rate-limited",
                          } as const);
                }
                if (input.newPassword === input.currentPassword) {
                    return { status: "same-password" } as const;
                }
                const hashingBudget = passwordWorkBudget.consume();
                if (!hashingBudget.accepted) {
                    return {
                        retryAfterSeconds: hashingBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const passwordHash = await hashPassword(input.newPassword);
                metadata.signal?.throwIfAborted();
                const changedAt = now();
                try {
                    return dependencies.repository.withImmediateTransaction((unit) => {
                        const currentUser = unit.findUserById(identity.userId);
                        if (
                            currentUser === undefined ||
                            currentUser.disabledAt !== null ||
                            currentUser.passwordHash !== user.passwordHash ||
                            currentUser.authenticationVersion !==
                                user.authenticationVersion
                        ) {
                            throw new AuthenticationStateChangedError();
                        }
                        const updatedUser = unit.updateUserPassword({
                            expectedAuthenticationVersion: user.authenticationVersion,
                            expectedPasswordHash: user.passwordHash,
                            passwordHash,
                            updatedAt: changedAt,
                            userId: identity.userId,
                        });
                        if (
                            updatedUser === undefined ||
                            !unit.deleteSession(identity.userId, identity.sessionId)
                        ) {
                            throw new AuthenticationStateChangedError();
                        }
                        const issued = newSession(
                            unit,
                            updatedUser,
                            changedAt,
                            metadata.userAgent
                        );
                        const revokedSessions = unit.deleteOtherSessions(
                            identity.userId,
                            issued.record.id
                        );
                        for (const target of rateLimitTargets) {
                            unit.deleteRateLimitBucket(
                                rateLimitBucketKey(target.kind, target.subject)
                            );
                        }
                        audit(unit, {
                            action: "auth.password.change",
                            actor: sessionActor(identity),
                            metadata: { revokedSessions },
                            occurredAt: changedAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: identity.userId,
                            targetType: "user",
                        });
                        return {
                            revokedSessions,
                            session: authSession(issued.record, issued.record.id),
                            status: "changed" as const,
                            token: issued.token,
                            user: authUser(updatedUser),
                        };
                    });
                } catch (error) {
                    if (error instanceof AuthenticationStateChangedError) {
                        return { status: "session-changed" } as const;
                    }
                    throw error;
                }
            }, metadata.signal);
            return passwordAdmission.accepted
                ? passwordAdmission.value
                : {
                      retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                      status: "rate-limited",
                  };
        },

        listSessions(identity) {
            return dependencies.repository.withReadTransaction((reader) => {
                const checkedAt = now();
                const user = reader.findUserById(identity.userId);
                const actorSession = reader.findSession(
                    identity.userId,
                    identity.sessionId
                );
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    actorSession === undefined ||
                    actorSession.authenticationVersion !== user.authenticationVersion ||
                    !sessionIsActive(actorSession, checkedAt, sessionIdleDurationMs)
                ) {
                    return;
                }
                return reader
                    .listSessions({
                        authenticationVersion: user.authenticationVersion,
                        checkedAt,
                        idleAfter: addMilliseconds(checkedAt, -sessionIdleDurationMs),
                        limit: browserSessionMaximumPerUser,
                        userId: identity.userId,
                    })
                    .filter(
                        (session) =>
                            session.authenticationVersion ===
                                user.authenticationVersion &&
                            sessionIsActive(session, checkedAt, sessionIdleDurationMs)
                    )
                    .map((session) => authSession(session, identity.sessionId));
            });
        },

        async login(input, metadata, currentIdentity) {
            if (dependencies.repository.countUsers() === 0) {
                return { status: "bootstrap-required" };
            }
            const rateLimitTargets = loginRateLimitTargets(metadata.clientSourceId);
            const passwordAdmission = await passwordWorkGate.run(async () => {
                if (dependencies.repository.countUsers() === 0) {
                    return { status: "bootstrap-required" } as const;
                }
                const checkedAt = now();
                const rateLimit = activeRateLimitForTargets(
                    (bucketKey) => dependencies.repository.findRateLimitBucket(bucketKey),
                    rateLimitTargets,
                    checkedAt
                );
                if (rateLimit !== undefined) {
                    return { ...rateLimit, status: "rate-limited" } as const;
                }
                const workBudget = passwordWorkBudget.consume();
                if (!workBudget.accepted) {
                    return {
                        retryAfterSeconds: workBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const user = dependencies.repository.findUserByUsername(input.username);
                const passwordIsValid = await verifyPassword(
                    input.password,
                    user?.passwordHash ?? unknownUserPasswordHash
                );
                metadata.signal?.throwIfAborted();
                const verificationCompletedAt = now();
                if (user === undefined || user.disabledAt !== null || !passwordIsValid) {
                    const failure = dependencies.repository.withImmediateTransaction(
                        (unit) => {
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                verificationCompletedAt
                            );
                            audit(unit, {
                                action: "auth.login",
                                actor: anonymousActor,
                                metadata: { reason: "invalid_credentials" },
                                occurredAt: verificationCompletedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: user?.id ?? "unknown",
                                targetType: "user",
                            });
                            return recorded;
                        }
                    );
                    return failure.retryAfterSeconds === undefined
                        ? ({ status: "invalid-credentials" } as const)
                        : ({
                              retryAfterSeconds: failure.retryAfterSeconds,
                              status: "rate-limited",
                          } as const);
                }

                return dependencies.repository.withImmediateTransaction((unit) => {
                    const currentUser = unit.findUserById(user.id);
                    if (
                        currentUser === undefined ||
                        currentUser.disabledAt !== null ||
                        currentUser.passwordHash !== user.passwordHash ||
                        currentUser.authenticationVersion !== user.authenticationVersion
                    ) {
                        const failure = recordAuthenticationFailures(
                            unit,
                            rateLimitTargets,
                            verificationCompletedAt
                        );
                        audit(unit, {
                            action: "auth.login",
                            actor: anonymousActor,
                            metadata: { reason: "identity_changed" },
                            occurredAt: verificationCompletedAt,
                            outcome: "denied",
                            requestId: metadata.requestId,
                            targetId: user.id,
                            targetType: "user",
                        });
                        return failure.retryAfterSeconds === undefined
                            ? ({ status: "invalid-credentials" } as const)
                            : ({
                                  retryAfterSeconds: failure.retryAfterSeconds,
                                  status: "rate-limited",
                              } as const);
                    }
                    if (currentIdentity?.userId === user.id) {
                        unit.deleteSession(user.id, currentIdentity.sessionId);
                    }
                    const issued = newSession(
                        unit,
                        currentUser,
                        verificationCompletedAt,
                        metadata.userAgent
                    );
                    pruneUserSessions(
                        unit,
                        currentUser,
                        issued.record.id,
                        verificationCompletedAt
                    );
                    const sourceTarget = rateLimitTargets.find(
                        (target) => target.sourceScoped === true
                    );
                    if (sourceTarget !== undefined) {
                        unit.deleteRateLimitBucket(
                            rateLimitBucketKey(sourceTarget.kind, sourceTarget.subject)
                        );
                    }
                    audit(unit, {
                        action: "auth.login",
                        actor: {
                            authenticatorId: issued.record.id,
                            id: user.id,
                            kind: "user",
                        },
                        occurredAt: verificationCompletedAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: issued.record.id,
                        targetType: "auth_session",
                    });
                    return {
                        session: authSession(issued.record, issued.record.id),
                        status: "created" as const,
                        token: issued.token,
                        user: authUser(currentUser),
                    };
                });
            }, metadata.signal);
            return passwordAdmission.accepted
                ? passwordAdmission.value
                : {
                      retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                      status: "rate-limited",
                  };
        },

        logout(identity, metadata) {
            if (identity === undefined) return false;
            return dependencies.repository.withImmediateTransaction((unit) => {
                const occurredAt = now();
                const revoked = unit.deleteSession(identity.userId, identity.sessionId);
                if (!revoked) return false;
                audit(unit, {
                    action: "auth.logout",
                    actor: sessionActor(identity),
                    occurredAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: identity.sessionId,
                    targetType: "auth_session",
                });
                return true;
            });
        },

        revokeSession(identity, sessionId, metadata) {
            return dependencies.repository.withImmediateTransaction((unit) => {
                const occurredAt = now();
                const user = unit.findUserById(identity.userId);
                const actorSession = unit.findSession(
                    identity.userId,
                    identity.sessionId
                );
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    actorSession === undefined ||
                    actorSession.authenticationVersion !== user.authenticationVersion ||
                    !sessionIsActive(actorSession, occurredAt, sessionIdleDurationMs)
                ) {
                    return;
                }
                const revoked = unit.deleteSession(identity.userId, sessionId);
                if (revoked) {
                    audit(unit, {
                        action: "auth.session.revoke",
                        actor: sessionActor(identity),
                        metadata: { revoked: true },
                        occurredAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: sessionId,
                        targetType: "auth_session",
                    });
                }
                return { revoked };
            });
        },

        status(identity) {
            const isBootstrapRequired = dependencies.repository.countUsers() === 0;
            if (identity === undefined || isBootstrapRequired) {
                return { authenticated: false, isBootstrapRequired };
            }
            const user = dependencies.repository.findUserById(identity.userId);
            const session = dependencies.repository.findSession(
                identity.userId,
                identity.sessionId
            );
            if (
                user === undefined ||
                user.disabledAt !== null ||
                session === undefined ||
                session.authenticationVersion !== user.authenticationVersion ||
                !sessionIsActive(session, now(), sessionIdleDurationMs)
            ) {
                return { authenticated: false, isBootstrapRequired: false };
            }
            return {
                authenticated: true,
                isBootstrapRequired: false,
                session: authSession(session, identity.sessionId),
                user: authUser(user),
            };
        },

        touchSession(identity) {
            const touchedAt = now();
            const user = dependencies.repository.findUserById(identity.userId);
            const current = dependencies.repository.findSession(
                identity.userId,
                identity.sessionId
            );
            if (
                user === undefined ||
                user.disabledAt !== null ||
                current === undefined ||
                current.authenticationVersion !== user.authenticationVersion ||
                !sessionIsActive(current, touchedAt, sessionIdleDurationMs)
            ) {
                return;
            }
            if (
                differenceInMilliseconds(touchedAt, current.lastSeenAt) <
                sessionActivityWriteIntervalMs
            ) {
                return { lastSeenAtMs: getTime(current.lastSeenAt) };
            }
            const updated = dependencies.repository.withImmediateTransaction((unit) => {
                const currentUser = unit.findUserById(identity.userId);
                if (
                    currentUser === undefined ||
                    currentUser.disabledAt !== null ||
                    currentUser.authenticationVersion !== current.authenticationVersion
                ) {
                    return;
                }
                return unit.touchSession(
                    identity.userId,
                    identity.sessionId,
                    touchedAt,
                    addMilliseconds(touchedAt, -sessionActivityWriteIntervalMs)
                );
            });
            if (updated !== undefined) {
                return { lastSeenAtMs: getTime(updated.lastSeenAt) };
            }
            const refreshed = dependencies.repository.findSession(
                identity.userId,
                identity.sessionId
            );
            return refreshed !== undefined &&
                refreshed.authenticationVersion === user.authenticationVersion &&
                sessionIsActive(refreshed, touchedAt, sessionIdleDurationMs)
                ? { lastSeenAtMs: getTime(refreshed.lastSeenAt) }
                : undefined;
        },
    };
    return Object.freeze(service);
}
