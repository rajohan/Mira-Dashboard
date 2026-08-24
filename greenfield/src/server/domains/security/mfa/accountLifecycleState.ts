import { compareAsc, getTime } from "date-fns";

import {
    recoveryCodeCount,
    totpFactorMaximumPerUser,
    type TotpFactorSummary,
} from "../../../../contracts/accountSecurity.ts";
import {
    rateLimitBucketKey,
    sourceRateLimitBlockDurations,
    type AuthenticationRateLimitTarget,
} from "../authenticationRateLimit.ts";
import {
    browserSessionIsActive,
    type AuthenticatedBrowserIdentity,
} from "../authenticationSession.ts";
import { evaluateRecentAuthentication } from "../recentAuthentication.ts";
import type {
    SessionChangedResult,
    StateChangedResult,
} from "./accountLifecycleTypes.ts";
import type {
    MfaLifecycleReader,
    MfaLifecycleUnitOfWork,
    MfaRecoveryCodeRecord,
    MfaSessionRecord,
    MfaTotpFactorRecord,
    MfaUserRecord,
} from "./lifecycleRepositoryTypes.ts";

export const defaultTotpFactorLabel = "Authenticator";
export const totpFactorReadMaximum = totpFactorMaximumPerUser + 1;
export const recoveryCodeReadMaximum = recoveryCodeCount + 1;

export interface AccountSnapshot {
    readonly session: MfaSessionRecord;
    readonly user: MfaUserRecord;
}

export class MfaAccountSessionChangedError extends Error {}
export class MfaAccountStateChangedError extends Error {}

function sameDate(left: Date | null, right: Date | null): boolean {
    return left === null
        ? right === null
        : right !== null && getTime(left) === getTime(right);
}

export function factorSummary(factor: MfaTotpFactorRecord): TotpFactorSummary {
    if (factor.confirmedAt === null) {
        throw new Error("Pending TOTP factor cannot be summarized as confirmed");
    }
    return Object.freeze({
        confirmedAtMs: getTime(factor.confirmedAt),
        createdAtMs: getTime(factor.createdAt),
        id: factor.id,
        label: factor.label,
    });
}

export function factorSnapshotMatches(
    current: MfaTotpFactorRecord | undefined,
    expected: MfaTotpFactorRecord
): current is MfaTotpFactorRecord {
    return (
        current !== undefined &&
        current.id === expected.id &&
        current.userId === expected.userId &&
        current.encryptedSecret === expected.encryptedSecret &&
        current.secretKeyId === expected.secretKeyId &&
        getTime(current.createdAt) === getTime(expected.createdAt) &&
        getTime(current.enrollmentExpiresAt) === getTime(expected.enrollmentExpiresAt) &&
        sameDate(current.confirmedAt, expected.confirmedAt) &&
        current.lastUsedStep === expected.lastUsedStep
    );
}

export function totpFactorSetsMatch(
    current: readonly MfaTotpFactorRecord[],
    expected: readonly MfaTotpFactorRecord[]
): boolean {
    return (
        current.length === expected.length &&
        current.every((factor, index) => {
            const expectedFactor = expected[index];
            return (
                expectedFactor !== undefined &&
                factorSnapshotMatches(factor, expectedFactor)
            );
        })
    );
}

export function recoverySnapshotMatches(
    current: MfaRecoveryCodeRecord | undefined,
    expected: MfaRecoveryCodeRecord | undefined
): boolean {
    if (current === undefined || expected === undefined) return current === expected;
    return (
        current.id === expected.id &&
        current.userId === expected.userId &&
        current.selector === expected.selector &&
        current.validatorHash === expected.validatorHash &&
        getTime(current.createdAt) === getTime(expected.createdAt) &&
        sameDate(current.usedAt, expected.usedAt)
    );
}

export function recoveryCodeSetsMatch(
    current: readonly MfaRecoveryCodeRecord[],
    expected: readonly MfaRecoveryCodeRecord[]
): boolean {
    return (
        current.length === expected.length &&
        current.every((code, index) => recoverySnapshotMatches(code, expected[index]))
    );
}

export function accountMfaRateLimitTargets(
    userId: string
): readonly AuthenticationRateLimitTarget[] {
    return [
        {
            blockDurations: sourceRateLimitBlockDurations,
            kind: "account-mfa",
            subject: userId,
        },
    ];
}

export function accountPasswordRateLimitTargets(
    userId: string
): readonly AuthenticationRateLimitTarget[] {
    return [
        {
            blockDurations: sourceRateLimitBlockDurations,
            kind: "account-password",
            subject: userId,
        },
    ];
}

export function clearRateLimits(
    unit: MfaLifecycleUnitOfWork,
    targets: readonly AuthenticationRateLimitTarget[]
): void {
    for (const target of targets) {
        unit.deleteRateLimitBucket(rateLimitBucketKey(target.kind, target.subject));
    }
}

export function activeAccount(
    reader: MfaLifecycleReader,
    identity: AuthenticatedBrowserIdentity,
    checkedAt: Date,
    sessionIdleDurationMs: number
): AccountSnapshot | undefined {
    const user = reader.findUserById(identity.userId);
    const session = reader.findSession(identity.userId, identity.sessionId);
    if (
        user === undefined ||
        user.disabledAt !== null ||
        session === undefined ||
        session.authenticationVersion !== user.authenticationVersion ||
        compareAsc(session.createdAt, checkedAt) > 0 ||
        compareAsc(session.lastSeenAt, checkedAt) > 0 ||
        !browserSessionIsActive(session, checkedAt, sessionIdleDurationMs) ||
        (user.mfaEnabledAt !== null &&
            (session.mfaVerifiedAt === null ||
                compareAsc(session.mfaVerifiedAt, user.mfaEnabledAt) < 0))
    ) {
        return undefined;
    }
    return { session, user };
}

export function currentAccount(
    unit: MfaLifecycleUnitOfWork,
    identity: AuthenticatedBrowserIdentity,
    expected: AccountSnapshot,
    checkedAt: Date,
    sessionIdleDurationMs: number
): AccountSnapshot {
    const current = activeAccount(unit, identity, checkedAt, sessionIdleDurationMs);
    if (
        current === undefined ||
        current.user.authenticationVersion !== expected.user.authenticationVersion ||
        current.session.validatorHash !== expected.session.validatorHash
    ) {
        throw new MfaAccountSessionChangedError();
    }
    return current;
}

export function recentAuthentication(
    account: AccountSnapshot,
    checkedAt: Date,
    windowMs: number
) {
    return evaluateRecentAuthentication({
        checkedAt,
        mfaEnabledAt: account.user.mfaEnabledAt,
        mfaVerifiedAt: account.session.mfaVerifiedAt,
        passwordVerifiedAt: account.session.passwordVerifiedAt,
        windowMs,
    });
}

export function enrollmentIsRecentlyAuthorized(
    account: AccountSnapshot,
    checkedAt: Date,
    windowMs: number
): boolean {
    const recent = recentAuthentication(account, checkedAt, windowMs);
    return account.user.mfaEnabledAt === null
        ? recent.password.recent
        : recent.mfa.recent;
}

export function mfaIsRecent(
    account: AccountSnapshot,
    checkedAt: Date,
    windowMs: number
): boolean {
    return recentAuthentication(account, checkedAt, windowMs).mfa.recent;
}

export function accountStateError(
    error: unknown
): SessionChangedResult | StateChangedResult {
    if (error instanceof MfaAccountSessionChangedError) {
        return { status: "session-changed" };
    }
    if (error instanceof MfaAccountStateChangedError) {
        return { status: "state-changed" };
    }
    throw error;
}
