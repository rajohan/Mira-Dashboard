import {
    activeRateLimitForTargets,
    saturatedAuthenticationRetryAfterSeconds,
} from "../authenticationRateLimit.ts";
import { authenticationDummyPasswordHash } from "../password.ts";
import type { MfaLoginCoordinator } from "./loginCoordinator.ts";
import {
    mfaLoginRateLimitTargets,
    type MfaLoginLifecycleContext,
} from "./loginLifecycleContext.ts";
import type { MfaLoginLifecycleService } from "./loginLifecycleTypes.ts";
import { resolvePendingLogin } from "./loginPendingLifecycle.ts";
import {
    dashboardRecoveryCodeHashInput,
    parseDashboardRecoveryCode,
} from "./recoveryCodes.ts";

type RecoveryLoginOperation = Pick<MfaLoginLifecycleService, "completeRecoveryLogin">;

type RecoveryLoginOperationPort = Pick<
    MfaLoginLifecycleContext,
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "repository"
    | "verifyRecoveryCode"
>;

/**
 * Creates the recovery-code verification pipeline outside the finish transaction.
 * @returns Frozen recovery completion operation.
 */
export function createRecoveryLoginOperation(
    context: RecoveryLoginOperationPort,
    coordinator: MfaLoginCoordinator
): RecoveryLoginOperation {
    const { now, passwordWorkBudget, passwordWorkGate, repository, verifyRecoveryCode } =
        context;

    return Object.freeze({
        async completeRecoveryLogin(credential, input, metadata) {
            const checkedAt = now();
            const targets = mfaLoginRateLimitTargets(metadata.clientSourceId);
            const activeLimit = activeRateLimitForTargets(repository, targets, checkedAt);
            if (activeLimit !== undefined) {
                return { ...activeLimit, status: "rate-limited" as const };
            }
            const parsedCode = parseDashboardRecoveryCode(input.code);
            const snapshot = repository.withReadTransaction((reader) => {
                const resolved = resolvePendingLogin(
                    reader,
                    credential,
                    checkedAt,
                    "recovery"
                );
                const recovery =
                    resolved === undefined || parsedCode === undefined
                        ? undefined
                        : reader.findRecoveryCode(resolved.user.id, parsedCode.selector);
                return { recovery, resolved };
            });
            if (snapshot.resolved === undefined) {
                return coordinator.recordFailure(
                    undefined,
                    credential,
                    metadata,
                    checkedAt,
                    "recovery_pending_invalid"
                );
            }
            const resolved = snapshot.resolved;

            const admission = await passwordWorkGate.run(async () => {
                const admittedAt = now();
                const admittedLimit = activeRateLimitForTargets(
                    repository,
                    targets,
                    admittedAt
                );
                if (admittedLimit !== undefined) {
                    return { ...admittedLimit, status: "rate-limited" as const };
                }
                const budget = passwordWorkBudget.consume();
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited" as const,
                    };
                }
                const hashInput =
                    parsedCode === undefined
                        ? "mira-dashboard:recovery-code:dummy"
                        : dashboardRecoveryCodeHashInput(resolved.user.id, parsedCode);
                const valid = await verifyRecoveryCode(
                    hashInput,
                    snapshot.recovery?.usedAt === null
                        ? snapshot.recovery.validatorHash
                        : authenticationDummyPasswordHash
                );
                metadata.signal?.throwIfAborted();
                if (
                    valid &&
                    snapshot.recovery !== undefined &&
                    snapshot.recovery.usedAt === null
                ) {
                    const verifiedRecovery = snapshot.recovery;
                    const completedAt = now();
                    return coordinator.finishLogin(
                        resolved,
                        credential,
                        "recovery",
                        completedAt,
                        metadata,
                        (unit) =>
                            unit.consumeRecoveryCode({
                                codeId: verifiedRecovery.id,
                                expectedCreatedAt: verifiedRecovery.createdAt,
                                expectedValidatorHash: verifiedRecovery.validatorHash,
                                selector: verifiedRecovery.selector,
                                usedAt: completedAt,
                                userId: resolved.user.id,
                            }) !== undefined
                    );
                }
                return coordinator.recordFailure(
                    resolved,
                    credential,
                    metadata,
                    now(),
                    "recovery_invalid"
                );
            }, metadata.signal);
            if (!admission.accepted) {
                return {
                    retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited" as const,
                };
            }
            return admission.value;
        },
    });
}
