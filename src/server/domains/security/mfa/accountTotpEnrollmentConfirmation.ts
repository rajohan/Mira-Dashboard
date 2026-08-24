import { compareAsc } from "date-fns";

import type { ConfirmTotpEnrollmentInput } from "../../../../contracts/accountSecurity.ts";
import { possessionFactorMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import type { GeneratedOpaqueToken } from "../../../shared/opaqueToken.ts";
import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
    type AuthenticationRateLimitTarget,
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
    activeAccount,
    clearRateLimits,
    currentAccount,
    enrollmentIsRecentlyAuthorized,
    factorSnapshotMatches,
    factorSummary,
    MfaAccountStateChangedError,
    type AccountSnapshot,
} from "./accountLifecycleState.ts";
import type {
    ConfirmTotpEnrollmentResult,
    MfaAccountLifecycleService,
} from "./accountLifecycleTypes.ts";
import type { MfaTotpFactorRecord } from "./lifecycleRepositoryTypes.ts";
import type { TotpVerificationResult } from "./totp.ts";

type ConfirmEnrollmentOperation = Pick<
    MfaAccountLifecycleService,
    "confirmTotpEnrollment"
>;

type ConfirmEnrollmentPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateSessionToken"
    | "now"
    | "prepareRecoveryCodeSet"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "rotateSession"
    | "sessionIdleDurationMs"
    | "totpSecretCipher"
    | "totpWorkBudget"
    | "totpWorkGate"
    | "verifyTotp"
>;

interface ConfirmationSnapshot {
    readonly account: AccountSnapshot;
    readonly factor: MfaTotpFactorRecord;
    readonly status: "ready";
}

function pendingFactorIsCurrent(
    factor: MfaTotpFactorRecord | undefined,
    checkedAt: Date
): factor is MfaTotpFactorRecord {
    return (
        factor !== undefined &&
        factor.confirmedAt === null &&
        factor.lastUsedStep === null &&
        compareAsc(factor.createdAt, checkedAt) <= 0 &&
        compareAsc(factor.enrollmentExpiresAt, checkedAt) > 0
    );
}

function possessionFactorCountMatchesMfaState(
    account: AccountSnapshot,
    possessionFactorCount: number
): boolean {
    return account.user.mfaEnabledAt === null
        ? possessionFactorCount === 0
        : possessionFactorCount > 0;
}

/**
 * Confirms one pending TOTP factor and enables MFA atomically when it is the first.
 * @returns Frozen enrollment-confirmation operation.
 */
