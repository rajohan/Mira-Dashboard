import { addMilliseconds, getTime } from "date-fns";

import { webAuthnCeremonyTimeoutMs } from "../../../../contracts/webauthn.ts";
import { sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountStateError,
    activeAccount,
    currentAccount,
    MfaAccountStateChangedError,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import {
    possessionFactorSnapshotIsConsistent,
    possessionFactorSnapshotMatches,
    possessionFactorStateMatchesAccount,
    readAccountPossessionFactorSnapshot,
    webAuthnCredentialDescriptors,
} from "./accountWebAuthnState.ts";

type BeginWebAuthnStepUpOperation = Pick<
    MfaAccountLifecycleService,
    "beginWebAuthnStepUp"
>;

type BeginWebAuthnStepUpPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "generateId"
    | "now"
    | "repository"
    | "sessionIdleDurationMs"
    | "webAuthnAdapter"
    | "webAuthnRelyingParty"
>;

/**
 * Creates a fresh session-bound assertion challenge for account step-up.
 * @returns The focused account step-up challenge operation.
 */
export function createBeginWebAuthnStepUpOperation(
    context: BeginWebAuthnStepUpPort
): BeginWebAuthnStepUpOperation {
    const {
        audit,
        generateId,
        now,
        repository,
        sessionIdleDurationMs,
        webAuthnAdapter,
        webAuthnRelyingParty,
    } = context;

    return Object.freeze({
        async beginWebAuthnStepUp(identity, metadata) {
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
                if (account.user.mfaEnabledAt === null) {
                    return { status: "mfa-enrollment-required" as const };
                }
                const factors = readAccountPossessionFactorSnapshot(
                    reader,
                    identity.userId
                );
                if (
                    !possessionFactorSnapshotIsConsistent(factors) ||
                    !possessionFactorStateMatchesAccount(account, factors) ||
                    factors.webAuthnCredentials.length === 0
                ) {
                    return { status: "service-unavailable" as const };
                }
                const activeCredentials = factors.webAuthnCredentials.filter(
                    (credential) => credential.rpId === webAuthnRelyingParty.rpId
                );
                if (activeCredentials.length === 0) {
                    return { status: "service-unavailable" as const };
                }
                return {
                    account,
                    activeCredentials,
                    factors,
                    status: "ready" as const,
                };
            });
            if (snapshot.status !== "ready") return snapshot;

            metadata.signal?.throwIfAborted();
            let generated: Awaited<
                ReturnType<typeof webAuthnAdapter.generateAuthenticationOptions>
            >;
            try {
                generated = await webAuthnAdapter.generateAuthenticationOptions({
                    allowCredentials: webAuthnCredentialDescriptors(
                        snapshot.activeCredentials
                    ),
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
                    if (current.user.mfaEnabledAt === null) {
                        return { status: "mfa-enrollment-required" as const };
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
                    const challenge = unit.replaceWebAuthnChallenge({
                        authenticationVersion: current.user.authenticationVersion,
                        challenge: generated.options.challenge,
                        configFingerprint: webAuthnRelyingParty.fingerprint,
                        createdAt,
                        expiresAt,
                        id: challengeId,
                        pendingLoginId: null,
                        purpose: "step-up",
                        sessionId: current.session.id,
                    });
                    audit(unit, {
                        action: "auth.mfa.webauthn.step-up.begin",
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
