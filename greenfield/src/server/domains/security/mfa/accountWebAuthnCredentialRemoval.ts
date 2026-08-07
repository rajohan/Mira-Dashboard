import { sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    activeAccount,
    mfaIsRecent,
    MfaAccountStateChangedError,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import {
    possessionFactorCount,
    possessionFactorSnapshotIsConsistent,
    readAccountPossessionFactorSnapshot,
} from "./accountWebAuthnState.ts";

type RemoveWebAuthnCredentialOperation = Pick<
    MfaAccountLifecycleService,
    "removeWebAuthnCredential"
>;

type RemoveWebAuthnCredentialPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
    | "webAuthnRelyingParty"
>;

/**
 * Removes an internal credential id while preserving the aggregate final factor.
 * @returns The focused credential-removal operation.
 */
export function createRemoveWebAuthnCredentialOperation(
    context: RemoveWebAuthnCredentialPort
): RemoveWebAuthnCredentialOperation {
    const {
        audit,
        now,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
        webAuthnRelyingParty,
    } = context;

    return Object.freeze({
        async removeWebAuthnCredential(identity, input, metadata) {
            const occurredAt = now();
            return await repository.withImmediateTransaction((unit) => {
                const account = activeAccount(
                    unit,
                    identity,
                    occurredAt,
                    sessionIdleDurationMs
                );
                if (account === undefined) return { status: "session-changed" };
                if (account.user.mfaEnabledAt === null) {
                    return { status: "mfa-enrollment-required" };
                }
                if (!mfaIsRecent(account, occurredAt, recentAuthenticationWindowMs)) {
                    return { status: "step-up-required" };
                }
                const credential = unit.findWebAuthnCredentialById(
                    identity.userId,
                    input.credentialId
                );
                if (credential === undefined) return { status: "not-found" };
                const factors = readAccountPossessionFactorSnapshot(
                    unit,
                    identity.userId
                );
                if (!possessionFactorSnapshotIsConsistent(factors)) {
                    throw new MfaAccountStateChangedError();
                }
                if (possessionFactorCount(factors) <= 1) {
                    return { status: "final-factor" };
                }
                const targetIsUsable = credential.rpId === webAuthnRelyingParty?.rpId;
                if (targetIsUsable) {
                    const usableAfterRemoval =
                        factors.confirmedTotpCount +
                        factors.webAuthnCredentials.filter(
                            ({ id, rpId }) =>
                                id !== credential.id &&
                                rpId === webAuthnRelyingParty?.rpId
                        ).length;
                    if (usableAfterRemoval <= 0) {
                        return { status: "final-factor" };
                    }
                }
                const removed = unit.deleteWebAuthnCredential(
                    identity.userId,
                    credential.id
                );
                if (removed === undefined) {
                    throw new MfaAccountStateChangedError();
                }
                audit(unit, {
                    action: "auth.mfa.webauthn.remove",
                    actor: sessionActor(identity),
                    metadata: { method: "webauthn" },
                    occurredAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: credential.id,
                    targetType: "user_webauthn_credential",
                });
                return {
                    credentialId: credential.id,
                    removed: true,
                    status: "removed",
                };
            });
        },
    });
}
