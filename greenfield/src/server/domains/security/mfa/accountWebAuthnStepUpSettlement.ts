import { compareAsc, getTime } from "date-fns";

import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
} from "../authenticationRateLimit.ts";
import {
    authSession,
    sessionActor,
    type AuthenticatedBrowserIdentity,
    type AuthenticationRequestMetadata,
} from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountMfaRateLimitTargets,
    accountStateError,
    clearRateLimits,
    type AccountSnapshot,
} from "./accountLifecycleState.ts";
import type { WebAuthnStepUpResult } from "./accountLifecycleTypes.ts";
import {
    activeAccountMatchesSnapshot,
    consumeWebAuthnChallengeSnapshot,
    possessionFactorSnapshotMatches,
    webAuthnChallengeSnapshotMatches,
    type AccountPossessionFactorSnapshot,
} from "./accountWebAuthnState.ts";
import type {
    MfaWebAuthnChallengeRecord,
    MfaWebAuthnCredentialRecord,
} from "./lifecycleRepositoryTypes.ts";
import type { VerifiedWebAuthnAuthentication } from "./webauthn/adapter.ts";
import { webAuthnCredentialSnapshotMatches } from "./webauthn/credentialState.ts";

type AccountWebAuthnStepUpSettlementPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
>;

export interface AccountWebAuthnStepUpAdmission {
    readonly account: AccountSnapshot;
    readonly admittedAt: Date;
    readonly challenge: MfaWebAuthnChallengeRecord;
    readonly factors: AccountPossessionFactorSnapshot;
    readonly fallbackCredential: MfaWebAuthnCredentialRecord;
    readonly selectedCredential: MfaWebAuthnCredentialRecord | undefined;
}

export interface AccountWebAuthnStepUpSettlement {
    readonly consumeWithoutFailure: (
        admission: AccountWebAuthnStepUpAdmission,
        outcome: "cancelled" | "failed"
    ) => WebAuthnStepUpResult | undefined;
    readonly settleInvalidProof: (
        admission: AccountWebAuthnStepUpAdmission,
        failedAt: Date
    ) => WebAuthnStepUpResult;
    readonly settleVerified: (
        admission: AccountWebAuthnStepUpAdmission,
        verification: VerifiedWebAuthnAuthentication,
        verifiedAt: Date
    ) => WebAuthnStepUpResult;
}

/**
 * Owns the atomic challenge, credential, rate-limit, and session settlement paths.
 * @returns Settlement functions bound to one step-up request.
 */
