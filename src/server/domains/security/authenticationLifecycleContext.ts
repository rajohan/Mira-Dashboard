import { addMilliseconds, minutesToMilliseconds, secondsToMilliseconds } from "date-fns";

import { browserSessionMaximumPerUser } from "../../../contracts/auth.ts";
import type { AuthenticationMethod } from "../../../contracts/security.ts";
import {
    generateOpaqueToken,
    type GeneratedOpaqueToken,
} from "../../shared/opaqueToken.ts";
import { createSecurityAuditEvent, type SecurityAuditEventInput } from "./audit.ts";
import type {
    AuthenticationLifecycleRepository,
    AuthenticationLifecycleUnitOfWork,
} from "./authenticationLifecycleRepository.ts";
import type {
    AuthenticationLifecycleDependencies,
    PendingLoginLifecyclePort,
} from "./authenticationLifecycleTypes.ts";
import {
    browserSessionAbsoluteDurationMs,
    browserSessionIdleDurationDefaultMs,
    browserSessionIdleDurationMaximumMs,
    browserSessionIdleDurationMinimumMs,
} from "./authenticationPolicy.ts";
import {
    authenticationWorkBudgetMaximumUnits,
    authenticationWorkBudgetWindowMs,
    globalRateLimitBlockDurations,
    sourceRateLimitBlockDurations,
    type AuthenticationRateLimitTarget,
} from "./authenticationRateLimit.ts";
import {
    insertBrowserSession,
    type AuthenticationRequestMetadata,
} from "./authenticationSession.ts";
import {
    createAuthenticationWorkBudget,
    type AuthenticationWorkBudget,
} from "./authenticationWorkBudget.ts";
import {
    type AuthenticationWorkGate,
    type GatewayAuthenticationWorkFailure,
} from "./authenticationWorkGate.ts";
import { hashDashboardPassword, verifyDashboardPassword } from "./password.ts";
import {
    recentAuthenticationWindowDefaultMs,
    recentAuthenticationWindowMaximumMs,
    recentAuthenticationWindowMinimumMs,
} from "./recentAuthentication.ts";
import type {
    BrowserSessionRecord,
    SecurityUserRecord,
} from "./securityPersistenceTypes.ts";

export const sessionActivityWriteIntervalMs = minutesToMilliseconds(1);

const gatewayVerificationTimeoutDefaultMs = secondsToMilliseconds(5);
const gatewayVerificationTimeoutMinimumMs = 100;
const gatewayVerificationTimeoutMaximumMs = secondsToMilliseconds(30);

export class AuthenticationStateChangedError extends Error {}

export interface GatewayCredentialSettlement {
    readonly shouldVerify: () => boolean;
    readonly onInvalid: () => void;
    readonly onUnavailable: (failure: GatewayAuthenticationWorkFailure) => void;
}

export interface AuthenticationLifecycleContext {
    readonly accountPasswordRateLimitTargets: (
        userId: string
    ) => readonly AuthenticationRateLimitTarget[];
    readonly anonymousActor: SecurityAuditEventInput["actor"];
    readonly audit: (
        unit: AuthenticationLifecycleUnitOfWork,
        input: Omit<SecurityAuditEventInput, "id">
    ) => void;
    readonly bootstrapRateLimitTargets: (
        clientSourceId: string
    ) => readonly AuthenticationRateLimitTarget[];
    readonly generateId: () => string;
    readonly generateSessionToken: () => GeneratedOpaqueToken;
    readonly hashPassword: (password: string) => Promise<string>;
    readonly loginRateLimitTargets: (
        clientSourceId: string
    ) => readonly AuthenticationRateLimitTarget[];
    readonly mfaLoginLifecycle: PendingLoginLifecyclePort;
    readonly newSession: (
        unit: AuthenticationLifecycleUnitOfWork,
        user: SecurityUserRecord,
        createdAt: Date,
        userAgent: string | undefined,
        method?: AuthenticationMethod
    ) => { readonly record: BrowserSessionRecord; readonly token: string };
    readonly now: () => Date;
    readonly passwordWorkBudget: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly pruneUserSessions: (
        unit: AuthenticationLifecycleUnitOfWork,
        user: SecurityUserRecord,
        retainedSessionId: string,
        checkedAt: Date
    ) => void;
    readonly repository: AuthenticationLifecycleRepository;
    readonly recentAuthenticationWindowMs: number;
    readonly sessionIdleDurationMs: number;
    readonly verifyGatewayCredential: (
        credential: string,
        metadata: AuthenticationRequestMetadata,
        settlement: GatewayCredentialSettlement
    ) => Promise<boolean>;
    readonly verifyPassword: (password: string, hash: string) => Promise<boolean>;
}