export function createConfirmTotpEnrollmentOperation(
    context: ConfirmEnrollmentPort
): ConfirmEnrollmentOperation {
    const {
        audit,
        generateSessionToken,
        now,
        prepareRecoveryCodeSet,
        recentAuthenticationWindowMs,
        repository,
        rotateSession,
        sessionIdleDurationMs,
        totpSecretCipher,
        totpWorkBudget,
        totpWorkGate,
        verifyTotp,
    } = context;

    const readConfirmationSnapshot = (
        identity: AuthenticatedBrowserIdentity,
        input: ConfirmTotpEnrollmentInput,
        checkedAt: Date
    ) =>
        repository.withReadTransaction((reader) => {
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
            const factor = reader.findTotpFactor(identity.userId, input.factorId);
            if (!pendingFactorIsCurrent(factor, checkedAt)) {
                return { status: "state-changed" as const };
            }
            const confirmedCount = reader.countConfirmedTotpFactors(identity.userId);
            const possessionFactorCount =
                confirmedCount + reader.countWebAuthnCredentials(identity.userId);
            if (possessionFactorCount >= possessionFactorMaximumPerUser) {
                return { status: "factor-limit" as const };
            }
            if (!possessionFactorCountMatchesMfaState(account, possessionFactorCount)) {
                return { status: "state-changed" as const };
            }
            return { account, factor, status: "ready" as const };
        });

    const recordInvalidProof = async (
        identity: AuthenticatedBrowserIdentity,
        input: ConfirmTotpEnrollmentInput,
        metadata: AuthenticationRequestMetadata,
        snapshot: ConfirmationSnapshot,
        rateLimitTargets: readonly AuthenticationRateLimitTarget[],
        failedAt: Date
    ): Promise<ConfirmTotpEnrollmentResult> => {
        try {
            return await repository.withImmediateTransaction((unit) => {
                const activeLimit = activeRateLimitForTargets(
                    unit,
                    rateLimitTargets,
                    failedAt
                );
                if (activeLimit !== undefined) {
                    return { ...activeLimit, status: "rate-limited" as const };
                }
                const current = currentAccount(
                    unit,
                    identity,
                    snapshot.account,
                    failedAt,
                    sessionIdleDurationMs
                );
                if (
                    !enrollmentIsRecentlyAuthorized(
                        current,
                        failedAt,
                        recentAuthenticationWindowMs
                    )
                ) {
                    return { status: "step-up-required" as const };
                }
                const currentFactor = unit.findTotpFactor(
                    identity.userId,
                    input.factorId
                );
                if (
                    !factorSnapshotMatches(currentFactor, snapshot.factor) ||
                    currentFactor.confirmedAt !== null ||
                    currentFactor.lastUsedStep !== null ||
                    compareAsc(currentFactor.enrollmentExpiresAt, failedAt) <= 0
                ) {
                    throw new MfaAccountStateChangedError();
                }
                const failure = recordAuthenticationFailures(
                    unit,
                    rateLimitTargets,
                    failedAt
                );
                audit(unit, {
                    action: "auth.mfa.totp.enrollment.confirm",
                    actor: sessionActor(identity),
                    metadata: { method: "totp", reason: "totp_invalid" },
                    occurredAt: failedAt,
                    outcome: "denied",
                    requestId: metadata.requestId,
                    targetId: snapshot.factor.id,
                    targetType: "user_totp_factor",
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

    const commitConfirmation = async (
        identity: AuthenticatedBrowserIdentity,
        input: ConfirmTotpEnrollmentInput,
        metadata: AuthenticationRequestMetadata,
        snapshot: ConfirmationSnapshot,
        verification: TotpVerificationResult,
        rateLimitTargets: readonly AuthenticationRateLimitTarget[],
        confirmedAt: Date,
        preparedRecoveryCodes: PreparedRecoveryCodeSet | undefined,
        sessionToken: GeneratedOpaqueToken | undefined
    ): Promise<ConfirmTotpEnrollmentResult> => {
        try {
            return await repository.withImmediateTransaction((unit) => {
                const current = currentAccount(
                    unit,
                    identity,
                    snapshot.account,
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
                const currentFactor = unit.findTotpFactor(
                    identity.userId,
                    input.factorId
                );
                if (!factorSnapshotMatches(currentFactor, snapshot.factor)) {
                    throw new MfaAccountStateChangedError();
                }
                const confirmedCount = unit.countConfirmedTotpFactors(identity.userId);
                const possessionFactorCount =
                    confirmedCount + unit.countWebAuthnCredentials(identity.userId);
                if (possessionFactorCount >= possessionFactorMaximumPerUser) {
                    return { status: "factor-limit" as const };
                }
                if (
                    !possessionFactorCountMatchesMfaState(current, possessionFactorCount)
                ) {
                    throw new MfaAccountStateChangedError();
                }
                const confirmedFactor = unit.confirmTotpFactor({
                    confirmedAt,
                    expectedCreatedAt: snapshot.factor.createdAt,
                    expectedEncryptedSecret: snapshot.factor.encryptedSecret,
                    expectedEnrollmentExpiresAt: snapshot.factor.enrollmentExpiresAt,
                    expectedSecretKeyId: snapshot.factor.secretKeyId,
                    factorId: snapshot.factor.id,
                    lastUsedStep: verification.timeStep,
                    userId: identity.userId,
                });
                if (confirmedFactor === undefined) {
                    throw new MfaAccountStateChangedError();
                }
                clearRateLimits(unit, rateLimitTargets);

                if (current.user.mfaEnabledAt !== null) {
                    audit(unit, {
                        action: "auth.mfa.totp.enrollment.confirm",
                        actor: sessionActor(identity),
                        metadata: { method: "totp" },
                        occurredAt: confirmedAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: confirmedFactor.id,
                        targetType: "user_totp_factor",
                    });
                    return {
                        enabledNow: false,
                        factor: factorSummary(confirmedFactor),
                        status: "confirmed" as const,
                    };
                }

                if (preparedRecoveryCodes === undefined || sessionToken === undefined) {
                    throw new MfaAccountStateChangedError();
                }
                const enabledUser = unit.updateUserMfaState({
                    expectedAuthenticationVersion: current.user.authenticationVersion,
                    expectedMfaEnabledAt: null,
                    mfaEnabledAt: confirmedAt,
                    updatedAt: confirmedAt,
                    userId: identity.userId,
                });
                if (enabledUser === undefined) {
                    throw new MfaAccountStateChangedError();
                }
                unit.deletePendingTotpFactorsForUser(identity.userId);
                unit.deleteRecoveryCodesForUser(identity.userId);
                for (const recovery of preparedRecoveryCodes.records) {
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
                    authenticationMethod: "totp",
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
                audit(unit, {
                    action: "auth.mfa.enable",
                    actor: sessionActor(identity),
                    metadata: { method: "totp", revokedSessions },
                    occurredAt: confirmedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: identity.userId,
                    targetType: "user",
                });
                return {
                    enabledNow: true,
                    factor: factorSummary(confirmedFactor),
                    recoveryCodes: preparedRecoveryCodes.codes,
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
        async confirmTotpEnrollment(identity, input, metadata) {
            const checkedAt = now();
            const rateLimitTargets = accountMfaRateLimitTargets(identity.userId);
            const activeLimit = activeRateLimitForTargets(
                repository,
                rateLimitTargets,
                checkedAt
            );
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" };
            }

            const snapshot = readConfirmationSnapshot(identity, input, checkedAt);
            if (snapshot.status !== "ready") return snapshot;
            if (!totpSecretCipher.hasKey(snapshot.factor.secretKeyId)) {
                return { status: "service-unavailable" };
            }

            const admission = await totpWorkGate.run(async () => {
                const admittedAt = now();
                const admittedLimit = activeRateLimitForTargets(
                    repository,
                    rateLimitTargets,
                    admittedAt
                );
                if (admittedLimit !== undefined) {
                    return { ...admittedLimit, status: "rate-limited" as const };
                }
                const budget = totpWorkBudget.consume();
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited" as const,
                    };
                }
                let secret: string;
                try {
                    secret = await totpSecretCipher.decrypt(
                        {
                            envelope: snapshot.factor.encryptedSecret,
                            keyId: snapshot.factor.secretKeyId,
                        },
                        {
                            factorId: snapshot.factor.id,
                            userId: snapshot.factor.userId,
                        }
                    );
                } catch {
                    return { status: "service-unavailable" as const };
                }
                metadata.signal?.throwIfAborted();
                const verification = await verifyTotp({
                    lastUsedTimeStep: null,
                    now: checkedAt,
                    secret,
                    token: input.code,
                });
                metadata.signal?.throwIfAborted();
                if (verification === undefined) {
                    return {
                        result: await recordInvalidProof(
                            identity,
                            input,
                            metadata,
                            snapshot,
                            rateLimitTargets,
                            now()
                        ),
                        status: "settled" as const,
                    };
                }
                if (snapshot.account.user.mfaEnabledAt !== null) {
                    return {
                        result: await commitConfirmation(
                            identity,
                            input,
                            metadata,
                            snapshot,
                            verification,
                            rateLimitTargets,
                            now(),
                            undefined,
                            undefined
                        ),
                        status: "settled" as const,
                    };
                }
                return { status: "verified" as const, verification };
            }, metadata.signal);
            if (!admission.accepted) {
                return {
                    retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited",
                };
            }
            if (admission.value.status === "settled") {
                return admission.value.result;
            }
            if (admission.value.status !== "verified") return admission.value;
            const { verification } = admission.value;

            let preparedRecoveryCodes: PreparedRecoveryCodeSet | undefined;
            let sessionToken: GeneratedOpaqueToken | undefined;
            if (snapshot.account.user.mfaEnabledAt === null) {
                const prepared = await prepareRecoveryCodeSet(
                    identity.userId,
                    metadata.signal
                );
                if ("status" in prepared) return prepared;
                preparedRecoveryCodes = prepared;
                sessionToken = generateSessionToken();
            }
            metadata.signal?.throwIfAborted();

            return await commitConfirmation(
                identity,
                input,
                metadata,
                snapshot,
                verification,
                rateLimitTargets,
                now(),
                preparedRecoveryCodes,
                sessionToken
            );
        },
    });
}