export function createAccountWebAuthnStepUpSettlement(
    context: AccountWebAuthnStepUpSettlementPort,
    identity: AuthenticatedBrowserIdentity,
    metadata: AuthenticationRequestMetadata
): AccountWebAuthnStepUpSettlement {
    const {
        audit,
        generateSessionToken,
        now,
        repository,
        rotateSession,
        sessionIdleDurationMs,
    } = context;
    const rateLimitTargets = accountMfaRateLimitTargets(identity.userId);

    const consumeWithoutFailure = (
        admitted: AccountWebAuthnStepUpAdmission,
        outcome: "cancelled" | "failed"
    ): WebAuthnStepUpResult | undefined => {
        const occurredAt = now();
        try {
            return repository.withImmediateTransaction((unit) => {
                const current = activeAccountMatchesSnapshot(
                    unit,
                    identity,
                    admitted.account,
                    occurredAt,
                    sessionIdleDurationMs
                );
                const challenge = unit.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "step-up"
                );
                if (
                    current === undefined ||
                    !webAuthnChallengeSnapshotMatches(challenge, admitted.challenge)
                ) {
                    return outcome === "failed"
                        ? ({ status: "state-changed" } as const)
                        : undefined;
                }
                if (
                    !consumeWebAuthnChallengeSnapshot(
                        unit,
                        admitted.challenge,
                        admitted.admittedAt
                    )
                ) {
                    return outcome === "failed"
                        ? ({ status: "state-changed" } as const)
                        : undefined;
                }
                audit(unit, {
                    action: "auth.mfa.step-up",
                    actor: sessionActor(identity),
                    metadata: { method: "webauthn" },
                    occurredAt,
                    outcome,
                    requestId: metadata.requestId,
                    targetId: admitted.challenge.id,
                    targetType: "auth_challenge",
                });
                return outcome === "failed"
                    ? ({ status: "service-unavailable" } as const)
                    : undefined;
            });
        } catch (error) {
            const mapped = accountStateError(error);
            return outcome === "failed" ? mapped : undefined;
        }
    };

    const settleInvalidProof = (
        admitted: AccountWebAuthnStepUpAdmission,
        failedAt: Date
    ): WebAuthnStepUpResult => {
        try {
            return repository.withImmediateTransaction((unit) => {
                const challenge = unit.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "step-up"
                );
                if (
                    !webAuthnChallengeSnapshotMatches(challenge, admitted.challenge) ||
                    !consumeWebAuthnChallengeSnapshot(
                        unit,
                        admitted.challenge,
                        admitted.admittedAt
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                const current = activeAccountMatchesSnapshot(
                    unit,
                    identity,
                    admitted.account,
                    failedAt,
                    sessionIdleDurationMs
                );
                if (current === undefined) return { status: "session-changed" as const };
                if (current.user.mfaEnabledAt === null) {
                    return { status: "mfa-enrollment-required" as const };
                }
                if (
                    !possessionFactorSnapshotMatches(
                        unit,
                        identity.userId,
                        admitted.factors
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                const activeLimit = activeRateLimitForTargets(
                    unit,
                    rateLimitTargets,
                    failedAt
                );
                if (activeLimit !== undefined) {
                    audit(unit, {
                        action: "auth.mfa.step-up",
                        actor: sessionActor(identity),
                        metadata: {
                            method: "webauthn",
                            reason: "webauthn_invalid",
                        },
                        occurredAt: failedAt,
                        outcome: "denied",
                        requestId: metadata.requestId,
                        targetId: identity.userId,
                        targetType: "user",
                    });
                    return { ...activeLimit, status: "rate-limited" as const };
                }
                const failure = recordAuthenticationFailures(
                    unit,
                    rateLimitTargets,
                    failedAt
                );
                audit(unit, {
                    action: "auth.mfa.step-up",
                    actor: sessionActor(identity),
                    metadata: {
                        method: "webauthn",
                        reason: "webauthn_invalid",
                    },
                    occurredAt: failedAt,
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
    };

    const settleVerified = (
        admitted: AccountWebAuthnStepUpAdmission,
        verification: VerifiedWebAuthnAuthentication,
        verifiedAt: Date
    ): WebAuthnStepUpResult => {
        if (
            admitted.selectedCredential === undefined ||
            verification.credentialId !== admitted.selectedCredential.credentialId
        ) {
            return settleInvalidProof(admitted, verifiedAt);
        }
        const selectedCredential = admitted.selectedCredential;
        const sessionToken = generateSessionToken();
        try {
            return repository.withImmediateTransaction((unit) => {
                const challenge = unit.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "step-up"
                );
                if (
                    !webAuthnChallengeSnapshotMatches(challenge, admitted.challenge) ||
                    !consumeWebAuthnChallengeSnapshot(
                        unit,
                        admitted.challenge,
                        admitted.admittedAt
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                const current = activeAccountMatchesSnapshot(
                    unit,
                    identity,
                    admitted.account,
                    verifiedAt,
                    sessionIdleDurationMs
                );
                if (current === undefined) return { status: "session-changed" as const };
                if (current.user.mfaEnabledAt === null) {
                    return { status: "mfa-enrollment-required" as const };
                }
                if (compareAsc(admitted.challenge.expiresAt, verifiedAt) <= 0) {
                    audit(unit, {
                        action: "auth.mfa.step-up",
                        actor: sessionActor(identity),
                        metadata: { method: "webauthn" },
                        occurredAt: verifiedAt,
                        outcome: "failed",
                        requestId: metadata.requestId,
                        targetId: admitted.challenge.id,
                        targetType: "auth_challenge",
                    });
                    return { status: "service-unavailable" as const };
                }
                if (
                    !possessionFactorSnapshotMatches(
                        unit,
                        identity.userId,
                        admitted.factors
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                const credential = unit.findWebAuthnCredentialById(
                    identity.userId,
                    selectedCredential.id
                );
                if (!webAuthnCredentialSnapshotMatches(credential, selectedCredential)) {
                    return { status: "state-changed" as const };
                }
                const advanced = unit.advanceWebAuthnCredential({
                    backedUp: verification.credentialBackedUp,
                    counter: verification.newCounter,
                    credentialId: credential.credentialId,
                    deviceType: verification.credentialDeviceType,
                    expectedBackedUp: credential.backedUp,
                    expectedCounter: credential.counter,
                    expectedCreatedAt: credential.createdAt,
                    expectedDeviceType: credential.deviceType,
                    expectedLastUsedAt: credential.lastUsedAt,
                    expectedPublicKey: credential.publicKey,
                    expectedRpId: credential.rpId,
                    id: credential.id,
                    usedAt: verifiedAt,
                    userId: identity.userId,
                });
                if (advanced === undefined) return { status: "state-changed" as const };
                const rotated = rotateSession(unit, current, current.user, sessionToken, {
                    authenticationMethod: "webauthn",
                    createdAt: verifiedAt,
                    mfaVerifiedAt: verifiedAt,
                    passwordVerifiedAt: current.session.passwordVerifiedAt,
                    userAgent: metadata.userAgent,
                });
                clearRateLimits(unit, rateLimitTargets);
                audit(unit, {
                    action: "auth.mfa.step-up",
                    actor: sessionActor(identity),
                    metadata: { method: "webauthn" },
                    occurredAt: verifiedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: rotated.record.id,
                    targetType: "auth_session",
                });
                return {
                    method: "webauthn" as const,
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

    return Object.freeze({ consumeWithoutFailure, settleInvalidProof, settleVerified });
}
