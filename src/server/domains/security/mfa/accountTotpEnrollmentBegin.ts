import { addMilliseconds, getTime } from "date-fns";

import { totpFactorMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import { totpEnrollmentLifetimeMaximumMs } from "../../../database/schema/userTotpFactors.ts";
import { sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountStateError,
    activeAccount,
    currentAccount,
    defaultTotpFactorLabel,
    enrollmentIsRecentlyAuthorized,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import { createDashboardTotpUri } from "./totp.ts";
import type { EncryptedTotpSecret } from "./totpSecretCipher.ts";

type BeginEnrollmentOperation = Pick<MfaAccountLifecycleService, "beginTotpEnrollment">;

type BeginEnrollmentPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateId"
    | "generateTotpSecret"
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
    | "totpSecretCipher"
>;

/**
 * Creates one pending TOTP enrollment after revalidating recent authentication.
 * @returns Frozen begin-enrollment operation.
 */
export function createBeginTotpEnrollmentOperation(
    context: BeginEnrollmentPort
): BeginEnrollmentOperation {
    const {
        audit,
        generateId,
        generateTotpSecret,
        now,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
        totpSecretCipher,
    } = context;

    return Object.freeze({
        async beginTotpEnrollment(identity, input, metadata) {
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
                if (
                    reader.countConfirmedTotpFactors(identity.userId) >=
                    totpFactorMaximumPerUser
                ) {
                    return { status: "factor-limit" as const };
                }
                return { account, status: "ready" as const };
            });
            if (snapshot.status !== "ready") return snapshot;

            const factorId = generateId();
            const secret = generateTotpSecret();
            let encrypted: EncryptedTotpSecret;
            try {
                encrypted = await totpSecretCipher.encrypt(secret, {
                    factorId,
                    userId: identity.userId,
                });
            } catch {
                return { status: "service-unavailable" };
            }
            metadata.signal?.throwIfAborted();
            const createdAt = now();
            const expiresAt = addMilliseconds(createdAt, totpEnrollmentLifetimeMaximumMs);
            const label = input.label ?? defaultTotpFactorLabel;
            const enrollment = Object.freeze({
                expiresAtMs: getTime(expiresAt),
                factorId,
                label,
                otpauthUri: createDashboardTotpUri(
                    snapshot.account.user.username,
                    secret
                ),
                secret,
            });

            try {
                return repository.withImmediateTransaction((unit) => {
                    const current = currentAccount(
                        unit,
                        identity,
                        snapshot.account,
                        createdAt,
                        sessionIdleDurationMs
                    );
                    if (
                        !enrollmentIsRecentlyAuthorized(
                            current,
                            createdAt,
                            recentAuthenticationWindowMs
                        )
                    ) {
                        return { status: "step-up-required" as const };
                    }
                    if (
                        unit.countConfirmedTotpFactors(identity.userId) >=
                        totpFactorMaximumPerUser
                    ) {
                        return { status: "factor-limit" as const };
                    }
                    unit.deletePendingTotpFactorsForUser(identity.userId);
                    const factor = unit.insertTotpFactor({
                        confirmedAt: null,
                        createdAt,
                        encryptedSecret: encrypted.envelope,
                        enrollmentExpiresAt: expiresAt,
                        id: factorId,
                        label,
                        lastUsedStep: null,
                        secretKeyId: encrypted.keyId,
                        userId: identity.userId,
                    });
                    audit(unit, {
                        action: "auth.mfa.totp.enrollment.begin",
                        actor: sessionActor(identity),
                        occurredAt: createdAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: factor.id,
                        targetType: "user_totp_factor",
                    });
                    return { enrollment, status: "created" as const };
                });
            } catch (error) {
                return accountStateError(error);
            }
        },
    });
}