/**
 * Builds validated policy, cryptography, audit, and session helpers shared by auth use cases.
 * @returns Frozen context consumed through operation-specific ports.
 */
export function createAuthenticationLifecycleContext(
    dependencies: AuthenticationLifecycleDependencies
): AuthenticationLifecycleContext {
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
    const passwordWorkGate = dependencies.passwordWorkGate;
    const passwordWorkBudget =
        dependencies.passwordWorkBudget ??
        createAuthenticationWorkBudget(
            authenticationWorkBudgetMaximumUnits,
            authenticationWorkBudgetWindowMs
        );
    const recentAuthenticationWindowMs =
        dependencies.recentAuthenticationWindowMs ?? recentAuthenticationWindowDefaultMs;
    if (
        !Number.isSafeInteger(recentAuthenticationWindowMs) ||
        recentAuthenticationWindowMs < recentAuthenticationWindowMinimumMs ||
        recentAuthenticationWindowMs > recentAuthenticationWindowMaximumMs
    ) {
        throw new RangeError("Recent-auth window is invalid");
    }

    const context: AuthenticationLifecycleContext = {
        accountPasswordRateLimitTargets: (userId) => [
            {
                blockDurations: sourceRateLimitBlockDurations,
                kind: "account-password",
                subject: userId,
            },
        ],
        anonymousActor: Object.freeze({
            authenticatorId: null,
            id: "browser",
            kind: "anonymous",
        }),
        audit(unit, input) {
            unit.insertAuditEvent(
                createSecurityAuditEvent({ ...input, id: generateId() })
            );
        },
        bootstrapRateLimitTargets: (clientSourceId) => [
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
        ],
        generateId,
        generateSessionToken,
        hashPassword,
        loginRateLimitTargets: (clientSourceId) => [
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
        ],
        mfaLoginLifecycle: dependencies.mfaLoginLifecycle,
        newSession(unit, user, createdAt, userAgent, method = "password") {
            const token = generateSessionToken();
            const record = insertBrowserSession(unit, {
                authenticatedAt: createdAt,
                authenticationMethod: method,
                createdAt,
                expiresAt: addMilliseconds(createdAt, browserSessionAbsoluteDurationMs),
                mfaVerifiedAt: method === "password" ? null : createdAt,
                passwordVerifiedAt: createdAt,
                token,
                user,
                userAgent,
            });
            return { record, token: token.token };
        },
        now,
        passwordWorkBudget,
        passwordWorkGate,
        pruneUserSessions(unit, user, retainedSessionId, checkedAt) {
            unit.pruneUserSessions({
                checkedAt,
                expectedAuthenticationVersion: user.authenticationVersion,
                idleBefore: addMilliseconds(checkedAt, -sessionIdleDurationMs),
                maximumSessions: browserSessionMaximumPerUser,
                retainedSessionId,
                userId: user.id,
            });
        },
        repository: dependencies.repository,
        recentAuthenticationWindowMs,
        sessionIdleDurationMs,
        verifyGatewayCredential: (credential, metadata, settlement) =>
            dependencies.gatewayWorkRuntime.runGatewayVerification<boolean>(
                (signal) => dependencies.verifyGatewayCredential(credential, signal),
                {
                    ...(metadata.signal !== undefined && { signal: metadata.signal }),
                    onBeforeStart: () =>
                        settlement.shouldVerify()
                            ? { proceed: true }
                            : { proceed: false, value: false },
                    onFailureBeforeRelease: (failure) =>
                        settlement.onUnavailable(failure),
                    onResultBeforeRelease: (valid) => {
                        metadata.signal?.throwIfAborted();
                        if (!valid) settlement.onInvalid();
                    },
                    timeoutMs: gatewayVerificationTimeoutMs,
                }
            ),
        verifyPassword,
    };

    return Object.freeze(context);
}
