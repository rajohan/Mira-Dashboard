import { compareAsc } from "date-fns";

import { webAuthnCredentialMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import {
    activeRateLimitForTargets,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import {
    AuthenticationUpstreamUnavailableError,
    type AuthenticationVerificationWorkStartDecision,
    AuthenticationWorkCapacityError,
    AuthenticationWorkTimeoutError,
} from "../authenticationWorkGate.ts";
import type {
    MfaLifecycleReader,
    MfaLifecycleUnitOfWork,
    MfaWebAuthnChallengeRecord,
    MfaWebAuthnCredentialRecord,
} from "./lifecycleRepositoryTypes.ts";
import type { MfaLoginCoordinator } from "./loginCoordinator.ts";
import {
    mfaLoginRateLimitTargets,
    type MfaLoginLifecycleContext,
} from "./loginLifecycleContext.ts";
import type {
    CompleteMfaLoginResult,
    MfaLoginLifecycleService,
} from "./loginLifecycleTypes.ts";
import {
    resolvePendingLogin,
    type ResolvedPendingLogin,
} from "./loginPendingLifecycle.ts";
import type {
    VerifiedWebAuthnAuthentication,
    WebAuthnVerificationResult,
} from "./webauthn/adapter.ts";
import {
    webAuthnCredentialSnapshotMatches,
    webAuthnStoredCredential,
} from "./webauthn/credentialState.ts";
import { createWebAuthnUserHandle } from "./webauthn/relyingPartyConfiguration.ts";

type WebAuthnLoginProofOperation = Pick<
    MfaLoginLifecycleService,
    "completeWebAuthnLogin"
>;

type WebAuthnLoginProofPort = Pick<
    MfaLoginLifecycleContext,
    "now" | "repository" | "webAuthn"
>;

interface WebAuthnLoginSnapshot {
    readonly challenge?: MfaWebAuthnChallengeRecord;
    readonly credential?: MfaWebAuthnCredentialRecord;
    readonly fallbackCredential?: MfaWebAuthnCredentialRecord;
    readonly resolved?: ResolvedPendingLogin;
}

const webAuthnCredentialReadMaximum = webAuthnCredentialMaximumPerUser + 1;

type WebAuthnLoginWorkResult =
    | {
          readonly kind: "blocked";
          readonly result: CompleteMfaLoginResult;
      }
    | {
          readonly kind: "verification";
          readonly result: WebAuthnVerificationResult<VerifiedWebAuthnAuthentication>;
      };

function fallbackCredential(
    credential: MfaWebAuthnCredentialRecord,
    responseCredentialId: string
) {
    return Object.freeze({
        ...webAuthnStoredCredential(credential),
        id: responseCredentialId,
    });
}

function readLoginSnapshot(
    reader: MfaLifecycleReader,
    pendingCredential: Parameters<typeof resolvePendingLogin>[1],
    credentialId: string,
    checkedAt: Date,
    rpId?: string
): WebAuthnLoginSnapshot {
    const resolved = resolvePendingLogin(reader, pendingCredential, checkedAt);
    if (resolved === undefined) return {};
    const credentials = reader.listWebAuthnCredentials(
        resolved.user.id,
        webAuthnCredentialReadMaximum
    );
    const fallback =
        credentials.length > webAuthnCredentialMaximumPerUser || rpId === undefined
            ? undefined
            : credentials.find((candidate) => candidate.rpId === rpId);
    const selected = reader.findWebAuthnCredential(resolved.user.id, credentialId);
    return {
        challenge: reader.findPendingLoginWebAuthnChallenge(resolved.pending.id),
        ...(selected?.rpId === rpId ? { credential: selected } : {}),
        ...(fallback === undefined ? {} : { fallbackCredential: fallback }),
        resolved,
    };
}

function challengeBindingIsValid(
    challenge: MfaWebAuthnChallengeRecord,
    resolved: ResolvedPendingLogin,
    checkedAt: Date
): boolean {
    return (
        challenge.purpose === "login" &&
        challenge.pendingLoginId === resolved.pending.id &&
        challenge.sessionId === null &&
        challenge.authenticationVersion === resolved.pending.authenticationVersion &&
        compareAsc(challenge.createdAt, checkedAt) <= 0 &&
        compareAsc(challenge.expiresAt, checkedAt) > 0
    );
}

function sameChallenge(
    current: MfaWebAuthnChallengeRecord | undefined,
    expected: MfaWebAuthnChallengeRecord
): current is MfaWebAuthnChallengeRecord {
    return (
        current !== undefined &&
        current.id === expected.id &&
        current.authenticationVersion === expected.authenticationVersion &&
        current.challenge === expected.challenge &&
        current.configFingerprint === expected.configFingerprint &&
        current.createdAt.getTime() === expected.createdAt.getTime() &&
        current.expiresAt.getTime() === expected.expiresAt.getTime() &&
        current.pendingLoginId === expected.pendingLoginId &&
        current.purpose === expected.purpose &&
        current.sessionId === expected.sessionId
    );
}

function sameOptionalCredential(
    current: MfaWebAuthnCredentialRecord | undefined,
    expected: MfaWebAuthnCredentialRecord | undefined
): boolean {
    return expected === undefined
        ? current === undefined
        : webAuthnCredentialSnapshotMatches(current, expected);
}

function consumeChallenge(
    unit: MfaLifecycleUnitOfWork,
    challenge: MfaWebAuthnChallengeRecord,
    checkedAt: Date
): boolean {
    return (
        unit.consumeWebAuthnChallenge({
            authenticationVersion: challenge.authenticationVersion,
            challenge: challenge.challenge,
            checkedAt,
            configFingerprint: challenge.configFingerprint,
            createdAt: challenge.createdAt,
            expiresAt: challenge.expiresAt,
            id: challenge.id,
            pendingLoginId: challenge.pendingLoginId,
            purpose: challenge.purpose,
            sessionId: challenge.sessionId,
        }) !== undefined
    );
}

function verifiedCredentialTransitionIsValid(
    credential: MfaWebAuthnCredentialRecord,
    verification: VerifiedWebAuthnAuthentication
): boolean {
    const counterIsValid =
        (credential.counter === 0 && verification.newCounter === 0) ||
        verification.newCounter > credential.counter;
    return (
        verification.credentialId === credential.credentialId &&
        counterIsValid &&
        !(
            verification.credentialDeviceType === "singleDevice" &&
            verification.credentialBackedUp
        )
    );
}

/**
 * Creates the bounded assertion-verification and atomic login settlement operation.
 * @returns Frozen WebAuthn proof-completion operation.
 */
export function createWebAuthnLoginProofOperation(
    context: WebAuthnLoginProofPort,
    coordinator: MfaLoginCoordinator
): WebAuthnLoginProofOperation {
    const { now, repository } = context;

    return Object.freeze({
        async completeWebAuthnLogin(pendingCredential, input, metadata) {
            metadata.signal?.throwIfAborted();
            const checkedAt = now();
            const targets = mfaLoginRateLimitTargets(metadata.clientSourceId);
            const activeLimit = activeRateLimitForTargets(repository, targets, checkedAt);
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" };
            }
            const webAuthn = context.webAuthn;
            const snapshot = repository.withReadTransaction((reader) =>
                readLoginSnapshot(
                    reader,
                    pendingCredential,
                    input.response.id,
                    checkedAt,
                    webAuthn?.relyingParty.rpId
                )
            );
            if (snapshot.resolved === undefined) {
                metadata.signal?.throwIfAborted();
                return coordinator.recordFailure(
                    undefined,
                    pendingCredential,
                    metadata,
                    checkedAt,
                    "webauthn_pending_invalid"
                );
            }
            const resolved = snapshot.resolved;
            if (!resolved.pending.allowsWebAuthn || snapshot.challenge === undefined) {
                metadata.signal?.throwIfAborted();
                return coordinator.recordFailure(
                    resolved,
                    pendingCredential,
                    metadata,
                    checkedAt,
                    "webauthn_pending_invalid"
                );
            }
            const challenge = snapshot.challenge;
            if (!challengeBindingIsValid(challenge, resolved, checkedAt)) {
                metadata.signal?.throwIfAborted();
                return coordinator.recordFailure(
                    resolved,
                    pendingCredential,
                    metadata,
                    checkedAt,
                    "webauthn_pending_invalid"
                );
            }

            if (
                webAuthn === undefined ||
                challenge.configFingerprint !== webAuthn.relyingParty.fingerprint ||
                snapshot.fallbackCredential === undefined
            ) {
                metadata.signal?.throwIfAborted();
                return coordinator.recordWebAuthnUnavailable(
                    resolved,
                    metadata,
                    checkedAt,
                    (unit) => consumeChallenge(unit, challenge, checkedAt),
                    "webauthn_configuration_mismatch"
                );
            }

            const knownCredential = snapshot.credential;
            const credentialWasKnown = knownCredential !== undefined;
            const storedCredential = credentialWasKnown
                ? webAuthnStoredCredential(knownCredential)
                : fallbackCredential(snapshot.fallbackCredential, input.response.id);
            const expectedUserHandle = createWebAuthnUserHandle(resolved.user.id);
            let attemptedAt: Date | undefined;
            let settledResult: CompleteMfaLoginResult | undefined;

            const settleInvalidProof = (failedAt: Date): CompleteMfaLoginResult =>
                coordinator.recordWebAuthnFailure(
                    resolved,
                    pendingCredential,
                    metadata,
                    failedAt,
                    (unit) => consumeChallenge(unit, challenge, attemptedAt ?? checkedAt),
                    attemptedAt ?? checkedAt
                );
            const settleUnavailable = (failedAt: Date): CompleteMfaLoginResult =>
                coordinator.recordWebAuthnUnavailable(
                    resolved,
                    metadata,
                    failedAt,
                    (unit) => consumeChallenge(unit, challenge, attemptedAt ?? checkedAt)
                );

            try {
                const workResult = await webAuthn.workRuntime.runWebAuthnVerification(
                    async (verificationSignal) => {
                        verificationSignal.throwIfAborted();
                        const result = await webAuthn.adapter.verifyAuthentication({
                            credential: storedCredential,
                            expectedChallenge: challenge.challenge,
                            expectedUserHandle,
                            response: input.response,
                        });
                        verificationSignal.throwIfAborted();
                        return { kind: "verification", result } as const;
                    },
                    {
                        onBeforeStart:
                            (): AuthenticationVerificationWorkStartDecision<WebAuthnLoginWorkResult> => {
                                const admittedAt = now();
                                const admittedLimit = activeRateLimitForTargets(
                                    repository,
                                    targets,
                                    admittedAt
                                );
                                if (admittedLimit !== undefined) {
                                    return {
                                        proceed: false,
                                        value: {
                                            kind: "blocked",
                                            result: {
                                                ...admittedLimit,
                                                status: "rate-limited",
                                            },
                                        },
                                    };
                                }
                                const current = repository.withReadTransaction((reader) =>
                                    readLoginSnapshot(
                                        reader,
                                        pendingCredential,
                                        input.response.id,
                                        admittedAt,
                                        webAuthn.relyingParty.rpId
                                    )
                                );
                                if (current.resolved === undefined) {
                                    return {
                                        proceed: false,
                                        value: {
                                            kind: "blocked",
                                            result: { status: "state-changed" },
                                        },
                                    };
                                }
                                if (
                                    !current.resolved.pending.allowsWebAuthn ||
                                    !sameChallenge(current.challenge, challenge) ||
                                    !challengeBindingIsValid(
                                        challenge,
                                        current.resolved,
                                        admittedAt
                                    ) ||
                                    !sameOptionalCredential(
                                        current.credential,
                                        snapshot.credential
                                    ) ||
                                    !sameOptionalCredential(
                                        current.fallbackCredential,
                                        snapshot.fallbackCredential
                                    )
                                ) {
                                    return {
                                        proceed: false,
                                        value: {
                                            kind: "blocked",
                                            result: { status: "state-changed" },
                                        },
                                    };
                                }
                                const budget = webAuthn.workBudget.consume();
                                if (!budget.accepted) {
                                    return {
                                        proceed: false,
                                        value: {
                                            kind: "blocked",
                                            result: {
                                                retryAfterSeconds:
                                                    budget.retryAfterSeconds,
                                                status: "rate-limited",
                                            },
                                        },
                                    };
                                }
                                attemptedAt = admittedAt;
                                return { proceed: true };
                            },
                        onCancellationBeforeRelease: () => {
                            coordinator.recordWebAuthnCancellation(
                                resolved,
                                metadata,
                                now(),
                                (unit) =>
                                    consumeChallenge(
                                        unit,
                                        challenge,
                                        attemptedAt ?? checkedAt
                                    )
                            );
                        },
                        onFailureBeforeRelease: () => {
                            if (attemptedAt !== undefined) {
                                settledResult = settleUnavailable(now());
                            }
                        },
                        onResultBeforeRelease: (result: WebAuthnLoginWorkResult) => {
                            if (result.kind !== "verification") return;
                            const verification = result.result;
                            if (
                                verification.status !== "verified" ||
                                !credentialWasKnown ||
                                knownCredential === undefined ||
                                !verifiedCredentialTransitionIsValid(
                                    knownCredential,
                                    verification.verification
                                )
                            ) {
                                settledResult = settleInvalidProof(now());
                                return;
                            }
                            const completedAt = now();
                            if (compareAsc(completedAt, challenge.expiresAt) >= 0) {
                                settledResult = settleInvalidProof(completedAt);
                                return;
                            }
                            settledResult = coordinator.finishLogin(
                                resolved,
                                pendingCredential,
                                "webauthn",
                                completedAt,
                                metadata,
                                (unit) => {
                                    const challengeConsumed = consumeChallenge(
                                        unit,
                                        challenge,
                                        attemptedAt ?? checkedAt
                                    );
                                    if (!challengeConsumed) return false;
                                    const credentialAdvanced =
                                        unit.advanceWebAuthnCredential({
                                            backedUp:
                                                verification.verification
                                                    .credentialBackedUp,
                                            counter: verification.verification.newCounter,
                                            credentialId: knownCredential.credentialId,
                                            deviceType:
                                                verification.verification
                                                    .credentialDeviceType,
                                            expectedBackedUp: knownCredential.backedUp,
                                            expectedCounter: knownCredential.counter,
                                            expectedCreatedAt: knownCredential.createdAt,
                                            expectedDeviceType:
                                                knownCredential.deviceType,
                                            expectedLastUsedAt:
                                                knownCredential.lastUsedAt,
                                            expectedPublicKey: knownCredential.publicKey,
                                            expectedRpId: knownCredential.rpId,
                                            id: knownCredential.id,
                                            usedAt: completedAt,
                                            userId: resolved.user.id,
                                        }) !== undefined;
                                    return credentialAdvanced
                                        ? true
                                        : "state-changed-after-consumption";
                                }
                            );
                        },
                        signal: metadata.signal,
                        timeoutMs: webAuthn.verificationTimeoutMs,
                    }
                );
                if (workResult.kind === "blocked") return workResult.result;
                if (settledResult === undefined) {
                    throw new Error("WebAuthn login verification was not settled");
                }
                return settledResult;
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
                    if (settledResult === undefined) {
                        if (attemptedAt === undefined) {
                            return { status: "service-unavailable" };
                        }
                        throw new Error(
                            "WebAuthn login failure was not durably settled",
                            { cause: error }
                        );
                    }
                    return settledResult;
                }
                throw error;
            }
        },
    });
}
