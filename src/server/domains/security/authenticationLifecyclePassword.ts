import {
    AuthenticationStateChangedError,
    type AuthenticationLifecycleContext,
} from "./authenticationLifecycleContext.ts";
import type { AuthenticationLifecycleUnitOfWork } from "./authenticationLifecycleRepository.ts";
import type { AuthenticationLifecycleService } from "./authenticationLifecycleTypes.ts";
import {
    activeRateLimitForTargets,
    rateLimitBucketKey,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
} from "./authenticationRateLimit.ts";
import {
    authSession,
    authUser,
    browserSessionIsActive as sessionIsActive,
    insertBrowserSession,
    sessionActor,
    type AuthenticatedBrowserIdentity,
} from "./authenticationSession.ts";
import { evaluateRecentAuthentication } from "./recentAuthentication.ts";
import type {
    BrowserSessionRecord,
    SecurityUserRecord,
} from "./securityPersistenceTypes.ts";

type PasswordContext = Pick<
    AuthenticationLifecycleContext,
    | "accountPasswordRateLimitTargets"
    | "audit"
    | "generateSessionToken"
    | "hashPassword"
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
    | "verifyPassword"
>;

interface PasswordChangeSnapshot {
    readonly session: BrowserSessionRecord;
    readonly user: SecurityUserRecord;
}

type RevalidatedPasswordChange =
    | { readonly status: "current"; readonly snapshot: PasswordChangeSnapshot }
    | { readonly status: "session-changed" }
    | { readonly status: "step-up-required" };

function nullableDatesMatch(left: Date | null, right: Date | null): boolean {
    return left === null ? right === null : right !== null && +left === +right;
}

function revalidatePasswordChange(
    context: PasswordContext,
    unit: AuthenticationLifecycleUnitOfWork,
    identity: AuthenticatedBrowserIdentity,
    expected: PasswordChangeSnapshot,
    checkedAt: Date
): RevalidatedPasswordChange {
    const currentUser = unit.findUserById(identity.userId);
    if (
        currentUser === undefined ||
        currentUser.disabledAt !== null ||
        currentUser.passwordHash !== expected.user.passwordHash ||
        currentUser.authenticationVersion !== expected.user.authenticationVersion ||
        !nullableDatesMatch(currentUser.mfaEnabledAt, expected.user.mfaEnabledAt)
    ) {
        return { status: "session-changed" };
    }
    const currentSession = unit.findSession(identity.userId, identity.sessionId);
    if (
        currentSession === undefined ||
        currentSession.validatorHash !== expected.session.validatorHash ||
        currentSession.authenticationVersion !== currentUser.authenticationVersion ||
        !sessionIsActive(currentSession, checkedAt, context.sessionIdleDurationMs)
    ) {
        return { status: "session-changed" };
    }
    if (
        currentUser.mfaEnabledAt !== null &&
        !evaluateRecentAuthentication({
            checkedAt,
            mfaEnabledAt: currentUser.mfaEnabledAt,
            mfaVerifiedAt: currentSession.mfaVerifiedAt,
            passwordVerifiedAt: currentSession.passwordVerifiedAt,
            windowMs: context.recentAuthenticationWindowMs,
        }).mfa.recent
    ) {
        return { status: "step-up-required" };
    }
    return {
        snapshot: { session: currentSession, user: currentUser },
        status: "current",
    };
}

/**
 * Creates the current-password verification and password-rotation operation.
 * @returns Password-change operation backed by the shared lifecycle context.
 */
