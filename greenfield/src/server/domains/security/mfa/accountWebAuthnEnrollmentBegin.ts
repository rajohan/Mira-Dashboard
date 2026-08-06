import { addMilliseconds, getTime } from "date-fns";

import { possessionFactorMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import { webAuthnCeremonyTimeoutMs } from "../../../../contracts/webauthn.ts";
import { sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountStateError,
    activeAccount,
    currentAccount,
    enrollmentIsRecentlyAuthorized,
    MfaAccountStateChangedError,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import {
    possessionFactorCount,
    possessionFactorSnapshotIsConsistent,
    possessionFactorSnapshotMatches,
    possessionFactorStateMatchesAccount,
    readAccountPossessionFactorSnapshot,
    webAuthnCredentialDescriptors,
} from "./accountWebAuthnState.ts";
import { createWebAuthnUserHandle } from "./webauthn/relyingPartyConfiguration.ts";

type BeginWebAuthnEnrollmentOperation = Pick<
    MfaAccountLifecycleService,
    "beginWebAuthnEnrollment"
>;

type BeginWebAuthnEnrollmentPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateId"
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
    | "webAuthnAdapter"
    | "webAuthnRelyingParty"
>;

/**
 * Generates fixed-policy registration options and persists one replacement challenge.
 * @returns The focused WebAuthn enrollment-begin operation.
 */
export function createBeginWebAuthnEnrollmentOperation(
    context: BeginWebAuthnEnrollmentPort
): BeginWebAuthnEnrollmentOperation {
    const {
        audit,
        generateId,
        now,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
        webAuthnAdapter,
        webAuthnRelyingParty,
    } = context;

    return Object.freeze({
        async beginWebAuthnEnrollment(identity, metadata) {
            if (webAuthnAdapter === undefined || webAuthnRelyingParty === undefined) {
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
                return { account, factors, status: "ready" as const };
            });
            if (snapshot.status !== "ready") return snapshot;

            metadata.signal?.throwIfAborted();
            let generated: Awaited<
                ReturnType<typeof webAuthnAdapter.generateRegistrationOptions>
            >;
            try {
                generated = await webAuthnAdapter.generateRegistrationOptions({
                    excludeCredentials: webAuthnCredentialDescriptors(
                        snapshot.factors.webAuthnCredentials
                    ),
                    userDisplayName: snapshot.account.user.username,
                    userHandle: createWebAuthnUserHandle(identity.userId),
                    userName: snapshot.account.user.username,
                });
            } catch {
                metadata.signal?.throwIfAborted();
                return { status: "service-unavailable" };
            }
            metadata.signal?.throwIfAborted();
            if (generated.status !== "generated") {
                return { status: "service-unavailable" };
            }

            const createdAt = now();
            const expiresAt = addMilliseconds(createdAt, webAuthnCeremonyTimeoutMs);
            const challengeId = generateId();
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
                        !possessionFactorSnapshotMatches(
                            unit,
                            identity.userId,
                            snapshot.factors
                        )
                    ) {
                        throw new MfaAccountStateChangedError();
                    }
                    if (
                        possessionFactorCount(snapshot.factors) >=
                        possessionFactorMaximumPerUser
                    ) {
                        return { status: "factor-limit" as const };
                    }
                    const challenge = unit.replaceWebAuthnChallenge({
                        authenticationVersion: current.user.authenticationVersion,
                        challenge: generated.options.challenge,
                        configFingerprint: webAuthnRelyingParty.fingerprint,
                        createdAt,
                        expiresAt,
                        id: challengeId,
                        pendingLoginId: null,
                        purpose: "registration",
                        sessionId: current.session.id,
                    });
                    audit(unit, {
                        action: "auth.mfa.webauthn.enrollment.begin",
                        actor: sessionActor(identity),
                        metadata: { method: "webauthn" },
                        occurredAt: createdAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: challenge.id,
                        targetType: "auth_challenge",
                    });
                    return {
                        expiresAtMs: getTime(expiresAt),
                        options: generated.options,
                        status: "created" as const,
                    };
                });
            } catch (error) {
                return accountStateError(error);
            }
        },
    });
}
