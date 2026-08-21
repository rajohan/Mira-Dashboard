import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import { saturatedAuthenticationRetryAfterSeconds } from "../authenticationRateLimit.ts";
import type { AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import type { AuthenticationWorkGate } from "../authenticationWorkGate.ts";
import type { RateLimitedResult } from "./accountLifecycleTypes.ts";
import type { MfaTotpFactorRecord } from "./lifecycleRepositoryTypes.ts";
import type { GeneratedRecoveryCode } from "./recoveryCodes.ts";
import type { TotpVerificationResult, VerifyDashboardTotpInput } from "./totp.ts";
import type { TotpSecretCipher } from "./totpSecretCipher.ts";

export interface PreparedRecoveryCode {
    readonly code: string;
    readonly id: string;
    readonly selector: string;
    readonly validatorHash: string;
}

export interface PreparedRecoveryCodeSet {
    readonly codes: readonly string[];
    readonly records: readonly PreparedRecoveryCode[];
}

export interface MatchedTotpFactor {
    readonly factor: MfaTotpFactorRecord;
    readonly timeStep: number;
}

export type ConfirmedTotpFactorsVerification =
    | { readonly kind: "matched"; readonly matched: MatchedTotpFactor }
    | { readonly kind: "not-matched" }
    | { readonly kind: "unavailable" };

export interface AccountLifecycleCryptoHelpers {
    readonly prepareRecoveryCodeSet: (
        userId: string,
        signal: AbortSignal | undefined
    ) => Promise<PreparedRecoveryCodeSet | RateLimitedResult>;
    readonly verifyConfirmedTotpFactors: <Settlement>(
        factors: readonly MfaTotpFactorRecord[],
        code: string,
        checkedAt: Date,
        signal: AbortSignal | undefined,
        recheckRateLimit: (() => RateLimitedResult | undefined) | undefined,
        settleVerification: (
            verification: ConfirmedTotpFactorsVerification
        ) => Promise<Settlement>
    ) => Promise<Settlement | RateLimitedResult>;
}

export interface AccountLifecycleCryptoOptions {
    readonly generateId: () => string;
    readonly generateRecoveryCodes: (userId: string) => readonly GeneratedRecoveryCode[];
    readonly hashRecoveryCode: (hashInput: string) => Promise<string>;
    readonly passwordWorkBudget: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly totpWorkBudget: AuthenticationWorkBudget;
    readonly totpWorkGate: AuthenticationWorkGate;
    readonly verifyTotp: (
        input: VerifyDashboardTotpInput
    ) => Promise<TotpVerificationResult | undefined>;
}

/**
 * Creates expensive MFA work helpers that never receive a database unit of work.
 * @returns Recovery-hash preparation and confirmed-factor verification helpers.
 */
export function createAccountLifecycleCryptoHelpers(
    options: AccountLifecycleCryptoOptions
): AccountLifecycleCryptoHelpers {
    const prepareRecoveryCodeSet: AccountLifecycleCryptoHelpers["prepareRecoveryCodeSet"] =
        async (userId, signal) => {
            const admission = await options.passwordWorkGate.run(async () => {
                const budget = options.passwordWorkBudget.consume(recoveryCodeCount);
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited" as const,
                    };
                }
                const generated = options.generateRecoveryCodes(userId);
                if (generated.length !== recoveryCodeCount) {
                    throw new Error("Recovery-code generator returned an incomplete set");
                }
                const records: PreparedRecoveryCode[] = [];
                for (const generatedCode of generated) {
                    signal?.throwIfAborted();
                    const validatorHash = await options.hashRecoveryCode(
                        generatedCode.validatorHashInput
                    );
                    signal?.throwIfAborted();
                    records.push(
                        Object.freeze({
                            code: generatedCode.code,
                            id: options.generateId(),
                            selector: generatedCode.selector,
                            validatorHash,
                        })
                    );
                }
                return Object.freeze({
                    codes: Object.freeze(records.map(({ code }) => code)),
                    records: Object.freeze(records),
                });
            }, signal);
            return admission.accepted
                ? admission.value
                : {
                      retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                      status: "rate-limited",
                  };
        };

    const verifyConfirmedTotpFactors: AccountLifecycleCryptoHelpers["verifyConfirmedTotpFactors"] =
        async (
            factors,
            code,
            checkedAt,
            signal,
            recheckRateLimit,
            settleVerification
        ) => {
            if (factors.length === 0) {
                return await settleVerification({ kind: "not-matched" });
            }
            const admission = await options.totpWorkGate.run(async () => {
                const activeLimit = recheckRateLimit?.();
                if (activeLimit !== undefined) return activeLimit;
                const budget = options.totpWorkBudget.consume(factors.length);
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited" as const,
                    };
                }
                let matched: MatchedTotpFactor | undefined;
                let secretUnavailable = false;
                for (const factor of factors) {
                    if (factor.confirmedAt === null || factor.lastUsedStep === null) {
                        secretUnavailable = true;
                        continue;
                    }
                    try {
                        const secret = await options.totpSecretCipher.decrypt(
                            {
                                envelope: factor.encryptedSecret,
                                keyId: factor.secretKeyId,
                            },
                            { factorId: factor.id, userId: factor.userId }
                        );
                        signal?.throwIfAborted();
                        const verification = await options.verifyTotp({
                            lastUsedTimeStep: factor.lastUsedStep,
                            now: checkedAt,
                            secret,
                            token: code,
                        });
                        signal?.throwIfAborted();
                        if (verification !== undefined) {
                            matched = { factor, timeStep: verification.timeStep };
                            break;
                        }
                    } catch (error) {
                        signal?.throwIfAborted();
                        if (
                            error instanceof DOMException &&
                            error.name === "AbortError"
                        ) {
                            throw error;
                        }
                        secretUnavailable = true;
                    }
                }
                let verification: ConfirmedTotpFactorsVerification;
                if (matched !== undefined) {
                    verification = { kind: "matched", matched };
                } else if (secretUnavailable) {
                    verification = { kind: "unavailable" };
                } else {
                    verification = { kind: "not-matched" };
                }
                signal?.throwIfAborted();
                return await settleVerification(verification);
            }, signal);
            return admission.accepted
                ? admission.value
                : {
                      retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                      status: "rate-limited",
                  };
        };

    return Object.freeze({ prepareRecoveryCodeSet, verifyConfirmedTotpFactors });
}
