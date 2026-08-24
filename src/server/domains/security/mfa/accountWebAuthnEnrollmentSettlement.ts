import { compareAsc } from "date-fns";

import {
    possessionFactorMaximumPerUser,
    type ConfirmWebAuthnEnrollmentInput,
} from "../../../../contracts/accountSecurity.ts";
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
import type { PreparedRecoveryCodeSet } from "./accountLifecycleCrypto.ts";
import {
    accountMfaRateLimitTargets,
    accountStateError,
    clearRateLimits,
    currentAccount,
    enrollmentIsRecentlyAuthorized,
    MfaAccountStateChangedError,
    type AccountSnapshot,
} from "./accountLifecycleState.ts";
import type { ConfirmWebAuthnEnrollmentResult } from "./accountLifecycleTypes.ts";
import {
    activeAccountMatchesSnapshot,
    consumeWebAuthnChallengeSnapshot,
    defaultWebAuthnCredentialLabel,
    possessionFactorCount,
    possessionFactorSnapshotMatches,
    webAuthnChallengeSnapshotMatches,
    type AccountPossessionFactorSnapshot,
} from "./accountWebAuthnState.ts";
import type {
    MfaLifecycleUnitOfWork,
    MfaWebAuthnChallengeRecord,
    MfaWebAuthnCredentialInsert,
} from "./lifecycleRepositoryTypes.ts";
import type { VerifiedWebAuthnRegistration } from "./webauthn/adapter.ts";
import {
    webAuthnCredentialSummary,
    webAuthnTransportMask,
} from "./webauthn/credentialState.ts";
import type { WebAuthnRelyingPartyConfiguration } from "./webauthn/relyingPartyConfiguration.ts";

type AccountWebAuthnEnrollmentSettlementPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateId"
    | "generateSessionToken"
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
>;

export interface AccountWebAuthnRegistrationAdmission {
    readonly account: AccountSnapshot;
    readonly admittedAt: Date;
    readonly challenge: MfaWebAuthnChallengeRecord;
    readonly factors: AccountPossessionFactorSnapshot;
}

export interface StagedFirstWebAuthnCredential {
    readonly admission: AccountWebAuthnRegistrationAdmission;
    readonly credential: MfaWebAuthnCredentialInsert;
}

export type VerifiedWebAuthnEnrollmentSettlement =
    | {
          readonly kind: "result";
          readonly result: ConfirmWebAuthnEnrollmentResult;
      }
    | {
          readonly kind: "staged";
          readonly staged: StagedFirstWebAuthnCredential;
      };

export interface AccountWebAuthnEnrollmentSettlement {
    readonly activateFirstCredential: (
        staged: StagedFirstWebAuthnCredential,
        prepared: PreparedRecoveryCodeSet,
        confirmedAt: Date
    ) => Promise<ConfirmWebAuthnEnrollmentResult>;
    readonly consumeWithoutProofFailure: (
        admission: AccountWebAuthnRegistrationAdmission,
        outcome: "cancelled" | "failed"
    ) => Promise<ConfirmWebAuthnEnrollmentResult | undefined>;
    readonly recordInvalidRegistration: (
        admission: AccountWebAuthnRegistrationAdmission,
        failedAt: Date
    ) => Promise<ConfirmWebAuthnEnrollmentResult>;
    readonly settleVerifiedRegistration: (
        admission: AccountWebAuthnRegistrationAdmission,
        verification: VerifiedWebAuthnRegistration,
        verifiedAt: Date
    ) => Promise<VerifiedWebAuthnEnrollmentSettlement>;
}

function credentialInsert(
    generateId: () => string,
    input: ConfirmWebAuthnEnrollmentInput,
    verification: VerifiedWebAuthnRegistration,
    userId: string,
    rpId: string,
    createdAt: Date
): MfaWebAuthnCredentialInsert {
    return {
        algorithm: verification.credential.algorithm,
        backedUp: verification.credentialBackedUp,
        counter: verification.credential.counter,
        createdAt,
        credentialId: verification.credential.id,
        deviceType: verification.credentialDeviceType,
        id: generateId(),
        label: input.label ?? defaultWebAuthnCredentialLabel,
        lastUsedAt: null,
        publicKey: Buffer.from(verification.credential.publicKey),
        rpId,
        transportMask: webAuthnTransportMask(verification.credential.transports),
        userId,
    };
}

