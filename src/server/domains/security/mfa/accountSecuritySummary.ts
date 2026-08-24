import { getTime } from "date-fns";

import {
    recoveryCodeCount,
    totpFactorMaximumPerUser,
    type AccountSecuritySummary,
} from "../../../../contracts/accountSecurity.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    activeAccount,
    factorSummary,
    recentAuthentication,
    recoveryCodeReadMaximum,
    totpFactorReadMaximum,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";

type AccountSecuritySummaryOperation = Pick<MfaAccountLifecycleService, "summary">;

type AccountSecuritySummaryPort = Pick<
    MfaAccountLifecycleContext,
    "now" | "recentAuthenticationWindowMs" | "repository" | "sessionIdleDurationMs"
>;

/**
 * Creates the read-only account security inventory operation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountSecuritySummaryOperation(
    context: AccountSecuritySummaryPort
): AccountSecuritySummaryOperation {
    const { now, recentAuthenticationWindowMs, repository, sessionIdleDurationMs } =
        context;

    return Object.freeze({
        summary(identity) {
            const checkedAt = now();
            return repository.withReadTransaction((reader) => {
                const account = activeAccount(
                    reader,
                    identity,
                    checkedAt,
                    sessionIdleDurationMs
                );
                if (account === undefined) return { status: "session-changed" };
                const factors = reader.listConfirmedTotpFactors(
                    identity.userId,
                    totpFactorReadMaximum
                );
                const recoveryCodes = reader.listRecoveryCodes(
                    identity.userId,
                    recoveryCodeReadMaximum
                );
                if (
                    factors.length > totpFactorMaximumPerUser ||
                    recoveryCodes.length > recoveryCodeCount ||
                    (account.user.mfaEnabledAt === null &&
                        (factors.length > 0 || recoveryCodes.length > 0)) ||
                    (account.user.mfaEnabledAt !== null && factors.length === 0)
                ) {
                    throw new Error("Persisted MFA account state is inconsistent");
                }

                const recentAuth = recentAuthentication(
                    account,
                    checkedAt,
                    recentAuthenticationWindowMs
                );
                const recoveryCodesRemaining = recoveryCodes.filter(
                    ({ usedAt }) => usedAt === null
                ).length;
                let mfa: AccountSecuritySummary["mfa"];
                if (account.user.mfaEnabledAt === null) {
                    mfa = {
                        enabled: false,
                        methods: [],
                        recoveryCodesRemaining: 0,
                        totpFactors: [],
                    };
                } else if (recoveryCodesRemaining === 0) {
                    mfa = {
                        enabled: true,
                        enabledAtMs: getTime(account.user.mfaEnabledAt),
                        methods: ["totp"],
                        recoveryCodesRemaining: 0,
                        totpFactors: factors.map((factor) => factorSummary(factor)),
                    };
                } else {
                    mfa = {
                        enabled: true,
                        enabledAtMs: getTime(account.user.mfaEnabledAt),
                        methods: ["recovery", "totp"],
                        recoveryCodesRemaining,
                        totpFactors: factors.map((factor) => factorSummary(factor)),
                    };
                }
                return {
                    status: "found",
                    summary: Object.freeze({
                        checkedAtMs: getTime(checkedAt),
                        mfa,
                        recentAuth,
                    }),
                };
            });
        },
    });
}