export function createAuthenticationPasswordOperation(
    context: PasswordContext
): Pick<AuthenticationLifecycleService, "changePassword"> {
    return {
        async changePassword(identity, input, metadata) {
            const rateLimitTargets = context.accountPasswordRateLimitTargets(
                identity.userId
            );
            const passwordAdmission = await context.passwordWorkGate.run(async () => {
                const checkedAt = context.now();
                const user = context.repository.findUserById(identity.userId);
                const session = context.repository.findSession(
                    identity.userId,
                    identity.sessionId
                );
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    session === undefined ||
                    session.authenticationVersion !== user.authenticationVersion ||
                    !sessionIsActive(session, checkedAt, context.sessionIdleDurationMs)
                ) {
                    return { status: "session-changed" } as const;
                }
                const expected = { session, user };
                if (
                    user.mfaEnabledAt !== null &&
                    !evaluateRecentAuthentication({
                        checkedAt,
                        mfaEnabledAt: user.mfaEnabledAt,
                        mfaVerifiedAt: session.mfaVerifiedAt,
                        passwordVerifiedAt: session.passwordVerifiedAt,
                        windowMs: context.recentAuthenticationWindowMs,
                    }).mfa.recent
                ) {
                    return { status: "step-up-required" } as const;
                }
                const rateLimit = activeRateLimitForTargets(
                    context.repository,
                    rateLimitTargets,
                    checkedAt
                );
                if (rateLimit !== undefined) {
                    return { ...rateLimit, status: "rate-limited" } as const;
                }
                const verificationBudget = context.passwordWorkBudget.consume();
                if (!verificationBudget.accepted) {
                    return {
                        retryAfterSeconds: verificationBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const isCurrentPassword = await context.verifyPassword(
                    input.currentPassword,
                    user.passwordHash
                );
                metadata.signal?.throwIfAborted();
                if (!isCurrentPassword) {
                    const failedAt = context.now();
                    const failure = await context.repository.withImmediateTransaction(
                        (unit) => {
                            const state = revalidatePasswordChange(
                                context,
                                unit,
                                identity,
                                expected,
                                failedAt
                            );
                            if (state.status !== "current") return state;
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                failedAt
                            );
                            context.audit(unit, {
                                action: "auth.password.change",
                                actor: sessionActor(identity),
                                metadata: { reason: "invalid_current_password" },
                                occurredAt: failedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: identity.userId,
                                targetType: "user",
                            });
                            return { ...recorded, status: "recorded" } as const;
                        }
                    );
                    if (failure.status !== "recorded") return failure;
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
                const hashingBudget = context.passwordWorkBudget.consume();
                if (!hashingBudget.accepted) {
                    return {
                        retryAfterSeconds: hashingBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const passwordHash = await context.hashPassword(input.newPassword);
                metadata.signal?.throwIfAborted();
                const changedAt = context.now();
                try {
                    return await context.repository.withImmediateTransaction((unit) => {
                        const state = revalidatePasswordChange(
                            context,
                            unit,
                            identity,
                            expected,
                            changedAt
                        );
                        if (state.status !== "current") return state;
                        const { session: currentSession, user: currentUser } =
                            state.snapshot;
                        const updatedUser = unit.updateUserPassword({
                            expectedAuthenticationVersion:
                                expected.user.authenticationVersion,
                            expectedPasswordHash: expected.user.passwordHash,
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
                        const sessionToken = context.generateSessionToken();
                        const issuedRecord = insertBrowserSession(unit, {
                            authenticatedAt: currentSession.authenticatedAt,
                            authenticationMethod: "password",
                            createdAt: changedAt,
                            expiresAt: currentSession.expiresAt,
                            mfaVerifiedAt:
                                currentUser.mfaEnabledAt === null
                                    ? null
                                    : currentSession.mfaVerifiedAt,
                            passwordVerifiedAt: changedAt,
                            token: sessionToken,
                            user: updatedUser,
                            userAgent: metadata.userAgent,
                        });
                        const revokedSessions = unit.deleteOtherSessions(
                            identity.userId,
                            issuedRecord.id
                        );
                        for (const target of rateLimitTargets) {
                            unit.deleteRateLimitBucket(
                                rateLimitBucketKey(target.kind, target.subject)
                            );
                        }
                        context.audit(unit, {
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
                            session: authSession(issuedRecord, issuedRecord.id),
                            status: "changed" as const,
                            token: sessionToken.token,
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
    };
}
