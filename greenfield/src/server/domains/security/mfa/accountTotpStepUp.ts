import { getTime } from "date-fns";

import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
} from "../authenticationRateLimit.ts";
import { authSession, sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountMfaRateLimitTargets,
    accountStateError,
    activeAccount,
    clearRateLimits,
    currentAccount,
    MfaAccountStateChangedError,
    totpFactorReadMaximum,
    totpFactorSetsMatch,
} from "./accountLifecycleState.ts";
import type {
    MfaAccountLifecycleService,
    TotpStepUpResult,
} from "./accountLifecycleTypes.ts";

type AccountTotpStepUpOperation = Pick<MfaAccountLifecycleService, "stepUpTotp">;

type AccountTotpStepUpPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "verifyConfirmedTotpFactors"
>;

/**
 * Creates TOTP step-up with replay-floor CAS and session rotation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountTotpStepUpOperation(
    context: AccountTotpStepUpPort
): AccountTotpStepUpOperation {
    const {
        audit,
        generateSessionToken,
        now,
        repository,
        rotateSession,
        sessionIdleDurationMs,
        verifyConfirmedTotpFactors,
    } = context;

    return Object.freeze({
        async stepUpTotp(identity, input, metadata) {
            const checkedAt = now();
            const snapshot = repository.withReadTransaction((reader) => {
                const account = activeAccount(
                    reader,
                    identity,
                    checkedAt,
                    sessionIdleDurationMs
                );
                if (account === undefined) return { status: "session-changed" as const };
                if (account.user.mfaEnabledAt === null) {
                    return { status: "mfa-enrollment-required" as const };
                }
                const factors = reader.listConfirmedTotpFactors(
                    identity.userId,
                    totpFactorReadMaximum
                );
                if (factors.length === 0 || factors.length >= totpFactorReadMaximum) {
                    return { status: "service-unavailable" as const };
                }
                return { account, factors, status: "ready" as const };
            });
            if (snapshot.status !== "ready") return snapshot;

            const rateLimitTargets = accountMfaRateLimitTargets(identity.userId);
            const activeLimit = activeRateLimitForTargets(
                repository,
                rateLimitTargets,
                checkedAt
            );
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" };
            }
            const settlement = await verifyConfirmedTotpFactors(
                snapshot.factors,
                input.code,
                checkedAt,
                metadata.signal,
                () => {
                    const admittedAt = now();
                    const activeLimit = activeRateLimitForTargets(
                        repository,
                        rateLimitTargets,
                        admittedAt
                    );
                    return activeLimit === undefined
                        ? undefined
                        : { ...activeLimit, status: "rate-limited" as const };
                },
                async (settledVerification): Promise<TotpStepUpResult> => {
                    const verifiedAt = now();
                    if (settledVerification.kind !== "matched") {
                        const unblockedStatus =
                            settledVerification.kind === "unavailable"
                                ? "service-unavailable"
                                : "invalid-proof";
                        try {
                            return await repository.withImmediateTransaction((unit) => {
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
                                    snapshot.account,
                                    verifiedAt,
                                    sessionIdleDurationMs
                                );
                                if (current.user.mfaEnabledAt === null) {
                                    return {
                                        status: "mfa-enrollment-required" as const,
                                    };
                                }
                                const currentFactors = unit.listConfirmedTotpFactors(
                                    identity.userId,
                                    totpFactorReadMaximum
                                );
                                if (
                                    !totpFactorSetsMatch(currentFactors, snapshot.factors)
                                ) {
                                    throw new MfaAccountStateChangedError();
                                }
                                const failure = recordAuthenticationFailures(
                                    unit,
                                    rateLimitTargets,
                                    verifiedAt
                                );
                                audit(unit, {
                                    action: "auth.mfa.step-up",
                                    actor: sessionActor(identity),
                                    metadata: {
                                        method: "totp",
                                        reason: "totp_invalid",
                                    },
                                    occurredAt: verifiedAt,
                                    outcome: "denied",
                                    requestId: metadata.requestId,
                                    targetId: identity.userId,
                                    targetType: "user",
                                });
                                if (failure.retryAfterSeconds === undefined) {
                                    return unblockedStatus === "service-unavailable"
                                        ? ({
                                              status: "service-unavailable",
                                          } as const)
                                        : ({ status: "invalid-proof" } as const);
                                }
                                return {
                                    retryAfterSeconds: failure.retryAfterSeconds,
                                    status: "rate-limited",
                                } as const;
                            });
                        } catch (error) {
                            return accountStateError(error);
                        }
                    }

                    const sessionToken = generateSessionToken();
                    try {
                        return await repository.withImmediateTransaction((unit) => {
                            const current = currentAccount(
                                unit,
                                identity,
                                snapshot.account,
                                verifiedAt,
                                sessionIdleDurationMs
                            );
                            if (current.user.mfaEnabledAt === null) {
                                return {
                                    status: "mfa-enrollment-required" as const,
                                };
                            }
                            const matchedFactor = settledVerification.matched.factor;
                            if (
                                matchedFactor.confirmedAt === null ||
                                matchedFactor.lastUsedStep === null
                            ) {
                                throw new MfaAccountStateChangedError();
                            }
                            const advanced = unit.advanceTotpLastUsedStep({
                                expectedConfirmedAt: matchedFactor.confirmedAt,
                                expectedEncryptedSecret: matchedFactor.encryptedSecret,
                                expectedLastUsedStep: matchedFactor.lastUsedStep,
                                expectedSecretKeyId: matchedFactor.secretKeyId,
                                factorId: matchedFactor.id,
                                lastUsedStep: settledVerification.matched.timeStep,
                                userId: identity.userId,
                            });
                            if (advanced === undefined) {
                                throw new MfaAccountStateChangedError();
                            }
                            const rotated = rotateSession(
                                unit,
                                current,
                                current.user,
                                sessionToken,
                                {
                                    authenticationMethod: "totp",
                                    createdAt: verifiedAt,
                                    mfaVerifiedAt: verifiedAt,
                                    passwordVerifiedAt:
                                        current.session.passwordVerifiedAt,
                                    userAgent: metadata.userAgent,
                                }
                            );
                            clearRateLimits(unit, rateLimitTargets);
                            audit(unit, {
                                action: "auth.mfa.step-up",
                                actor: sessionActor(identity),
                                metadata: { method: "totp" },
                                occurredAt: verifiedAt,
                                outcome: "succeeded",
                                requestId: metadata.requestId,
                                targetId: rotated.record.id,
                                targetType: "auth_session",
                            });
                            return {
                                method: "totp" as const,
                                session: authSession(rotated.record, rotated.record.id),
                                status: "verified" as const,
                                token: rotated.token,
                                verifiedAtMs: getTime(verifiedAt),
                            };
                        });
                    } catch (error) {
                        return accountStateError(error);
                    }
                }
            );
            return settlement;
        },
    });
}
