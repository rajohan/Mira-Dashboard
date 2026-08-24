import {
    activeRateLimitForTargets,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import {
    AuthenticationUpstreamUnavailableError,
    AuthenticationWorkCapacityError,
    AuthenticationWorkTimeoutError,
} from "../authenticationWorkGate.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import { accountMfaRateLimitTargets, activeAccount } from "./accountLifecycleState.ts";
import type {
    MfaAccountLifecycleService,
    WebAuthnStepUpResult,
} from "./accountLifecycleTypes.ts";
import {
    possessionFactorSnapshotIsConsistent,
    possessionFactorSnapshotMatches,
    possessionFactorStateMatchesAccount,
    readAccountPossessionFactorSnapshot,
    sessionWebAuthnChallengeIsCurrent,
    webAuthnChallengeSnapshotMatches,
    type AccountPossessionFactorSnapshot,
} from "./accountWebAuthnState.ts";
import {
    createAccountWebAuthnStepUpSettlement,
    type AccountWebAuthnStepUpAdmission,
} from "./accountWebAuthnStepUpSettlement.ts";
import type { MfaWebAuthnCredentialRecord } from "./lifecycleRepositoryTypes.ts";
import type {
    VerifiedWebAuthnAuthentication,
    WebAuthnVerificationResult,
} from "./webauthn/adapter.ts";
import { webAuthnStoredCredential } from "./webauthn/credentialState.ts";
import { createWebAuthnUserHandle } from "./webauthn/relyingPartyConfiguration.ts";

type AccountWebAuthnStepUpOperation = Pick<MfaAccountLifecycleService, "stepUpWebAuthn">;

type AccountWebAuthnStepUpPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "webAuthnAdapter"
    | "webAuthnRelyingParty"
    | "webAuthnVerificationTimeoutMs"
    | "webAuthnWorkBudget"
    | "webAuthnWorkRuntime"
>;

type StepUpVerification = WebAuthnVerificationResult<VerifiedWebAuthnAuthentication>;

type StepUpWorkValue =
    | { readonly result: WebAuthnStepUpResult; readonly status: "skipped" }
    | { readonly status: "verified-work"; readonly verification: StepUpVerification };

function activeRelyingPartyCredentials(
    snapshot: AccountPossessionFactorSnapshot,
    rpId: string
): readonly MfaWebAuthnCredentialRecord[] {
    return snapshot.webAuthnCredentials.filter((credential) => credential.rpId === rpId);
}

/**
 * Verifies one session-bound WebAuthn assertion under the process Effect gate.
 * Every admitted attempt consumes its challenge before the gate permit is released.
 * @returns The focused WebAuthn step-up operation.
 */
export function createAccountWebAuthnStepUpOperation(
    context: AccountWebAuthnStepUpPort
): AccountWebAuthnStepUpOperation {
    const {
        now,
        repository,
        sessionIdleDurationMs,
        webAuthnAdapter,
        webAuthnRelyingParty,
        webAuthnVerificationTimeoutMs,
        webAuthnWorkBudget,
        webAuthnWorkRuntime,
    } = context;

    return Object.freeze({
        async stepUpWebAuthn(identity, input, metadata) {
            if (
                webAuthnAdapter === undefined ||
                webAuthnRelyingParty === undefined ||
                webAuthnVerificationTimeoutMs === undefined ||
                webAuthnWorkBudget === undefined ||
                webAuthnWorkRuntime === undefined
            ) {
                return { status: "service-unavailable" };
            }

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
                const challenge = reader.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "step-up"
                );
                if (
                    !sessionWebAuthnChallengeIsCurrent(
                        challenge,
                        account,
                        "step-up",
                        webAuthnRelyingParty,
                        checkedAt
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                const factors = readAccountPossessionFactorSnapshot(
                    reader,
                    identity.userId
                );
                const activeCredentials = activeRelyingPartyCredentials(
                    factors,
                    webAuthnRelyingParty.rpId
                );
                if (
                    !possessionFactorSnapshotIsConsistent(factors) ||
                    !possessionFactorStateMatchesAccount(account, factors) ||
                    activeCredentials.length === 0
                ) {
                    return { status: "service-unavailable" as const };
                }
                return {
                    account,
                    challenge,
                    factors,
                    selectedCredential: activeCredentials.find(
                        (credential) => credential.credentialId === input.response.id
                    ),
                    status: "ready" as const,
                };
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

            let admission: AccountWebAuthnStepUpAdmission | undefined;
            let settledResult: WebAuthnStepUpResult | undefined;
            const settlement = createAccountWebAuthnStepUpSettlement(
                context,
                identity,
                metadata
            );
            const { settleInvalidProof, settleVerified } = settlement;
            const consumeWithoutFailure = (
                outcome: "cancelled" | "failed"
            ): WebAuthnStepUpResult | undefined => {
                const admitted = admission;
                return admitted === undefined
                    ? undefined
                    : settlement.consumeWithoutFailure(admitted, outcome);
            };

            try {
                const workValue =
                    await webAuthnWorkRuntime.runWebAuthnVerification<StepUpWorkValue>(
                        async (signal) => {
                            const admitted = admission;
                            if (admitted === undefined) {
                                throw new Error("WebAuthn step-up admission is missing");
                            }
                            signal.throwIfAborted();
                            const stored = webAuthnStoredCredential(
                                admitted.selectedCredential ?? admitted.fallbackCredential
                            );
                            const verificationCredential =
                                admitted.selectedCredential === undefined
                                    ? Object.freeze({
                                          ...stored,
                                          id: input.response.id,
                                      })
                                    : stored;
                            const verification =
                                await webAuthnAdapter.verifyAuthentication({
                                    credential: verificationCredential,
                                    expectedChallenge: admitted.challenge.challenge,
                                    expectedUserHandle: createWebAuthnUserHandle(
                                        identity.userId
                                    ),
                                    response: input.response,
                                });
                            signal.throwIfAborted();
                            return { status: "verified-work", verification };
                        },
                        {
                            onBeforeStart: () => {
                                const admittedAt = now();
                                const decision = repository.withReadTransaction(
                                    (reader) => {
                                        const account = activeAccount(
                                            reader,
                                            identity,
                                            admittedAt,
                                            sessionIdleDurationMs
                                        );
                                        if (
                                            account === undefined ||
                                            account.user.authenticationVersion !==
                                                snapshot.account.user
                                                    .authenticationVersion ||
                                            account.session.validatorHash !==
                                                snapshot.account.session.validatorHash
                                        ) {
                                            return {
                                                result: {
                                                    status: "session-changed",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        if (account.user.mfaEnabledAt === null) {
                                            return {
                                                result: {
                                                    status: "mfa-enrollment-required",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        const challenge =
                                            reader.findSessionWebAuthnChallenge(
                                                identity.sessionId,
                                                "step-up"
                                            );
                                        if (
                                            !sessionWebAuthnChallengeIsCurrent(
                                                challenge,
                                                account,
                                                "step-up",
                                                webAuthnRelyingParty,
                                                admittedAt
                                            ) ||
                                            !webAuthnChallengeSnapshotMatches(
                                                challenge,
                                                snapshot.challenge
                                            ) ||
                                            !possessionFactorSnapshotMatches(
                                                reader,
                                                identity.userId,
                                                snapshot.factors
                                            )
                                        ) {
                                            return {
                                                result: {
                                                    status: "state-changed",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        const activeCredentials =
                                            activeRelyingPartyCredentials(
                                                snapshot.factors,
                                                webAuthnRelyingParty.rpId
                                            );
                                        const fallbackCredential = activeCredentials[0];
                                        if (fallbackCredential === undefined) {
                                            return {
                                                result: {
                                                    status: "service-unavailable",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        const activeLimit = activeRateLimitForTargets(
                                            reader,
                                            rateLimitTargets,
                                            admittedAt
                                        );
                                        if (activeLimit !== undefined) {
                                            return {
                                                result: {
                                                    ...activeLimit,
                                                    status: "rate-limited",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        const budget = webAuthnWorkBudget.consume();
                                        if (!budget.accepted) {
                                            return {
                                                result: {
                                                    retryAfterSeconds:
                                                        budget.retryAfterSeconds,
                                                    status: "rate-limited",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        admission = {
                                            account,
                                            admittedAt,
                                            challenge,
                                            factors: snapshot.factors,
                                            fallbackCredential,
                                            selectedCredential:
                                                snapshot.selectedCredential,
                                        };
                                        return { status: "proceed" as const };
                                    }
                                );
                                return decision.status === "proceed"
                                    ? { proceed: true }
                                    : { proceed: false, value: decision };
                            },
                            onCancellationBeforeRelease: () => {
                                consumeWithoutFailure("cancelled");
                            },
                            onFailureBeforeRelease: () => {
                                settledResult = consumeWithoutFailure("failed");
                            },
                            onResultBeforeRelease: (value) => {
                                if (value.status !== "verified-work") return;
                                const admitted = admission;
                                if (admitted === undefined) {
                                    settledResult = { status: "state-changed" };
                                    return;
                                }
                                settledResult =
                                    value.verification.status === "verified"
                                        ? settleVerified(
                                              admitted,
                                              value.verification.verification,
                                              now()
                                          )
                                        : settleInvalidProof(admitted, now());
                            },
                            signal: metadata.signal,
                            timeoutMs: webAuthnVerificationTimeoutMs,
                        }
                    );
                if (workValue.status === "skipped") return workValue.result;
                return settledResult ?? { status: "state-changed" };
            } catch (error) {
                if (error instanceof AuthenticationWorkCapacityError) {
                    return {
                        retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                        status: "rate-limited",
                    };
                }
                if (
                    error instanceof AuthenticationWorkTimeoutError ||
                    error instanceof AuthenticationUpstreamUnavailableError
                ) {
                    return settledResult ?? { status: "service-unavailable" };
                }
                throw error;
            }
        },
    });
}
