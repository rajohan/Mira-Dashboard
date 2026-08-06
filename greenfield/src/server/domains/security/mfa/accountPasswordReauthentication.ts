import { getTime } from "date-fns";

import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import { authSession, sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountPasswordRateLimitTargets,
    clearRateLimits,
    currentAccount,
    MfaAccountSessionChangedError,
    MfaAccountStateChangedError,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";

type AccountPasswordReauthenticationOperation = Pick<
    MfaAccountLifecycleService,
    "reauthenticatePassword"
>;

type AccountPasswordReauthenticationPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "readActiveAccount"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "verifyPassword"
>;

function sessionChangedOrThrow(error: unknown): { readonly status: "session-changed" } {
    if (
        error instanceof MfaAccountSessionChangedError ||
        error instanceof MfaAccountStateChangedError
    ) {
        return { status: "session-changed" };
    }
    throw error;
}

/**
 * Creates the password reauthentication and session-rotation operation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountPasswordReauthenticationOperation(
    context: AccountPasswordReauthenticationPort
): AccountPasswordReauthenticationOperation {
    const {
        audit,
        generateSessionToken,
        now,
        passwordWorkBudget,
        passwordWorkGate,
        readActiveAccount,
        repository,
        rotateSession,
        sessionIdleDurationMs,
        verifyPassword,
    } = context;

    return Object.freeze({
        async reauthenticatePassword(identity, input, metadata) {
            const checkedAt = now();
            const snapshot = readActiveAccount(identity, checkedAt);
            if (snapshot === undefined) return { status: "session-changed" };
            const rateLimitTargets = accountPasswordRateLimitTargets(identity.userId);
            const activeLimit = activeRateLimitForTargets(
                repository,
                rateLimitTargets,
                checkedAt
            );
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" };
            }

            const completeVerification = (valid: boolean) => {
                const verifiedAt = now();
                if (!valid) {
                    try {
                        return repository.withImmediateTransaction((unit) => {
                            const activeLimit = activeRateLimitForTargets(
                                unit,
                                rateLimitTargets,
                                verifiedAt
                            );
                            if (activeLimit !== undefined) {
                                return {
                                    ...activeLimit,
                                    status: "rate-limited" as const,
                                };
                            }
                            const current = currentAccount(
                                unit,
                                identity,
                                snapshot,
                                verifiedAt,
                                sessionIdleDurationMs
                            );
                            if (
                                current.user.passwordHash !== snapshot.user.passwordHash
                            ) {
                                throw new MfaAccountSessionChangedError();
                            }
                            const failure = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                verifiedAt
                            );
                            audit(unit, {
                                action: "auth.password.reauthenticate",
                                actor: sessionActor(identity),
                                metadata: { reason: "invalid_current_password" },
                                occurredAt: verifiedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: identity.userId,
                                targetType: "user",
                            });
                            return failure.retryAfterSeconds === undefined
                                ? ({ status: "invalid-password" } as const)
                                : ({
                                      retryAfterSeconds: failure.retryAfterSeconds,
                                      status: "rate-limited",
                                  } as const);
                        });
                    } catch (error) {
                        return sessionChangedOrThrow(error);
                    }
                }

                const sessionToken = generateSessionToken();
                try {
                    return repository.withImmediateTransaction((unit) => {
                        const current = currentAccount(
                            unit,
                            identity,
                            snapshot,
                            verifiedAt,
                            sessionIdleDurationMs
                        );
                        if (current.user.passwordHash !== snapshot.user.passwordHash) {
                            throw new MfaAccountSessionChangedError();
                        }
                        const rotated = rotateSession(
                            unit,
                            current,
                            current.user,
                            sessionToken,
                            {
                                authenticationMethod: "password",
                                createdAt: verifiedAt,
                                mfaVerifiedAt: current.session.mfaVerifiedAt,
                                passwordVerifiedAt: verifiedAt,
                                userAgent: metadata.userAgent,
                            }
                        );
                        clearRateLimits(unit, rateLimitTargets);
                        audit(unit, {
                            action: "auth.password.reauthenticate",
                            actor: sessionActor(identity),
                            metadata: { method: "password" },
                            occurredAt: verifiedAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: rotated.record.id,
                            targetType: "auth_session",
                        });
                        return {
                            session: authSession(rotated.record, rotated.record.id),
                            status: "verified" as const,
                            token: rotated.token,
                            verifiedAtMs: getTime(verifiedAt),
                        };
                    });
                } catch (error) {
                    return sessionChangedOrThrow(error);
                }
            };

            const verificationAdmission = await passwordWorkGate.run(async () => {
                const admittedAt = now();
                const admittedLimit = activeRateLimitForTargets(
                    repository,
                    rateLimitTargets,
                    admittedAt
                );
                if (admittedLimit !== undefined) {
                    return { ...admittedLimit, status: "rate-limited" as const };
                }
                const budget = passwordWorkBudget.consume();
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited" as const,
                    };
                }
                const valid = await verifyPassword(
                    input.password,
                    snapshot.user.passwordHash
                );
                metadata.signal?.throwIfAborted();
                return completeVerification(valid);
            }, metadata.signal);
            if (!verificationAdmission.accepted) {
                return {
                    retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited",
                };
            }
            return verificationAdmission.value;
        },
    });
}
