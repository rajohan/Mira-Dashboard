import { possessionFactorMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
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
import {
    accountMfaRateLimitTargets,
    activeAccount,
    enrollmentIsRecentlyAuthorized,
} from "./accountLifecycleState.ts";
import type {
    ConfirmWebAuthnEnrollmentResult,
    MfaAccountLifecycleService,
} from "./accountLifecycleTypes.ts";
import {
    createAccountWebAuthnEnrollmentSettlement,
    type AccountWebAuthnRegistrationAdmission,
    type StagedFirstWebAuthnCredential,
} from "./accountWebAuthnEnrollmentSettlement.ts";
import {
    possessionFactorCount,
    possessionFactorSnapshotIsConsistent,
    possessionFactorSnapshotMatches,
    possessionFactorStateMatchesAccount,
    readAccountPossessionFactorSnapshot,
    sessionWebAuthnChallengeIsCurrent,
    webAuthnChallengeSnapshotMatches,
} from "./accountWebAuthnState.ts";
import type {
    VerifiedWebAuthnRegistration,
    WebAuthnVerificationResult,
} from "./webauthn/adapter.ts";

type ConfirmWebAuthnEnrollmentOperation = Pick<
    MfaAccountLifecycleService,
    "confirmWebAuthnEnrollment"
>;

type ConfirmWebAuthnEnrollmentPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateId"
    | "generateSessionToken"
    | "now"
    | "prepareRecoveryCodeSet"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "webAuthnAdapter"
    | "webAuthnRelyingParty"
    | "webAuthnVerificationTimeoutMs"
    | "webAuthnWorkBudget"
    | "webAuthnWorkRuntime"
>;

type RegistrationVerification = WebAuthnVerificationResult<VerifiedWebAuthnRegistration>;

type RegistrationWorkValue =
    | {
          readonly result: ConfirmWebAuthnEnrollmentResult;
          readonly status: "skipped";
      }
    | {
          readonly status: "verified-work";
          readonly verification: RegistrationVerification;
      };

/**
 * Confirms one registration under the Effect verification gate. First-factor recovery
 * hashing happens only after the verified challenge has been durably consumed.
 * @returns The focused WebAuthn enrollment-confirmation operation.
 */
export function createConfirmWebAuthnEnrollmentOperation(
    context: ConfirmWebAuthnEnrollmentPort
): ConfirmWebAuthnEnrollmentOperation {
    const {
        now,
        prepareRecoveryCodeSet,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
        webAuthnAdapter,
        webAuthnRelyingParty,
        webAuthnVerificationTimeoutMs,
        webAuthnWorkBudget,
        webAuthnWorkRuntime,
    } = context;

    return Object.freeze({
        async confirmWebAuthnEnrollment(identity, input, metadata) {
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
                if (
                    !enrollmentIsRecentlyAuthorized(
                        account,
                        checkedAt,
                        recentAuthenticationWindowMs
                    )
                ) {
                    return { status: "step-up-required" as const };
                }
                const challenge = reader.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                );
                if (
                    !sessionWebAuthnChallengeIsCurrent(
                        challenge,
                        account,
                        "registration",
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
                if (
                    !possessionFactorSnapshotIsConsistent(factors) ||
                    !possessionFactorStateMatchesAccount(account, factors)
                ) {
                    return { status: "service-unavailable" as const };
                }
                if (possessionFactorCount(factors) >= possessionFactorMaximumPerUser) {
                    return { status: "factor-limit" as const };
                }
                return { account, challenge, factors, status: "ready" as const };
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

            let admission: AccountWebAuthnRegistrationAdmission | undefined;
            let settledResult: ConfirmWebAuthnEnrollmentResult | undefined;
            let stagedFirstCredential: StagedFirstWebAuthnCredential | undefined;
            const settlement = createAccountWebAuthnEnrollmentSettlement(
                context,
                webAuthnRelyingParty,
                identity,
                input,
                metadata
            );
            const consumeWithoutProofFailure = async (
                outcome: "cancelled" | "failed"
            ): Promise<ConfirmWebAuthnEnrollmentResult | undefined> => {
                const admitted = admission;
                return admitted === undefined
                    ? undefined
                    : await settlement.consumeWithoutProofFailure(admitted, outcome);
            };

            try {
                const workValue =
                    await webAuthnWorkRuntime.runWebAuthnVerification<RegistrationWorkValue>(
                        async (signal) => {
                            const admitted = admission;
                            if (admitted === undefined) {
                                throw new Error(
                                    "WebAuthn enrollment admission is missing"
                                );
                            }
                            signal.throwIfAborted();
                            const verification = await webAuthnAdapter.verifyRegistration(
                                {
                                    expectedChallenge: admitted.challenge.challenge,
                                    response: input.response,
                                }
                            );
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
                                        if (
                                            !enrollmentIsRecentlyAuthorized(
                                                account,
                                                admittedAt,
                                                recentAuthenticationWindowMs
                                            )
                                        ) {
                                            return {
                                                result: {
                                                    status: "step-up-required",
                                                } as const,
                                                status: "skipped" as const,
                                            };
                                        }
                                        const challenge =
                                            reader.findSessionWebAuthnChallenge(
                                                identity.sessionId,
                                                "registration"
                                            );
                                        if (
                                            !sessionWebAuthnChallengeIsCurrent(
                                                challenge,
                                                account,
                                                "registration",
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
                                        if (
                                            possessionFactorCount(snapshot.factors) >=
                                            possessionFactorMaximumPerUser
                                        ) {
                                            return {
                                                result: {
                                                    status: "factor-limit",
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
                                        };
                                        return { status: "proceed" as const };
                                    }
                                );
                                return decision.status === "proceed"
                                    ? { proceed: true }
                                    : { proceed: false, value: decision };
                            },
                            onCancellationBeforeRelease: async () => {
                                await consumeWithoutProofFailure("cancelled");
                            },
                            onFailureBeforeRelease: async () => {
                                settledResult =
                                    await consumeWithoutProofFailure("failed");
                            },
                            onResultBeforeRelease: async (value) => {
                                if (value.status !== "verified-work") return;
                                const admitted = admission;
                                if (admitted === undefined) {
                                    settledResult = { status: "state-changed" };
                                    return;
                                }
                                if (value.verification.status === "verified") {
                                    const verifiedSettlement =
                                        await settlement.settleVerifiedRegistration(
                                            admitted,
                                            value.verification.verification,
                                            now()
                                        );
                                    if (verifiedSettlement.kind === "staged") {
                                        stagedFirstCredential = verifiedSettlement.staged;
                                    } else {
                                        settledResult = verifiedSettlement.result;
                                    }
                                } else {
                                    settledResult =
                                        await settlement.recordInvalidRegistration(
                                            admitted,
                                            now()
                                        );
                                }
                            },
                            signal: metadata.signal,
                            timeoutMs: webAuthnVerificationTimeoutMs,
                        }
                    );
                if (workValue.status === "skipped") return workValue.result;
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

            if (settledResult !== undefined) return settledResult;
            const staged = stagedFirstCredential;
            if (staged === undefined) return { status: "state-changed" };
            metadata.signal?.throwIfAborted();
            const prepared = await prepareRecoveryCodeSet(
                identity.userId,
                metadata.signal
            );
            if ("status" in prepared) return prepared;
            metadata.signal?.throwIfAborted();
            const confirmedAt = now();
            return await settlement.activateFirstCredential(
                staged,
                prepared,
                confirmedAt
            );
        },
    });
}
