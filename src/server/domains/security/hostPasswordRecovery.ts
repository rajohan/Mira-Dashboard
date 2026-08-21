import * as v from "valibot";

import {
    authPasswordInputSchema,
    authUsernameInputSchema,
} from "../../../contracts/auth.ts";
import { createSecurityAuditEvent } from "./audit.ts";
import { rateLimitBucketKey } from "./authenticationRateLimit.ts";
import type { HostPasswordRecoveryRepository } from "./hostPasswordRecoveryRepository.ts";
import { hashDashboardPassword } from "./password.ts";
import type { SecurityUserRecord } from "./securityPersistenceTypes.ts";

const hostPasswordRecoverySecretSchema = v.strictObject({
    password: authPasswordInputSchema,
    resetMfa: v.boolean(),
});

export interface HostPasswordRecoveryResetInput {
    readonly password: string;
    readonly resetMfa: boolean;
}

export type HostPasswordRecoveryResult =
    | {
          readonly mfaReset: boolean;
          readonly revokedSessions: number;
          readonly status: "reset";
          readonly username: string;
      }
    | { readonly status: "state-changed" };

export interface PreparedHostPasswordRecovery {
    readonly username: string;
    resetPassword(
        input: HostPasswordRecoveryResetInput
    ): Promise<HostPasswordRecoveryResult>;
}

export interface HostPasswordRecoveryService {
    prepare(username: string): PreparedHostPasswordRecovery | undefined;
}

export interface HostPasswordRecoveryDependencies {
    readonly generateId?: () => string;
    readonly hashPassword?: (password: string) => Promise<string>;
    readonly now?: () => Date;
    readonly repository: HostPasswordRecoveryRepository;
}

function recoveryTimestamp(clock: () => Date): Date {
    const timestamp = clock();
    if (!Number.isSafeInteger(timestamp.getTime()) || timestamp.getTime() < 0) {
        throw new RangeError("Host password recovery clock is invalid");
    }
    return timestamp;
}

function activeRecoveryTarget(
    repository: HostPasswordRecoveryRepository,
    username: string
): SecurityUserRecord | undefined {
    const user = repository.findUserByUsername(username);
    return user?.disabledAt === null ? user : undefined;
}

/**
 * Creates a host-only password recovery lifecycle with an opaque prepared snapshot.
 * @returns Frozen preparation service that never exposes persisted password hashes.
 */
export function createHostPasswordRecoveryService(
    dependencies: HostPasswordRecoveryDependencies
): HostPasswordRecoveryService {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const hashPassword = dependencies.hashPassword ?? hashDashboardPassword;
    const clock = dependencies.now ?? (() => new Date());

    return Object.freeze({
        prepare(unvalidatedUsername: string) {
            const username = v.parse(authUsernameInputSchema, unvalidatedUsername);
            const snapshot = activeRecoveryTarget(dependencies.repository, username);
            if (snapshot === undefined) return;

            return Object.freeze({
                async resetPassword(
                    unvalidatedInput: HostPasswordRecoveryResetInput
                ): Promise<HostPasswordRecoveryResult> {
                    const input = v.parse(
                        hostPasswordRecoverySecretSchema,
                        unvalidatedInput
                    );
                    const passwordHash = await hashPassword(input.password);
                    const resetAt = recoveryTimestamp(clock);

                    return dependencies.repository.withImmediateTransaction((unit) => {
                        const user = unit.resetUserPassword({
                            expectedAuthenticationVersion: snapshot.authenticationVersion,
                            expectedMfaEnabledAt: snapshot.mfaEnabledAt,
                            expectedPasswordHash: snapshot.passwordHash,
                            passwordHash,
                            resetMfa: input.resetMfa,
                            updatedAt: resetAt,
                            userId: snapshot.id,
                        });
                        if (user === undefined)
                            return { status: "state-changed" } as const;

                        const revokedSessions = unit.deleteAllSessions(snapshot.id);
                        unit.deletePendingLoginsForUser(snapshot.id);
                        if (input.resetMfa) {
                            unit.deleteTotpFactorsForUser(snapshot.id);
                            unit.deleteWebAuthnCredentialsForUser(snapshot.id);
                            unit.deleteRecoveryCodesForUser(snapshot.id);
                        } else {
                            unit.deletePendingTotpFactorsForUser(snapshot.id);
                        }
                        unit.deleteRateLimitBucket(
                            rateLimitBucketKey("account-password", snapshot.id)
                        );
                        unit.deleteRateLimitBucket(
                            rateLimitBucketKey("account-mfa", snapshot.id)
                        );
                        unit.insertAuditEvent(
                            createSecurityAuditEvent({
                                action: "auth.password.reset",
                                actor: {
                                    authenticatorId: null,
                                    id: "host-recovery-cli",
                                    kind: "system",
                                },
                                id: generateId(),
                                metadata: {
                                    mfaReset: input.resetMfa,
                                    revokedSessions,
                                },
                                occurredAt: resetAt,
                                outcome: "succeeded",
                                targetId: snapshot.id,
                                targetType: "user",
                            })
                        );
                        return {
                            mfaReset: input.resetMfa,
                            revokedSessions,
                            status: "reset" as const,
                            username: user.username,
                        };
                    });
                },
                username: snapshot.username,
            });
        },
    });
}
