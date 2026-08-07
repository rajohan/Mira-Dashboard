import { getTime } from "date-fns";

import {
    possessionFactorMaximumPerUser,
    recoveryCodeCount,
    totpFactorMaximumPerUser,
    webAuthnCredentialMaximumPerUser,
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
import { webAuthnCredentialSummary } from "./webauthn/credentialState.ts";

type AccountSecuritySummaryOperation = Pick<MfaAccountLifecycleService, "summary">;

type AccountSecuritySummaryPort = Pick<
    MfaAccountLifecycleContext,
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
    | "webAuthnRelyingParty"
>;

const webAuthnCredentialReadMaximum = webAuthnCredentialMaximumPerUser + 1;

/**
 * Creates the read-only account security inventory operation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountSecuritySummaryOperation(
    context: AccountSecuritySummaryPort
): AccountSecuritySummaryOperation {
    const {
        now,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
        webAuthnRelyingParty,
    } = context;

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
                const credentials = reader.listWebAuthnCredentials(
                    identity.userId,
                    webAuthnCredentialReadMaximum
                );
                const possessionFactorCount = factors.length + credentials.length;
                if (
                    factors.length > totpFactorMaximumPerUser ||
                    credentials.length > webAuthnCredentialMaximumPerUser ||
                    possessionFactorCount > possessionFactorMaximumPerUser ||
                    recoveryCodes.length > recoveryCodeCount ||
                    (account.user.mfaEnabledAt === null &&
                        (possessionFactorCount > 0 || recoveryCodes.length > 0)) ||
                    (account.user.mfaEnabledAt !== null && possessionFactorCount === 0)
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
                const totpFactors = factors.map((factor) => factorSummary(factor));
                const webAuthnCredentials = credentials.map((credential) =>
                    webAuthnCredentialSummary(credential, webAuthnRelyingParty?.rpId)
                );
                let mfa: AccountSecuritySummary["mfa"];
                if (account.user.mfaEnabledAt === null) {
                    mfa = {
                        enabled: false,
                        methods: [],
                        recoveryCodesRemaining: 0,
                        totpFactors: [],
                        webAuthnCredentials: [],
                    };
                } else {
                    const enabledAtMs = getTime(account.user.mfaEnabledAt);
                    if (factors.length > 0 && credentials.length > 0) {
                        mfa =
                            recoveryCodesRemaining === 0
                                ? {
                                      enabled: true,
                                      enabledAtMs,
                                      methods: ["totp", "webauthn"],
                                      recoveryCodesRemaining: 0,
                                      totpFactors,
                                      webAuthnCredentials,
                                  }
                                : {
                                      enabled: true,
                                      enabledAtMs,
                                      methods: ["recovery", "totp", "webauthn"],
                                      recoveryCodesRemaining,
                                      totpFactors,
                                      webAuthnCredentials,
                                  };
                    } else if (factors.length > 0) {
                        mfa =
                            recoveryCodesRemaining === 0
                                ? {
                                      enabled: true,
                                      enabledAtMs,
                                      methods: ["totp"],
                                      recoveryCodesRemaining: 0,
                                      totpFactors,
                                      webAuthnCredentials: [],
                                  }
                                : {
                                      enabled: true,
                                      enabledAtMs,
                                      methods: ["recovery", "totp"],
                                      recoveryCodesRemaining,
                                      totpFactors,
                                      webAuthnCredentials: [],
                                  };
                    } else {
                        mfa =
                            recoveryCodesRemaining === 0
                                ? {
                                      enabled: true,
                                      enabledAtMs,
                                      methods: ["webauthn"],
                                      recoveryCodesRemaining: 0,
                                      totpFactors: [],
                                      webAuthnCredentials,
                                  }
                                : {
                                      enabled: true,
                                      enabledAtMs,
                                      methods: ["recovery", "webauthn"],
                                      recoveryCodesRemaining,
                                      totpFactors: [],
                                      webAuthnCredentials,
                                  };
                    }
                }
                return {
                    status: "found",
                    summary: Object.freeze({
                        checkedAtMs: getTime(checkedAt),
                        mfa,
                        recentAuth,
                        webAuthn:
                            webAuthnRelyingParty === undefined
                                ? { available: false as const }
                                : {
                                      available: true as const,
                                      rpId: webAuthnRelyingParty.rpId,
                                  },
                    }),
                };
            });
        },
    });
}
