import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import { authSession, sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountMfaRateLimitTargets,
    accountPasswordRateLimitTargets,
    accountStateError,
    clearRateLimits,
    currentAccount,
    mfaIsRecent,
    MfaAccountSessionChangedError,
    MfaAccountStateChangedError,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";

type AccountMfaDisableOperation = Pick<MfaAccountLifecycleService, "disableMfa">;

type AccountMfaDisablePort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "readActiveAccount"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "verifyPassword"
>;

/**
 * Creates password-confirmed MFA disablement and session revocation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountMfaDisableOperation(
    context: AccountMfaDisablePort
): AccountMfaDisableOperation {
    const {
        audit,
        generateSessionToken,
        now,
        passwordWorkBudget,
        passwordWorkGate,
        readActiveAccount,
        recentAuthenticationWindowMs,
        repository,
        rotateSession,
        sessionIdleDurationMs,
        verifyPassword,
    } = context;

    return Object.freeze({
        async disableMfa(identity, input, metadata) {
            const checkedAt = now();
            const snapshot = readActiveAccount(identity, checkedAt);
            if (snapshot === undefined) return { status: "session-changed" };
            if (snapshot.user.mfaEnabledAt === null) {
                return { status: "mfa-enrollment-required" };
            }
            if (!mfaIsRecent(snapshot, checkedAt, recentAuthenticationWindowMs)) {
                return { status: "step-up-required" };
            }
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
                const completedAt = now();
                if (!valid) {
                    try {
                        return repository.withImmediateTransaction((unit) => {
                            const activeLimit = activeRateLimitForTargets(
                                unit,
                                rateLimitTargets,
                                completedAt
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
                                completedAt,
                                sessionIdleDurationMs
                            );
                            if (
                                current.user.passwordHash !== snapshot.user.passwordHash
                            ) {
                                throw new MfaAccountSessionChangedError();
                            }
                            if (current.user.mfaEnabledAt === null) {
                                return { status: "mfa-enrollment-required" as const };
                            }
                            if (
                                !mfaIsRecent(
                                    current,
                                    completedAt,
                                    recentAuthenticationWindowMs
                                )
                            ) {
                                return { status: "step-up-required" as const };
                            }
                            const failure = recordAuthenticationFailures(
                                unit,
                                rateLimitTargets,
                                completedAt
                            );
                            audit(unit, {
                                action: "auth.mfa.disable",
                                actor: sessionActor(identity),
                                metadata: { reason: "invalid_current_password" },
                                occurredAt: completedAt,
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
                        return accountStateError(error);
                    }
                }

                const sessionToken = generateSessionToken();
                try {
                    return repository.withImmediateTransaction((unit) => {
                        const current = currentAccount(
                            unit,
                            identity,
                            snapshot,
                            completedAt,
                            sessionIdleDurationMs
                        );
                        if (current.user.passwordHash !== snapshot.user.passwordHash) {
                            throw new MfaAccountSessionChangedError();
                        }
                        if (current.user.mfaEnabledAt === null) {
                            return { status: "mfa-enrollment-required" as const };
                        }
                        if (
                            !mfaIsRecent(
                                current,
                                completedAt,
                                recentAuthenticationWindowMs
                            )
                        ) {
                            return { status: "step-up-required" as const };
                        }
                        const disabledUser = unit.updateUserMfaState({
                            expectedAuthenticationVersion:
                                current.user.authenticationVersion,
                            expectedMfaEnabledAt: current.user.mfaEnabledAt,
                            mfaEnabledAt: null,
                            updatedAt: completedAt,
                            userId: identity.userId,
                        });
                        if (disabledUser === undefined) {
                            throw new MfaAccountStateChangedError();
                        }
                        unit.deleteTotpFactorsForUser(identity.userId);
                        unit.deleteWebAuthnCredentialsForUser(identity.userId);
                        unit.deleteRecoveryCodesForUser(identity.userId);
                        unit.deletePendingLoginsForUser(identity.userId);
                        const rotated = rotateSession(
                            unit,
                            current,
                            disabledUser,
                            sessionToken,
                            {
                                authenticationMethod: "password",
                                createdAt: completedAt,
                                mfaVerifiedAt: null,
                                passwordVerifiedAt: completedAt,
                                userAgent: metadata.userAgent,
                            }
                        );
                        const revokedSessions = unit.deleteOtherSessions(
                            identity.userId,
                            rotated.record.id
                        );
                        clearRateLimits(unit, rateLimitTargets);
                        clearRateLimits(
                            unit,
                            accountMfaRateLimitTargets(identity.userId)
                        );
                        audit(unit, {
                            action: "auth.mfa.disable",
                            actor: sessionActor(identity),
                            metadata: { revokedSessions },
                            occurredAt: completedAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: identity.userId,
                            targetType: "user",
                        });
                        return {
                            disabled: true as const,
                            revokedSessions,
                            session: authSession(rotated.record, rotated.record.id),
                            status: "disabled" as const,
                            token: rotated.token,
                        };
                    });
                } catch (error) {
                    return accountStateError(error);
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
