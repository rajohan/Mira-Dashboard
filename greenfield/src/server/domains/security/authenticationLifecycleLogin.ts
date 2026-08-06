import type { AuthenticationLifecycleContext } from "./authenticationLifecycleContext.ts";
import type { AuthenticationLifecycleService } from "./authenticationLifecycleTypes.ts";
import {
    activeRateLimitForTargets,
    rateLimitBucketKey,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
} from "./authenticationRateLimit.ts";
import { authSession, authUser } from "./authenticationSession.ts";
import { authenticationDummyPasswordHash } from "./password.ts";

type LoginContext = Pick<
    AuthenticationLifecycleContext,
    | "anonymousActor"
    | "audit"
    | "loginRateLimitTargets"
    | "mfaLoginLifecycle"
    | "newSession"
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "pruneUserSessions"
    | "repository"
    | "verifyPassword"
>;

/**
 * Creates the password-first login operation.
 * @returns Login operation backed by the shared lifecycle context.
 */
export function createAuthenticationLoginOperation(
    context: LoginContext
): Pick<AuthenticationLifecycleService, "login"> {
    return {
        async login(input, metadata, currentIdentity) {
            if (context.repository.countUsers() === 0) {
                return { status: "bootstrap-required" };
            }
            const rateLimitTargets = context.loginRateLimitTargets(
                metadata.clientSourceId
            );
            const passwordAdmission = await context.passwordWorkGate.run(async () => {
                if (context.repository.countUsers() === 0) {
                    return { status: "bootstrap-required" } as const;
                }
                const checkedAt = context.now();
                const rateLimit = activeRateLimitForTargets(
                    context.repository,
                    rateLimitTargets,
                    checkedAt
                );
                if (rateLimit !== undefined) {
                    return { ...rateLimit, status: "rate-limited" } as const;
                }
                const workBudget = context.passwordWorkBudget.consume();
                if (!workBudget.accepted) {
                    return {
                        retryAfterSeconds: workBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const user = context.repository.findUserByUsername(input.username);
                const passwordIsValid = await context.verifyPassword(
                    input.password,
                    user?.passwordHash ?? authenticationDummyPasswordHash
                );
                metadata.signal?.throwIfAborted();
                const verificationCompletedAt = context.now();
                if (user === undefined || user.disabledAt !== null || !passwordIsValid) {
                    const failure = context.repository.withImmediateTransaction(
                        (unit) => {
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                verificationCompletedAt
                            );
                            context.audit(unit, {
                                action: "auth.login",
                                actor: context.anonymousActor,
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

                if (user.mfaEnabledAt !== null) {
                    const sourceTarget = rateLimitTargets.find(
                        (target) => target.sourceScoped === true
                    );
                    const pending = context.mfaLoginLifecycle.beginPendingLogin({
                        ...(sourceTarget !== undefined && {
                            clearedPasswordRateLimitBucketKey: rateLimitBucketKey(
                                sourceTarget.kind,
                                sourceTarget.subject
                            ),
                        }),
                        currentIdentity,
                        metadata,
                        userSnapshot: user,
                        verifiedAt: verificationCompletedAt,
                    });
                    if (pending.status === "created") {
                        return {
                            pendingLogin: pending.pendingLogin,
                            status: "mfa-required" as const,
                            token: pending.token,
                        };
                    }
                    if (pending.status === "mfa-unavailable") {
                        return { status: "service-unavailable" } as const;
                    }
                    const failure = context.repository.withImmediateTransaction(
                        (unit) => {
                            const recorded = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                verificationCompletedAt
                            );
                            context.audit(unit, {
                                action: "auth.login",
                                actor: context.anonymousActor,
                                metadata: { reason: "identity_changed" },
                                occurredAt: verificationCompletedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: user.id,
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

                return context.repository.withImmediateTransaction((unit) => {
                    const currentUser = unit.findUserById(user.id);
                    if (
                        currentUser === undefined ||
                        currentUser.disabledAt !== null ||
                        currentUser.mfaEnabledAt !== null ||
                        currentUser.passwordHash !== user.passwordHash ||
                        currentUser.authenticationVersion !== user.authenticationVersion
                    ) {
                        const failure = recordAuthenticationFailures(
                            unit,
                            rateLimitTargets,
                            verificationCompletedAt
                        );
                        context.audit(unit, {
                            action: "auth.login",
                            actor: context.anonymousActor,
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
                    const issued = context.newSession(
                        unit,
                        currentUser,
                        verificationCompletedAt,
                        metadata.userAgent
                    );
                    context.pruneUserSessions(
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
                    context.audit(unit, {
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
    };
}
