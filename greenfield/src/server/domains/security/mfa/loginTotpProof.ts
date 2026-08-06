import { totpFactorMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import {
    activeRateLimitForTargets,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import type { MfaTotpFactorRecord } from "./lifecycleRepositoryTypes.ts";
import type { MfaLoginCoordinator } from "./loginCoordinator.ts";
import {
    mfaLoginRateLimitTargets,
    type MfaLoginLifecycleContext,
} from "./loginLifecycleContext.ts";
import type { MfaLoginLifecycleService } from "./loginLifecycleTypes.ts";
import { resolvePendingLogin } from "./loginPendingLifecycle.ts";
import { verifyDashboardTotp } from "./totp.ts";

const totpFactorReadMaximum = totpFactorMaximumPerUser + 1;

type TotpLoginOperation = Pick<MfaLoginLifecycleService, "completeTotpLogin">;

type TotpLoginOperationPort = Pick<
    MfaLoginLifecycleContext,
    "now" | "repository" | "totpSecretCipher" | "totpWorkBudget" | "totpWorkGate"
>;

interface MatchedLoginTotpFactor {
    readonly confirmedAt: Date;
    readonly factor: MfaTotpFactorRecord;
    readonly lastUsedStep: number;
    readonly timeStep: number;
}

/**
 * Creates the TOTP decrypt-and-verify pipeline outside the finish transaction.
 * @returns Frozen TOTP completion operation.
 */
export function createTotpLoginOperation(
    context: TotpLoginOperationPort,
    coordinator: MfaLoginCoordinator
): TotpLoginOperation {
    const { now, repository, totpSecretCipher, totpWorkBudget, totpWorkGate } = context;

    return Object.freeze({
        async completeTotpLogin(credential, input, metadata) {
            const checkedAt = now();
            const targets = mfaLoginRateLimitTargets(metadata.clientSourceId);
            const activeLimit = activeRateLimitForTargets(repository, targets, checkedAt);
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" as const };
            }
            const snapshot = repository.withReadTransaction((reader) => {
                const resolved = resolvePendingLogin(
                    reader,
                    credential,
                    checkedAt,
                    "totp"
                );
                const factors =
                    resolved === undefined
                        ? []
                        : reader.listConfirmedTotpFactors(
                              resolved.user.id,
                              totpFactorReadMaximum
                          );
                return { factors, resolved };
            });
            if (snapshot.resolved === undefined) {
                return coordinator.recordFailure(
                    undefined,
                    credential,
                    metadata,
                    checkedAt,
                    "totp_pending_invalid"
                );
            }
            const resolved = snapshot.resolved;
            if (
                snapshot.factors.length === 0 ||
                snapshot.factors.length >= totpFactorReadMaximum
            ) {
                return { status: "service-unavailable" };
            }

            const admission = await totpWorkGate.run(async () => {
                const admittedAt = now();
                const admittedLimit = activeRateLimitForTargets(
                    repository,
                    targets,
                    admittedAt
                );
                if (admittedLimit !== undefined) {
                    return { ...admittedLimit, status: "rate-limited" as const };
                }
                const budget = totpWorkBudget.consume(snapshot.factors.length);
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited" as const,
                    };
                }
                let matched: MatchedLoginTotpFactor | undefined;
                let secretUnavailable = false;
                for (const factor of snapshot.factors) {
                    if (factor.confirmedAt === null || factor.lastUsedStep === null) {
                        secretUnavailable = true;
                        continue;
                    }
                    try {
                        const secret = await totpSecretCipher.decrypt(
                            {
                                envelope: factor.encryptedSecret,
                                keyId: factor.secretKeyId,
                            },
                            { factorId: factor.id, userId: resolved.user.id }
                        );
                        metadata.signal?.throwIfAborted();
                        const verification = await verifyDashboardTotp({
                            lastUsedTimeStep: factor.lastUsedStep,
                            now: checkedAt,
                            secret,
                            token: input.code,
                        });
                        metadata.signal?.throwIfAborted();
                        if (verification !== undefined) {
                            matched = {
                                confirmedAt: factor.confirmedAt,
                                factor,
                                lastUsedStep: factor.lastUsedStep,
                                timeStep: verification.timeStep,
                            };
                            break;
                        }
                    } catch (error) {
                        metadata.signal?.throwIfAborted();
                        if (
                            error instanceof DOMException &&
                            error.name === "AbortError"
                        ) {
                            throw error;
                        }
                        secretUnavailable = true;
                    }
                }
                if (matched === undefined) {
                    return coordinator.recordFailure(
                        resolved,
                        credential,
                        metadata,
                        now(),
                        "totp_invalid",
                        secretUnavailable ? "service-unavailable" : "invalid-proof"
                    );
                }
                const completedAt = now();
                return coordinator.finishLogin(
                    resolved,
                    credential,
                    "totp",
                    completedAt,
                    metadata,
                    (unit) =>
                        unit.advanceTotpLastUsedStep({
                            expectedConfirmedAt: matched.confirmedAt,
                            expectedEncryptedSecret: matched.factor.encryptedSecret,
                            expectedLastUsedStep: matched.lastUsedStep,
                            expectedSecretKeyId: matched.factor.secretKeyId,
                            factorId: matched.factor.id,
                            lastUsedStep: matched.timeStep,
                            userId: resolved.user.id,
                        }) !== undefined
                );
            }, metadata.signal);
            if (!admission.accepted) {
                return {
                    retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited",
                };
            }
            return admission.value;
        },
    });
}
