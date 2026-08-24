import { getTime } from "date-fns";

import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import { authSession, sessionActor } from "../authenticationSession.ts";
import { authenticationDummyPasswordHash } from "../password.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountMfaRateLimitTargets,
    accountStateError,
    activeAccount,
    clearRateLimits,
    currentAccount,
    MfaAccountStateChangedError,
    recoverySnapshotMatches,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import {
    dashboardRecoveryCodeHashInput,
    parseDashboardRecoveryCode,
} from "./recoveryCodes.ts";

type AccountRecoveryStepUpOperation = Pick<MfaAccountLifecycleService, "stepUpRecovery">;

type AccountRecoveryStepUpPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "verifyRecoveryCode"
>;

/**
 * Creates recovery-code step-up with single-use proof and session rotation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountRecoveryStepUpOperation(
    context: AccountRecoveryStepUpPort
): AccountRecoveryStepUpOperation {
    const {
        audit,
        generateSessionToken,
        now,
        passwordWorkBudget,
        passwordWorkGate,
        repository,
        rotateSession,
        sessionIdleDurationMs,
        verifyRecoveryCode,
    } = context;

    return Object.freeze({
        async stepUpRecovery(identity, input, metadata) {
            const checkedAt = now();
            const parsedCode = parseDashboardRecoveryCode(input.code);
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
                const recovery =
                    parsedCode === undefined
                        ? undefined
                        : reader.findRecoveryCode(identity.userId, parsedCode.selector);
                return { account, recovery, status: "ready" as const };
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

            const completeVerification = async (valid: boolean) => {
                const verifiedAt = now();
                if (
                    !valid ||
                    parsedCode === undefined ||
                    snapshot.recovery === undefined
                ) {
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
                                return { status: "mfa-enrollment-required" as const };
                            }
                            const currentRecovery =
                                parsedCode === undefined
                                    ? undefined
                                    : unit.findRecoveryCode(
                                          identity.userId,
                                          parsedCode.selector
                                      );
                            if (
                                !recoverySnapshotMatches(
                                    currentRecovery,
                                    snapshot.recovery
                                )
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
                                    method: "recovery",
                                    reason: "recovery_invalid",
                                },
                                occurredAt: verifiedAt,
                                outcome: "denied",
                                requestId: metadata.requestId,
                                targetId: identity.userId,
                                targetType: "user",
                            });
                            return failure.retryAfterSeconds === undefined
                                ? ({ status: "invalid-proof" } as const)
                                : ({
                                      retryAfterSeconds: failure.retryAfterSeconds,
                                      status: "rate-limited",
                                  } as const);
                        });
                    } catch (error) {
                        return accountStateError(error);
                    }
                }

                const verifiedRecovery = snapshot.recovery;
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
                            return { status: "mfa-enrollment-required" as const };
                        }
                        const consumed = unit.consumeRecoveryCode({
                            codeId: verifiedRecovery.id,
                            expectedCreatedAt: verifiedRecovery.createdAt,
                            expectedValidatorHash: verifiedRecovery.validatorHash,
                            selector: parsedCode.selector,
                            usedAt: verifiedAt,
                            userId: identity.userId,
                        });
                        if (consumed === undefined) {
                            throw new MfaAccountStateChangedError();
                        }
                        const rotated = rotateSession(
                            unit,
                            current,
                            current.user,
                            sessionToken,
                            {
                                authenticationMethod: "recovery",
                                createdAt: verifiedAt,
                                mfaVerifiedAt: verifiedAt,
                                passwordVerifiedAt: current.session.passwordVerifiedAt,
                                userAgent: metadata.userAgent,
                            }
                        );
                        clearRateLimits(unit, rateLimitTargets);
                        const recoveryCodesRemaining = unit.countUnusedRecoveryCodes(
                            identity.userId
                        );
                        if (recoveryCodesRemaining >= recoveryCodeCount) {
                            throw new MfaAccountStateChangedError();
                        }
                        audit(unit, {
                            action: "auth.mfa.step-up",
                            actor: sessionActor(identity),
                            metadata: { method: "recovery" },
                            occurredAt: verifiedAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: rotated.record.id,
                            targetType: "auth_session",
                        });
                        return {
                            method: "recovery" as const,
                            recoveryCodesRemaining,
                            session: authSession(rotated.record, rotated.record.id),
                            status: "verified" as const,
                            token: rotated.token,
                            verifiedAtMs: getTime(verifiedAt),
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
                const hashInput =
                    parsedCode === undefined
                        ? "mira-dashboard:recovery-code:dummy"
                        : dashboardRecoveryCodeHashInput(identity.userId, parsedCode);
                const valid = await verifyRecoveryCode(
                    hashInput,
                    snapshot.recovery?.usedAt === null
                        ? snapshot.recovery.validatorHash
                        : authenticationDummyPasswordHash
                );
                metadata.signal?.throwIfAborted();
                return completeVerification(
                    valid &&
                        parsedCode !== undefined &&
                        snapshot.recovery?.usedAt === null
                );
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
