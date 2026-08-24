import { addMilliseconds, compareAsc } from "date-fns";

import type { PendingLoginSummary } from "../../../../contracts/auth.ts";
import type { MultiFactorAuthenticationMethod } from "../../../../contracts/security.ts";
import {
    verifyOpaqueToken,
    type ParsedOpaqueToken,
} from "../../../shared/opaqueToken.ts";
import { pendingLoginLifetimeMs } from "../../../shared/pendingLoginPolicy.ts";
import { browserSessionIsActive } from "../authenticationSession.ts";
import {
    pendingLoginAttemptMaximum,
    type MfaLifecycleReader,
    type MfaPendingLoginRecord,
    type MfaUserRecord,
} from "./lifecycleRepositoryTypes.ts";
import type { MfaLoginLifecycleContext } from "./loginLifecycleContext.ts";
import type { MfaLoginLifecycleService } from "./loginLifecycleTypes.ts";

export interface ResolvedPendingLogin {
    readonly pending: MfaPendingLoginRecord;
    readonly user: MfaUserRecord;
}

type PendingLoginOperations = Pick<
    MfaLoginLifecycleService,
    "beginPendingLogin" | "pendingLoginSummary" | "revokePendingLogin"
>;

type PendingLoginOperationsPort = Pick<
    MfaLoginLifecycleContext,
    "audit" | "generatePendingLoginToken" | "now" | "repository" | "sessionIdleDurationMs"
>;

class PendingLoginStateChangedError extends Error {}

function pendingMethods(
    pending: Pick<MfaPendingLoginRecord, "allowsRecovery" | "allowsTotp">
): MultiFactorAuthenticationMethod[] {
    return [
        ...(pending.allowsRecovery ? (["recovery"] as const) : []),
        ...(pending.allowsTotp ? (["totp"] as const) : []),
    ];
}

export function pendingLoginSummary(
    pending: MfaPendingLoginRecord,
    user: MfaUserRecord
): PendingLoginSummary {
    const methods: PendingLoginSummary["methods"] = pendingMethods(pending);
    Object.freeze(methods);
    return Object.freeze({
        expiresAtMs: pending.expiresAt.getTime(),
        methods,
        username: user.username,
    });
}

export function resolvePendingLogin(
    reader: MfaLifecycleReader,
    credential: ParsedOpaqueToken,
    checkedAt: Date,
    method?: MultiFactorAuthenticationMethod
): ResolvedPendingLogin | undefined {
    const pending = reader.findPendingLogin(credential.prefix);
    const validatorMatches = verifyOpaqueToken(
        credential,
        pending?.validatorHash ?? "0".repeat(64)
    );
    if (
        pending === undefined ||
        !validatorMatches ||
        compareAsc(pending.createdAt, checkedAt) > 0 ||
        compareAsc(pending.expiresAt, checkedAt) <= 0 ||
        pending.attemptCount >= pendingLoginAttemptMaximum ||
        (method === "recovery" && !pending.allowsRecovery) ||
        (method === "totp" && !pending.allowsTotp)
    ) {
        return undefined;
    }
    const user = reader.findUserById(pending.userId);
    if (
        user === undefined ||
        user.disabledAt !== null ||
        user.mfaEnabledAt === null ||
        user.authenticationVersion !== pending.authenticationVersion
    ) {
        return undefined;
    }
    return { pending, user };
}

/**
 * Creates pending-login issuance, inspection, and revocation operations.
 * @returns Frozen pending-login operation group.
 */