/**
 * Owns all atomic enrollment challenge, factor, recovery, and session settlements.
 * @returns Settlement functions bound to one enrollment request.
 */
export function createAccountWebAuthnEnrollmentSettlement(
    context: AccountWebAuthnEnrollmentSettlementPort,
    relyingParty: WebAuthnRelyingPartyConfiguration,
    identity: AuthenticatedBrowserIdentity,
    input: ConfirmWebAuthnEnrollmentInput,
    metadata: AuthenticationRequestMetadata
): AccountWebAuthnEnrollmentSettlement {
    const {
        audit,
        generateId,
        generateSessionToken,
        now,
        recentAuthenticationWindowMs,
        repository,
        rotateSession,
        sessionIdleDurationMs,
    } = context;
    const rateLimitTargets = accountMfaRateLimitTargets(identity.userId);

    const auditInvalid = (unit: MfaLifecycleUnitOfWork, occurredAt: Date): void => {
        audit(unit, {
            action: "auth.mfa.webauthn.enrollment.confirm",
            actor: sessionActor(identity),
            metadata: { method: "webauthn", reason: "webauthn_invalid" },
            occurredAt,
            outcome: "denied",
            requestId: metadata.requestId,
            targetId: identity.userId,
            targetType: "user",
        });
    };

    const recordFailure = (
        unit: MfaLifecycleUnitOfWork,
        failedAt: Date
    ): ConfirmWebAuthnEnrollmentResult => {
        const activeLimit = activeRateLimitForTargets(unit, rateLimitTargets, failedAt);
        const failure =
            activeLimit ?? recordAuthenticationFailures(unit, rateLimitTargets, failedAt);
        auditInvalid(unit, failedAt);
        return failure.retryAfterSeconds === undefined
            ? ({ status: "invalid-proof" } as const)
            : ({
                  retryAfterSeconds: failure.retryAfterSeconds,
                  status: "rate-limited",
              } as const);
    };

    const recordInvalidRegistration = async (
        admission: AccountWebAuthnRegistrationAdmission,
        failedAt: Date
    ): Promise<ConfirmWebAuthnEnrollmentResult> => {
        try {
            return await repository.withImmediateTransaction((unit) => {
                const challenge = unit.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                );
                if (
                    !webAuthnChallengeSnapshotMatches(challenge, admission.challenge) ||
                    !consumeWebAuthnChallengeSnapshot(
                        unit,
                        admission.challenge,
                        admission.admittedAt
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                const current = activeAccountMatchesSnapshot(
                    unit,
                    identity,
                    admission.account,
                    failedAt,
                    sessionIdleDurationMs
                );
                if (current === undefined) return { status: "session-changed" as const };
                if (
                    !enrollmentIsRecentlyAuthorized(
                        current,
                        failedAt,
                        recentAuthenticationWindowMs
                    )
                ) {
                    return { status: "step-up-required" as const };
                }
                if (
                    !possessionFactorSnapshotMatches(
                        unit,
                        identity.userId,
                        admission.factors
                    )
                ) {
                    return { status: "state-changed" as const };
                }
                return recordFailure(unit, failedAt);
            });
        } catch (error) {
            return accountStateError(error);
        }
    };

    const consumeWithoutProofFailure = async (
        admission: AccountWebAuthnRegistrationAdmission,
        outcome: "cancelled" | "failed"
    ): Promise<ConfirmWebAuthnEnrollmentResult | undefined> => {
        const occurredAt = now();
        try {
            return await repository.withImmediateTransaction((unit) => {
                const current = activeAccountMatchesSnapshot(
                    unit,
                    identity,
                    admission.account,
                    occurredAt,
                    sessionIdleDurationMs
                );
                const challenge = unit.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                );
                if (
                    current === undefined ||
                    !webAuthnChallengeSnapshotMatches(challenge, admission.challenge)
                ) {
                    return outcome === "failed"
                        ? ({ status: "state-changed" } as const)
                        : undefined;
                }
                if (
                    !consumeWebAuthnChallengeSnapshot(
                        unit,
                        admission.challenge,
                        admission.admittedAt
                    )
                ) {
                    return outcome === "failed"
                        ? ({ status: "state-changed" } as const)
                        : undefined;
                }
                audit(unit, {
                    action: "auth.mfa.webauthn.enrollment.confirm",
                    actor: sessionActor(identity),
                    metadata: { method: "webauthn" },
                    occurredAt,
                    outcome,
                    requestId: metadata.requestId,
                    targetId: admission.challenge.id,
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

    const settleVerifiedRegistration = async (
        admission: AccountWebAuthnRegistrationAdmission,
        verification: VerifiedWebAuthnRegistration,
        verifiedAt: Date
    ): Promise<VerifiedWebAuthnEnrollmentSettlement> => {
        const candidate = credentialInsert(
            generateId,
            input,
            verification,
            identity.userId,
            relyingParty.rpId,
            verifiedAt
        );
        try {
            return await repository.withImmediateTransaction((unit) => {
                const challenge = unit.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                );
                if (
                    !webAuthnChallengeSnapshotMatches(challenge, admission.challenge) ||
                    !consumeWebAuthnChallengeSnapshot(
                        unit,
                        admission.challenge,
                        admission.admittedAt
                    )
                ) {
                    return {
                        kind: "result" as const,
                        result: { status: "state-changed" as const },
                    };
                }
                const current = activeAccountMatchesSnapshot(
                    unit,
                    identity,
                    admission.account,
                    verifiedAt,
                    sessionIdleDurationMs
                );
                if (current === undefined) {
                    return {
                        kind: "result" as const,
                        result: { status: "session-changed" as const },
                    };
                }
                if (compareAsc(admission.challenge.expiresAt, verifiedAt) <= 0) {
                    audit(unit, {
                        action: "auth.mfa.webauthn.enrollment.confirm",
                        actor: sessionActor(identity),
                        metadata: { method: "webauthn" },
                        occurredAt: verifiedAt,
                        outcome: "failed",
                        requestId: metadata.requestId,
                        targetId: admission.challenge.id,
                        targetType: "auth_challenge",
                    });
                    return {
                        kind: "result" as const,
                        result: { status: "service-unavailable" as const },
                    };
                }
                if (
                    !enrollmentIsRecentlyAuthorized(
                        current,
                        verifiedAt,
                        recentAuthenticationWindowMs
                    )
                ) {
                    return {
                        kind: "result" as const,
                        result: { status: "step-up-required" as const },
                    };
                }
                if (
                    !possessionFactorSnapshotMatches(
                        unit,
                        identity.userId,
                        admission.factors
                    )
                ) {
                    return {
                        kind: "result" as const,
                        result: { status: "state-changed" as const },
                    };
                }
                if (
                    possessionFactorCount(admission.factors) >=
                    possessionFactorMaximumPerUser
                ) {
                    return {
                        kind: "result" as const,
                        result: { status: "factor-limit" as const },
                    };
                }

                if (current.user.mfaEnabledAt === null) {
                    if (possessionFactorCount(admission.factors) !== 0) {
                        return {
                            kind: "result" as const,
                            result: { status: "state-changed" as const },
                        };
                    }
                    audit(unit, {
                        action: "auth.mfa.webauthn.enrollment.confirm",
                        actor: sessionActor(identity),
                        metadata: { method: "webauthn" },
                        occurredAt: verifiedAt,
                        outcome: "accepted",
                        requestId: metadata.requestId,
                        targetId: admission.challenge.id,
                        targetType: "auth_challenge",
                    });
                    return {
                        kind: "staged" as const,
                        staged: { admission, credential: candidate },
                    };
                }

                const inserted = unit.insertWebAuthnCredentialIfAvailable(candidate);
                if (inserted === undefined) {
                    return {
                        kind: "result" as const,
                        result: recordFailure(unit, verifiedAt),
                    };
                }
                clearRateLimits(unit, rateLimitTargets);
                audit(unit, {
                    action: "auth.mfa.webauthn.enrollment.confirm",
                    actor: sessionActor(identity),
                    metadata: { method: "webauthn" },
                    occurredAt: verifiedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: inserted.id,
                    targetType: "user_webauthn_credential",
                });
                return {
                    kind: "result" as const,
                    result: {
                        credential: webAuthnCredentialSummary(
                            inserted,
                            relyingParty.rpId
                        ),
                        enabledNow: false as const,
                        status: "confirmed" as const,
                    },
                };
            });
        } catch (error) {
            return { kind: "result", result: accountStateError(error) };
        }
    };

    const activateFirstCredential = async (
        staged: StagedFirstWebAuthnCredential,
        prepared: PreparedRecoveryCodeSet,
        confirmedAt: Date
    ): Promise<ConfirmWebAuthnEnrollmentResult> => {
        const sessionToken = generateSessionToken();
        try {
            return await repository.withImmediateTransaction((unit) => {
                const current = currentAccount(
                    unit,
                    identity,
                    staged.admission.account,
                    confirmedAt,
                    sessionIdleDurationMs
                );
                if (
                    !enrollmentIsRecentlyAuthorized(
                        current,
                        confirmedAt,
                        recentAuthenticationWindowMs
                    )
                ) {
                    return { status: "step-up-required" as const };
                }
                if (
                    current.user.mfaEnabledAt !== null ||
                    !possessionFactorSnapshotMatches(
                        unit,
                        identity.userId,
                        staged.admission.factors
                    ) ||
                    possessionFactorCount(staged.admission.factors) !== 0
                ) {
                    return { status: "state-changed" as const };
                }
                const inserted = unit.insertWebAuthnCredentialIfAvailable(
                    staged.credential
                );
                if (inserted === undefined) return recordFailure(unit, confirmedAt);
                const enabledUser = unit.updateUserMfaState({
                    expectedAuthenticationVersion: current.user.authenticationVersion,
                    expectedMfaEnabledAt: null,
                    mfaEnabledAt: confirmedAt,
                    updatedAt: confirmedAt,
                    userId: identity.userId,
                });
                if (enabledUser === undefined) throw new MfaAccountStateChangedError();
                unit.deletePendingTotpFactorsForUser(identity.userId);
                unit.deleteRecoveryCodesForUser(identity.userId);
                for (const recovery of prepared.records) {
                    unit.insertRecoveryCode({
                        createdAt: confirmedAt,
                        id: recovery.id,
                        selector: recovery.selector,
                        usedAt: null,
                        userId: identity.userId,
                        validatorHash: recovery.validatorHash,
                    });
                }
                const rotated = rotateSession(unit, current, enabledUser, sessionToken, {
                    authenticationMethod: "webauthn",
                    createdAt: confirmedAt,
                    mfaVerifiedAt: confirmedAt,
                    passwordVerifiedAt: current.session.passwordVerifiedAt,
                    userAgent: metadata.userAgent,
                });
                const revokedSessions = unit.deleteOtherSessions(
                    identity.userId,
                    rotated.record.id
                );
                unit.deletePendingLoginsForUser(identity.userId);
                clearRateLimits(unit, rateLimitTargets);
                audit(unit, {
                    action: "auth.mfa.enable",
                    actor: sessionActor(identity),
                    metadata: { method: "webauthn", revokedSessions },
                    occurredAt: confirmedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: identity.userId,
                    targetType: "user",
                });
                return {
                    credential: webAuthnCredentialSummary(inserted, relyingParty.rpId),
                    enabledNow: true as const,
                    recoveryCodes: prepared.codes,
                    revokedSessions,
                    session: authSession(rotated.record, rotated.record.id),
                    status: "confirmed" as const,
                    token: rotated.token,
                };
            });
        } catch (error) {
            return accountStateError(error);
        }
    };

    return Object.freeze({
        activateFirstCredential,
        consumeWithoutProofFailure,
        recordInvalidRegistration,
        settleVerifiedRegistration,
    });
}
