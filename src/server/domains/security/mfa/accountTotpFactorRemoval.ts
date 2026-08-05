import { sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    activeAccount,
    mfaIsRecent,
    MfaAccountStateChangedError,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";

type RemoveFactorOperation = Pick<MfaAccountLifecycleService, "removeTotpFactor">;

type RemoveFactorPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
>;

/**
 * Removes one confirmed factor while preserving the final-factor invariant.
 * @returns Frozen factor-removal operation.
 */
export function createRemoveTotpFactorOperation(
    context: RemoveFactorPort
): RemoveFactorOperation {
    const {
        audit,
        now,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
    } = context;

    return Object.freeze({
        removeTotpFactor(identity, input, metadata) {
            const occurredAt = now();
            return repository.withImmediateTransaction((unit) => {
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
                const factor = unit.findConfirmedTotpFactor(
                    identity.userId,
                    input.factorId
                );
                if (factor === undefined) return { status: "not-found" };
                if (unit.countConfirmedTotpFactors(identity.userId) <= 1) {
                    return { status: "final-factor" };
                }
                const removed = unit.deleteTotpFactor(identity.userId, factor.id);
                if (removed === undefined || removed.confirmedAt === null) {
                    throw new MfaAccountStateChangedError();
                }
                audit(unit, {
                    action: "auth.mfa.totp.remove",
                    actor: sessionActor(identity),
                    metadata: { method: "totp" },
                    occurredAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: factor.id,
                    targetType: "user_totp_factor",
                });
                return {
                    factorId: factor.id,
                    removed: true,
                    status: "removed",
                };
            });
        },
    });
}
