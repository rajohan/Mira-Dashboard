import { addMilliseconds } from "date-fns";

import { browserSessionMaximumPerUser } from "../../../../contracts/auth.ts";
import type { MultiFactorAuthenticationMethod } from "../../../../contracts/security.ts";
import type { ParsedOpaqueToken } from "../../../shared/opaqueToken.ts";
import { browserSessionAbsoluteDurationMs } from "../authenticationPolicy.ts";
import {
    activeRateLimitForTargets,
    rateLimitBucketKey,
    recordAuthenticationFailures,
} from "../authenticationRateLimit.ts";
import {
    authSession,
    authUser,
    insertBrowserSession,
    type AuthenticationRequestMetadata,
} from "../authenticationSession.ts";
import {
    pendingLoginAttemptMaximum,
    type MfaLifecycleUnitOfWork,
} from "./lifecycleRepositoryTypes.ts";
import {
    mfaLoginRateLimitTargets,
    type MfaLoginLifecycleContext,
} from "./loginLifecycleContext.ts";
import type { CompleteMfaLoginResult } from "./loginLifecycleTypes.ts";
import type { ResolvedPendingLogin } from "./loginPendingLifecycle.ts";

export type MfaLoginFailureReason =
    | "recovery_invalid"
    | "recovery_pending_invalid"
    | "totp_invalid"
    | "totp_pending_invalid";

export interface MfaLoginCoordinator {
    readonly finishLogin: (
        resolved: ResolvedPendingLogin,
        credential: ParsedOpaqueToken,
        method: MultiFactorAuthenticationMethod,
        completedAt: Date,
        metadata: AuthenticationRequestMetadata,
        consumeProof: (unit: MfaLifecycleUnitOfWork) => boolean
    ) => CompleteMfaLoginResult;
    readonly recordFailure: (
        resolved: ResolvedPendingLogin | undefined,
        credential: ParsedOpaqueToken,
        metadata: AuthenticationRequestMetadata,
        failedAt: Date,
        reason: MfaLoginFailureReason,
        unblockedStatus?: "invalid-proof" | "service-unavailable"
    ) => CompleteMfaLoginResult;
}

type MfaLoginCoordinatorPort = Pick<
    MfaLoginLifecycleContext,
    "audit" | "generateSessionToken" | "repository" | "sessionIdleDurationMs"
>;

class MfaLoginStateChangedError extends Error {}

/**
 * Owns the atomic failure recording and successful pending-login transition.
 * @returns Frozen coordinator with the sole successful finish transaction.
 */
export function createMfaLoginCoordinator(
    context: MfaLoginCoordinatorPort
): MfaLoginCoordinator {
    const { audit, generateSessionToken, repository, sessionIdleDurationMs } = context;

    const finishLogin: MfaLoginCoordinator["finishLogin"] = (
        resolved,
        credential,
        method,
        completedAt,
        metadata,
        consumeProof
    ) => {
        const sourceTarget = mfaLoginRateLimitTargets(metadata.clientSourceId).find(
            (target) => target.sourceScoped === true
        );
        const sessionToken = generateSessionToken();
        try {
            return repository.withImmediateTransaction((unit) => {
                const currentUser = unit.findUserById(resolved.user.id);
                if (
                    currentUser === undefined ||
                    currentUser.disabledAt !== null ||
                    currentUser.mfaEnabledAt === null ||
                    currentUser.authenticationVersion !==
                        resolved.user.authenticationVersion
                ) {
                    throw new MfaLoginStateChangedError();
                }
                const consumedPending = unit.consumePendingLogin({
                    authenticationVersion: resolved.pending.authenticationVersion,
                    checkedAt: completedAt,
                    id: credential.prefix,
                    method,
                    userId: resolved.user.id,
                    validatorHash: credential.validatorHash,
                });
                if (consumedPending === undefined || !consumeProof(unit)) {
                    throw new MfaLoginStateChangedError();
                }
                if (consumedPending.replacedSessionId !== null) {
                    unit.deleteSession(
                        resolved.user.id,
                        consumedPending.replacedSessionId
                    );
                }
                const session = insertBrowserSession(unit, {
                    authenticatedAt: consumedPending.passwordVerifiedAt,
                    authenticationMethod: method,
                    createdAt: completedAt,
                    expiresAt: addMilliseconds(
                        consumedPending.passwordVerifiedAt,
                        browserSessionAbsoluteDurationMs
                    ),
                    mfaVerifiedAt: completedAt,
                    passwordVerifiedAt: consumedPending.passwordVerifiedAt,
                    token: sessionToken,
                    user: currentUser,
                    userAgent:
                        metadata.userAgent ?? consumedPending.userAgent ?? undefined,
                });
                unit.pruneSessions({
                    checkedAt: completedAt,
                    expectedAuthenticationVersion: currentUser.authenticationVersion,
                    idleBefore: addMilliseconds(completedAt, -sessionIdleDurationMs),
                    maximumSessions: browserSessionMaximumPerUser,
                    retainedSessionId: session.id,
                    userId: currentUser.id,
                });
                if (sourceTarget !== undefined) {
                    unit.deleteRateLimitBucket(
                        rateLimitBucketKey(sourceTarget.kind, sourceTarget.subject)
                    );
                }
                audit(unit, {
                    action: "auth.login.mfa",
                    actor: {
                        authenticatorId: session.id,
                        id: currentUser.id,
                        kind: "user",
                    },
                    metadata: { method },
                    occurredAt: completedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: session.id,
                    targetType: "auth_session",
                });
                return {
                    session: authSession(session, session.id),
                    status: "authenticated" as const,
                    token: sessionToken.token,
                    user: authUser(currentUser),
                };
            });
        } catch (error) {
            if (error instanceof MfaLoginStateChangedError) {
                return { status: "state-changed" };
            }
            throw error;
        }
    };

    const recordFailure: MfaLoginCoordinator["recordFailure"] = (
        resolved,
        credential,
        metadata,
        failedAt,
        reason,
        unblockedStatus = "invalid-proof"
    ) => {
        const targets = mfaLoginRateLimitTargets(metadata.clientSourceId);
        return repository.withImmediateTransaction((unit) => {
            const activeLimit = activeRateLimitForTargets(unit, targets, failedAt);
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" as const };
            }
            if (resolved !== undefined) {
                const updated = unit.incrementPendingLoginAttempt({
                    authenticationVersion: resolved.pending.authenticationVersion,
                    failedAt,
                    id: credential.prefix,
                    userId: resolved.user.id,
                    validatorHash: credential.validatorHash,
                });
                if (updated?.attemptCount === pendingLoginAttemptMaximum) {
                    unit.deletePendingLogin(updated.userId, updated.id);
                }
            }
            const recorded = recordAuthenticationFailures(unit, targets, failedAt);
            audit(unit, {
                action: "auth.login.mfa",
                actor: { authenticatorId: null, id: "browser", kind: "anonymous" },
                metadata: {
                    method: reason.startsWith("recovery") ? "recovery" : "totp",
                    reason,
                },
                occurredAt: failedAt,
                outcome: "denied",
                requestId: metadata.requestId,
                targetId: resolved?.user.id ?? "unknown",
                targetType: "user",
            });
            if (recorded.retryAfterSeconds === undefined) {
                return unblockedStatus === "service-unavailable"
                    ? ({ status: "service-unavailable" } as const)
                    : ({ status: "invalid-proof" } as const);
            }
            return {
                retryAfterSeconds: recorded.retryAfterSeconds,
                status: "rate-limited",
            } as const;
        });
    };

    return Object.freeze({ finishLogin, recordFailure });
}
