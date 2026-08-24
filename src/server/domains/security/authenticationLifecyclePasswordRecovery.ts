import { addMinutes } from "date-fns";

import { parseOpaqueToken, verifyOpaqueToken } from "../../shared/opaqueToken.ts";
import type { AuthenticationLifecycleContext } from "./authenticationLifecycleContext.ts";
import type { AuthenticationLifecycleService } from "./authenticationLifecycleTypes.ts";
import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
} from "./authenticationRateLimit.ts";

type RecoveryContext = Pick<
    AuthenticationLifecycleContext,
    | "anonymousActor"
    | "audit"
    | "generatePasswordResetToken"
    | "hashPassword"
    | "now"
    | "passwordRecoveryEmailSender"
    | "passwordResetRateLimitTargets"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "publicOrigin"
    | "repository"
>;

function isUniqueEmailConstraintFailure(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        error.code === "SQLITE_CONSTRAINT_UNIQUE"
    );
}

/**
 * Creates enumeration-safe email request and single-use password-reset operations.
 * @returns Password-recovery lifecycle operations.
 */
export function createAuthenticationPasswordRecoveryOperations(
    context: RecoveryContext
): Pick<
    AuthenticationLifecycleService,
    "requestPasswordReset" | "resetPassword" | "verifyEmail"
