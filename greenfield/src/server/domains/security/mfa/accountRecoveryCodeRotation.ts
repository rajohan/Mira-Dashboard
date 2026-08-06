import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import { sessionActor } from "../authenticationSession.ts";
import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import {
    accountStateError,
    activeAccount,
    currentAccount,
    mfaIsRecent,
    MfaAccountStateChangedError,
    recoveryCodeReadMaximum,
    recoveryCodeSetsMatch,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";

type AccountRecoveryCodeRotationOperation = Pick<
    MfaAccountLifecycleService,
    "rotateRecoveryCodes"
>;

type AccountRecoveryCodeRotationPort = Pick<
    MfaAccountLifecycleContext,
    | "audit"
    | "now"
    | "prepareRecoveryCodeSet"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
>;

/**
 * Creates recent-authenticated recovery-code rotation.
 * @returns Frozen single-operation service fragment.
 */
export function createAccountRecoveryCodeRotationOperation(
    context: AccountRecoveryCodeRotationPort
): AccountRecoveryCodeRotationOperation {
    const {
        audit,
        now,
        prepareRecoveryCodeSet,
        recentAuthenticationWindowMs,
        repository,
        sessionIdleDurationMs,
    } = context;

    return Object.freeze({
        async rotateRecoveryCodes(identity, metadata) {
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
                if (!mfaIsRecent(account, checkedAt, recentAuthenticationWindowMs)) {
                    return { status: "step-up-required" as const };
                }
                const recoveryCodes = reader.listRecoveryCodes(
                    identity.userId,
                    recoveryCodeReadMaximum
                );
                if (recoveryCodes.length > recoveryCodeCount) {
                    return { status: "state-changed" as const };
                }
                return { account, recoveryCodes, status: "ready" as const };
            });
            if (snapshot.status !== "ready") return snapshot;

            const prepared = await prepareRecoveryCodeSet(
                identity.userId,
                metadata.signal
            );
            if ("status" in prepared) return prepared;
            metadata.signal?.throwIfAborted();
            const rotatedAt = now();

            try {
                return repository.withImmediateTransaction((unit) => {
                    const current = currentAccount(
                        unit,
                        identity,
                        snapshot.account,
                        rotatedAt,
                        sessionIdleDurationMs
                    );
                    if (current.user.mfaEnabledAt === null) {
                        return { status: "mfa-enrollment-required" as const };
                    }
                    if (!mfaIsRecent(current, rotatedAt, recentAuthenticationWindowMs)) {
                        return { status: "step-up-required" as const };
                    }
                    const currentCodes = unit.listRecoveryCodes(
                        identity.userId,
                        recoveryCodeReadMaximum
                    );
                    if (!recoveryCodeSetsMatch(currentCodes, snapshot.recoveryCodes)) {
                        throw new MfaAccountStateChangedError();
                    }
                    unit.deleteRecoveryCodesForUser(identity.userId);
                    for (const recovery of prepared.records) {
                        unit.insertRecoveryCode({
                            createdAt: rotatedAt,
                            id: recovery.id,
                            selector: recovery.selector,
                            usedAt: null,
                            userId: identity.userId,
                            validatorHash: recovery.validatorHash,
                        });
                    }
                    audit(unit, {
                        action: "auth.mfa.recovery.rotate",
                        actor: sessionActor(identity),
                        occurredAt: rotatedAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: identity.userId,
                        targetType: "user",
                    });
                    return {
                        recoveryCodes: prepared.codes,
                        status: "rotated" as const,
                    };
                });
            } catch (error) {
                return accountStateError(error);
            }
        },
    });
}
