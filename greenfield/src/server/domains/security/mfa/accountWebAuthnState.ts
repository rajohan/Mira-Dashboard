import { compareAsc, getTime } from "date-fns";

import { possessionFactorMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import type { AuthenticatedBrowserIdentity } from "../authenticationSession.ts";
import {
    activeAccount,
    totpFactorSetsMatch,
    type AccountSnapshot,
} from "./accountLifecycleState.ts";
import type {
    MfaLifecycleReader,
    MfaLifecycleUnitOfWork,
    MfaTotpFactorRecord,
    MfaWebAuthnChallengeRecord,
    MfaWebAuthnCredentialRecord,
} from "./lifecycleRepositoryTypes.ts";
import type { WebAuthnCredentialDescriptor } from "./webauthn/adapter.ts";
import {
    webAuthnCredentialSnapshotMatches,
    webAuthnTransportsFromMask,
} from "./webauthn/credentialState.ts";
import type { WebAuthnRelyingPartyConfiguration } from "./webauthn/relyingPartyConfiguration.ts";

export const defaultWebAuthnCredentialLabel = "Security key";
const possessionFactorReadMaximum = possessionFactorMaximumPerUser + 1;

export interface AccountPossessionFactorSnapshot {
    readonly confirmedTotpCount: number;
    readonly totpFactors: readonly MfaTotpFactorRecord[];
    readonly webAuthnCredentialCount: number;
    readonly webAuthnCredentials: readonly MfaWebAuthnCredentialRecord[];
}

function sameNullableDate(left: Date | null, right: Date | null): boolean {
    return left === null
        ? right === null
        : right !== null && getTime(left) === getTime(right);
}

export function webAuthnChallengeSnapshotMatches(
    current: MfaWebAuthnChallengeRecord | undefined,
    expected: MfaWebAuthnChallengeRecord
): current is MfaWebAuthnChallengeRecord {
    return (
        current !== undefined &&
        current.id === expected.id &&
        current.authenticationVersion === expected.authenticationVersion &&
        current.challenge === expected.challenge &&
        current.configFingerprint === expected.configFingerprint &&
        current.purpose === expected.purpose &&
        current.pendingLoginId === expected.pendingLoginId &&
        current.sessionId === expected.sessionId &&
        getTime(current.createdAt) === getTime(expected.createdAt) &&
        getTime(current.expiresAt) === getTime(expected.expiresAt)
    );
}

export function sessionWebAuthnChallengeIsCurrent(
    challenge: MfaWebAuthnChallengeRecord | undefined,
    account: AccountSnapshot,
    purpose: "registration" | "step-up",
    configuration: WebAuthnRelyingPartyConfiguration,
    checkedAt: Date
): challenge is MfaWebAuthnChallengeRecord {
    return (
        challenge !== undefined &&
        challenge.authenticationVersion === account.user.authenticationVersion &&
        challenge.configFingerprint === configuration.fingerprint &&
        challenge.pendingLoginId === null &&
        challenge.purpose === purpose &&
        challenge.sessionId === account.session.id &&
        compareAsc(challenge.createdAt, checkedAt) <= 0 &&
        compareAsc(challenge.expiresAt, checkedAt) > 0
    );
}

export function readAccountPossessionFactorSnapshot(
    reader: MfaLifecycleReader,
    userId: string
): AccountPossessionFactorSnapshot {
    return Object.freeze({
        confirmedTotpCount: reader.countConfirmedTotpFactors(userId),
        totpFactors: Object.freeze(
            reader.listConfirmedTotpFactors(userId, possessionFactorReadMaximum)
        ),
        webAuthnCredentialCount: reader.countWebAuthnCredentials(userId),
        webAuthnCredentials: Object.freeze(
            reader.listWebAuthnCredentials(userId, possessionFactorReadMaximum)
        ),
    });
}

export function possessionFactorCount(snapshot: AccountPossessionFactorSnapshot): number {
    return snapshot.confirmedTotpCount + snapshot.webAuthnCredentialCount;
}

export function possessionFactorSnapshotIsConsistent(
    snapshot: AccountPossessionFactorSnapshot
): boolean {
    return (
        snapshot.confirmedTotpCount === snapshot.totpFactors.length &&
        snapshot.webAuthnCredentialCount === snapshot.webAuthnCredentials.length &&
        possessionFactorCount(snapshot) <= possessionFactorMaximumPerUser
    );
}

export function possessionFactorSnapshotMatches(
    reader: MfaLifecycleReader,
    userId: string,
    expected: AccountPossessionFactorSnapshot
): boolean {
    const current = readAccountPossessionFactorSnapshot(reader, userId);
    return (
        current.confirmedTotpCount === expected.confirmedTotpCount &&
        current.webAuthnCredentialCount === expected.webAuthnCredentialCount &&
        totpFactorSetsMatch(current.totpFactors, expected.totpFactors) &&
        current.webAuthnCredentials.length === expected.webAuthnCredentials.length &&
        current.webAuthnCredentials.every((credential, index) => {
            const expectedCredential = expected.webAuthnCredentials[index];
            return (
                expectedCredential !== undefined &&
                webAuthnCredentialSnapshotMatches(credential, expectedCredential)
            );
        })
    );
}

export function possessionFactorStateMatchesAccount(
    account: AccountSnapshot,
    snapshot: AccountPossessionFactorSnapshot
): boolean {
    return account.user.mfaEnabledAt === null
        ? possessionFactorCount(snapshot) === 0
        : possessionFactorCount(snapshot) > 0;
}

export function activeAccountMatchesSnapshot(
    reader: MfaLifecycleReader,
    identity: AuthenticatedBrowserIdentity,
    expected: AccountSnapshot,
    checkedAt: Date,
    sessionIdleDurationMs: number
): AccountSnapshot | undefined {
    const current = activeAccount(reader, identity, checkedAt, sessionIdleDurationMs);
    return current !== undefined &&
        current.user.authenticationVersion === expected.user.authenticationVersion &&
        current.session.validatorHash === expected.session.validatorHash
        ? current
        : undefined;
}

export function consumeWebAuthnChallengeSnapshot(
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

export function webAuthnCredentialDescriptors(
    credentials: readonly MfaWebAuthnCredentialRecord[]
): readonly WebAuthnCredentialDescriptor[] {
    return Object.freeze(
        credentials.map((credential) => ({
            id: credential.credentialId,
            transports: [...webAuthnTransportsFromMask(credential.transportMask)],
        }))
    );
}

export function sameMfaEnabledAt(
    current: AccountSnapshot,
    expected: AccountSnapshot
): boolean {
    return sameNullableDate(current.user.mfaEnabledAt, expected.user.mfaEnabledAt);
}