> &
    Readonly<{ drainPasswordResetDeliveries: () => Promise<void> }> {
    const passwordResetDeliveryTails = new Map<string, Promise<void>>();

    async function serializePasswordResetDelivery(
        userId: string,
        operation: () => Promise<void>
    ): Promise<void> {
        const previous = passwordResetDeliveryTails.get(userId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        passwordResetDeliveryTails.set(userId, tail);
        await previous;
        try {
            await operation();
        } finally {
            release();
            if (passwordResetDeliveryTails.get(userId) === tail) {
                passwordResetDeliveryTails.delete(userId);
            }
        }
    }

    return {
        async drainPasswordResetDeliveries() {
            while (passwordResetDeliveryTails.size > 0) {
                await Promise.all(passwordResetDeliveryTails.values());
            }
        },

        async requestPasswordReset(input, metadata) {
            if (
                context.passwordRecoveryEmailSender === undefined ||
                context.publicOrigin === undefined
            ) {
                return { status: "service-unavailable" };
            }
            const checkedAt = context.now();
            const targets = context.passwordResetRateLimitTargets(
                metadata.clientSourceId
            );
            const active = activeRateLimitForTargets(
                context.repository,
                targets,
                checkedAt
            );
            if (active !== undefined) return { ...active, status: "rate-limited" };

            const prepared = await context.repository.withImmediateTransaction((unit) => {
                const recorded = recordAuthenticationFailures(unit, targets, checkedAt);
                if (recorded.retryAfterSeconds !== undefined) {
                    return { ...recorded, status: "rate-limited" } as const;
                }
                const user = unit.findUserByUsername(input.username);
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    user.emailVerifiedAt === null
                ) {
                    return { ...recorded, status: "accepted" } as const;
                }
                context.audit(unit, {
                    action: "auth.password.reset.request",
                    actor: context.anonymousActor,
                    metadata: {},
                    occurredAt: checkedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: user.id,
                    targetType: "user",
                });
                return {
                    ...recorded,
                    status: "deliver" as const,
                    user,
                };
            });
            if (prepared.status === "rate-limited") {
                return {
                    retryAfterSeconds:
                        prepared.retryAfterSeconds ??
                        saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited",
                };
            }
            if (prepared.status === "accepted") return { status: "accepted" };

            void serializePasswordResetDelivery(prepared.user.id, async () => {
                const token = context.generatePasswordResetToken();
                const previousTokenPrefix =
                    await context.repository.withImmediateTransaction((unit) => {
                        const currentUser = unit.findUserById(prepared.user.id);
                        if (
                            currentUser === undefined ||
                            currentUser.disabledAt !== null ||
                            currentUser.authenticationVersion !==
                                prepared.user.authenticationVersion ||
                            currentUser.email !== prepared.user.email ||
                            currentUser.emailVerifiedAt === null
                        ) {
                            return;
                        }
                        const previousToken = unit.findPasswordResetTokenForUserPurpose(
                            currentUser.id,
                            "password-reset"
                        );
                        unit.insertPasswordResetToken({
                            authenticationVersion: currentUser.authenticationVersion,
                            createdAt: checkedAt,
                            expiresAt: addMinutes(checkedAt, 15),
                            pendingEmail: null,
                            prefix: token.prefix,
                            purpose: "password-reset",
                            userId: currentUser.id,
                            validatorHash: token.validatorHash,
                            validatorVersion: token.validatorVersion,
                        });
                        return previousToken?.prefix ?? null;
                    });
                if (previousTokenPrefix === undefined) return;
                const resetUrl = new URL("/login", context.publicOrigin);
                resetUrl.searchParams.set("resetToken", token.token);
                try {
                    await context.passwordRecoveryEmailSender!.send({
                        idempotencyKey: `password-reset/${token.prefix}`,
                        resetUrl: resetUrl.href,
                        to: prepared.user.email,
                    });
                    if (previousTokenPrefix !== null) {
                        await context.repository.withImmediateTransaction((unit) => {
                            unit.deletePasswordResetToken(previousTokenPrefix);
                        });
                    }
                } catch {
                    await context.repository.withImmediateTransaction((unit) => {
                        unit.deletePasswordResetToken(token.prefix);
                    });
                }
            }).catch(() => {});
            return { status: "accepted" };
        },

        async resetPassword(input, metadata) {
            const admission = await context.passwordWorkGate.run(async () => {
                const parsed = parseOpaqueToken(input.token, "password-reset");
                if (parsed === undefined) return { status: "invalid-token" } as const;
                const checkedAt = context.now();
                const record = context.repository.findPasswordResetToken(parsed.prefix);
                if (
                    record === undefined ||
                    record.purpose !== "password-reset" ||
                    +record.expiresAt <= +checkedAt ||
                    !verifyOpaqueToken(parsed, record.validatorHash)
                ) {
                    return { status: "invalid-token" } as const;
                }
                const budget = context.passwordWorkBudget.consume();
                if (!budget.accepted) {
                    return {
                        retryAfterSeconds: budget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const passwordHash = await context.hashPassword(input.password);
                metadata.signal?.throwIfAborted();
                const changedAt = context.now();
                return context.repository.withImmediateTransaction((unit) => {
                    const currentRecord = unit.findPasswordResetToken(parsed.prefix);
                    const user = unit.findUserById(record.userId);
                    if (
                        currentRecord === undefined ||
                        currentRecord.purpose !== "password-reset" ||
                        user === undefined ||
                        user.disabledAt !== null ||
                        +currentRecord.expiresAt <= +changedAt ||
                        currentRecord.authenticationVersion !==
                            user.authenticationVersion ||
                        !verifyOpaqueToken(parsed, currentRecord.validatorHash)
                    ) {
                        return { status: "invalid-token" } as const;
                    }
                    const updated = unit.resetUserPassword({
                        expectedAuthenticationVersion: user.authenticationVersion,
                        expectedMfaEnabledAt: user.mfaEnabledAt,
                        expectedPasswordHash: user.passwordHash,
                        passwordHash,
                        resetMfa: false,
                        updatedAt: changedAt,
                        userId: user.id,
                    });
                    if (updated === undefined)
                        return { status: "invalid-token" } as const;
                    unit.deleteAllSessions(user.id);
                    unit.deletePendingLoginsForUser(user.id);
                    unit.deletePasswordResetTokensForUser(user.id);
                    context.audit(unit, {
                        action: "auth.password.reset",
                        actor: context.anonymousActor,
                        metadata: {},
                        occurredAt: changedAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: user.id,
                        targetType: "user",
                    });
                    return { status: "reset" } as const;
                });
            }, metadata.signal);
            return admission.accepted
                ? admission.value
                : {
                      retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                      status: "rate-limited",
                  };
        },

        async verifyEmail(input, metadata) {
            const parsed = parseOpaqueToken(input.token, "email-verification");
            if (parsed === undefined) return { status: "invalid-token" };
            const verifiedAt = context.now();
            return context.repository.withImmediateTransaction((unit) => {
                const record = unit.findPasswordResetToken(parsed.prefix);
                if (
                    record === undefined ||
                    record.purpose !== "email-verification" ||
                    record.pendingEmail === null ||
                    +record.expiresAt <= +verifiedAt ||
                    !verifyOpaqueToken(parsed, record.validatorHash)
                ) {
                    return { status: "invalid-token" } as const;
                }
                const user = unit.findUserById(record.userId);
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    user.authenticationVersion !== record.authenticationVersion
                ) {
                    return { status: "invalid-token" } as const;
                }
                let changed;
                try {
                    changed = unit.updateUserEmail({
                        email: record.pendingEmail,
                        emailVerifiedAt: verifiedAt,
                        expectedAuthenticationVersion: user.authenticationVersion,
                        expectedEmail: user.email,
                        updatedAt: verifiedAt,
                        userId: user.id,
                    });
                } catch (error) {
                    if (isUniqueEmailConstraintFailure(error)) {
                        return { status: "conflict" } as const;
                    }
                    throw error;
                }
                if (changed === undefined) return { status: "invalid-token" } as const;
                unit.deletePasswordResetTokensForUserPurpose(
                    user.id,
                    "email-verification"
                );
                unit.deletePasswordResetTokensForUserPurpose(user.id, "password-reset");
                context.audit(unit, {
                    action: "auth.email.verify",
                    actor: context.anonymousActor,
                    occurredAt: verifiedAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: user.id,
                    targetType: "user",
                });
                return { email: changed.email, status: "verified" } as const;
            });
        },
    };
}