export function createPendingLoginOperations(
    context: PendingLoginOperationsPort
): PendingLoginOperations {
    const { audit, generatePendingLoginToken, now, repository, sessionIdleDurationMs } =
        context;

    return Object.freeze({
        beginPendingLogin(input) {
            const pendingToken = generatePendingLoginToken();
            return repository.withImmediateTransaction((unit) => {
                const user = unit.findUserById(input.userSnapshot.id);
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    user.passwordHash !== input.userSnapshot.passwordHash ||
                    user.authenticationVersion !==
                        input.userSnapshot.authenticationVersion ||
                    user.mfaEnabledAt === null ||
                    user.mfaEnabledAt.getTime() !==
                        input.userSnapshot.mfaEnabledAt?.getTime()
                ) {
                    return { status: "identity-changed" } as const;
                }
                const allowsTotp = unit.countConfirmedTotpFactors(user.id) > 0;
                const allowsRecovery = unit.countUnusedRecoveryCodes(user.id) > 0;
                if (!allowsTotp) return { status: "mfa-unavailable" } as const;

                let replacedSessionId: string | null = null;
                if (input.currentIdentity?.userId === user.id) {
                    const currentSession = unit.findSession(
                        user.id,
                        input.currentIdentity.sessionId
                    );
                    if (
                        currentSession !== undefined &&
                        currentSession.authenticationVersion ===
                            user.authenticationVersion &&
                        compareAsc(currentSession.createdAt, input.verifiedAt) <= 0 &&
                        compareAsc(currentSession.lastSeenAt, input.verifiedAt) <= 0 &&
                        currentSession.mfaVerifiedAt !== null &&
                        compareAsc(currentSession.mfaVerifiedAt, user.mfaEnabledAt) >=
                            0 &&
                        browserSessionIsActive(
                            currentSession,
                            input.verifiedAt,
                            sessionIdleDurationMs
                        )
                    ) {
                        replacedSessionId = currentSession.id;
                    }
                }
                unit.deletePendingLoginsForUser(user.id);
                const pending = unit.insertPendingLogin({
                    allowsRecovery,
                    allowsTotp,
                    authenticationVersion: user.authenticationVersion,
                    createdAt: input.verifiedAt,
                    expiresAt: addMilliseconds(input.verifiedAt, pendingLoginLifetimeMs),
                    id: pendingToken.prefix,
                    passwordVerifiedAt: input.verifiedAt,
                    replacedSessionId,
                    userAgent: input.metadata.userAgent ?? null,
                    userId: user.id,
                    validatorHash: pendingToken.validatorHash,
                });
                if (input.clearedPasswordRateLimitBucketKey !== undefined) {
                    unit.deleteRateLimitBucket(input.clearedPasswordRateLimitBucketKey);
                }
                audit(unit, {
                    action: "auth.login",
                    actor: { authenticatorId: null, id: "browser", kind: "anonymous" },
                    metadata: { pendingMfa: true },
                    occurredAt: input.verifiedAt,
                    outcome: "succeeded",
                    requestId: input.metadata.requestId,
                    targetId: pending.id,
                    targetType: "auth_pending_login",
                });
                return {
                    pendingLogin: pendingLoginSummary(pending, user),
                    status: "created" as const,
                    token: pendingToken.token,
                };
            });
        },

        pendingLoginSummary(credential) {
            const checkedAt = now();
            const resolved = repository.withReadTransaction((reader) =>
                resolvePendingLogin(reader, credential, checkedAt)
            );
            return resolved === undefined
                ? undefined
                : pendingLoginSummary(resolved.pending, resolved.user);
        },

        revokePendingLogin(credential, metadata) {
            const occurredAt = now();
            const resolved = repository.withReadTransaction((reader) =>
                resolvePendingLogin(reader, credential, occurredAt)
            );
            if (resolved === undefined) return false;
            try {
                return repository.withImmediateTransaction((unit) => {
                    const removed = unit.deletePendingLogin(
                        resolved.user.id,
                        resolved.pending.id
                    );
                    if (
                        removed === undefined ||
                        !verifyOpaqueToken(credential, removed.validatorHash)
                    ) {
                        throw new PendingLoginStateChangedError();
                    }
                    audit(unit, {
                        action: "auth.pending-login.revoke",
                        actor: {
                            authenticatorId: null,
                            id: "browser",
                            kind: "anonymous",
                        },
                        occurredAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: removed.id,
                        targetType: "auth_pending_login",
                    });
                    return true;
                });
            } catch (error) {
                if (error instanceof PendingLoginStateChangedError) return false;
                throw error;
            }
        },
    });
}
