import { describe, expect, test } from "bun:test";

import { addMinutes } from "date-fns";

import { authChallenges } from "../../database/schema/authChallenges.ts";
import { authPendingLogins } from "../../database/schema/authPendingLogins.ts";
import { authRateLimitBuckets } from "../../database/schema/authRateLimitBuckets.ts";
import { authSessions } from "../../database/schema/authSessions.ts";
import { userRecoveryCodes } from "../../database/schema/userRecoveryCodes.ts";
import { users } from "../../database/schema/users.ts";
import { userTotpFactors } from "../../database/schema/userTotpFactors.ts";
import { userWebAuthnCredentials } from "../../database/schema/userWebAuthnCredentials.ts";
import {
    securityCreatedAt,
    securityUpdatedAt,
    securityUserId,
    validAuthChallengeInsert,
    validAuthPendingLoginInsert,
    validAuthSessionInsert,
    validUserInsert,
    validUserRecoveryCodeInsert,
    validUserTotpFactorInsert,
    validUserWebAuthnCredentialInsert,
} from "../../database/validation/testSupport/securityRows.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../test/support/securityPassword.ts";
import { rateLimitBucketKey } from "./authenticationRateLimit.ts";
import { createHostPasswordRecoveryService } from "./hostPasswordRecovery.ts";
import { createHostPasswordRecoveryRepository } from "./hostPasswordRecoveryRepository.ts";

const resetAt = addMinutes(securityCreatedAt, 10);
const auditId = "019fc968-1a9b-7779-8f1b-d5b863b0e7b4";
const loginChallengeId = "019fc968-1a9b-7778-8f1b-d5b863b0e7b4";
const confirmedTotpFactorId = "019fc968-1a9b-777a-8f1b-d5b863b0e7b4";
const otherSessionId = "d".repeat(32);
const resetPasswordHash = `$argon2id$v=19$m=65536,t=3,p=1$${"C".repeat(42)}E$${"D".repeat(42)}E`;
const competingPasswordHash = `$argon2id$v=19$m=65536,t=3,p=1$${"F".repeat(42)}E$${"G".repeat(42)}E`;

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

const accountPasswordBucket = rateLimitBucketKey("account-password", securityUserId);
const accountMfaBucket = rateLimitBucketKey("account-mfa", securityUserId);
const unrelatedAccountBucket = rateLimitBucketKey("account-password", "unrelated-user");
const loginSourceBucket = rateLimitBucketKey("login-password-source", "source-a");
const loginGlobalBucket = rateLimitBucketKey("login-mfa-global", "all-sources");

function countRows(database: FreshDatabase, table: string): number {
    const row = database.sqlite
        .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
        .get();
    if (row === null) throw new Error("Count query returned no row");
    return row.count;
}

function seedRateLimitBucket(
    database: FreshDatabase,
    kind:
        | "account-mfa"
        | "account-password"
        | "login-mfa-global"
        | "login-password-source",
    bucketKey: string
): void {
    database.orm
        .insert(authRateLimitBuckets)
        .values({
            blockedUntil: addMinutes(securityCreatedAt, 1),
            bucketKey,
            failureCount: 3,
            firstFailedAt: securityCreatedAt,
            kind,
            updatedAt: securityCreatedAt,
        })
        .run();
}

async function createRecoveryFixture() {
    const database = await openFreshMigratedDatabase();
    const repository = createHostPasswordRecoveryRepository(
        database.orm,
        testImmediateDatabaseWriteAdmission
    );

    database.orm
        .insert(users)
        .values({ ...validUserInsert, mfaEnabledAt: securityUpdatedAt })
        .run();
    database.orm.insert(authSessions).values(validAuthSessionInsert).run();
    database.orm
        .insert(authSessions)
        .values({
            ...validAuthSessionInsert,
            id: otherSessionId,
            validatorHash: "e".repeat(64),
        })
        .run();
    database.orm.insert(authPendingLogins).values(validAuthPendingLoginInsert).run();
    database.orm.insert(authChallenges).values(validAuthChallengeInsert).run();
    database.orm
        .insert(authChallenges)
        .values({
            ...validAuthChallengeInsert,
            id: loginChallengeId,
            pendingLoginId: validAuthPendingLoginInsert.id,
            purpose: "login",
            sessionId: null,
        })
        .run();
    database.orm.insert(userTotpFactors).values(validUserTotpFactorInsert).run();
    database.orm
        .insert(userTotpFactors)
        .values({
            ...validUserTotpFactorInsert,
            confirmedAt: securityUpdatedAt,
            id: confirmedTotpFactorId,
            lastUsedStep: 1,
        })
        .run();
    database.orm.insert(userRecoveryCodes).values(validUserRecoveryCodeInsert).run();
    database.orm
        .insert(userWebAuthnCredentials)
        .values(validUserWebAuthnCredentialInsert)
        .run();
    seedRateLimitBucket(database, "account-password", accountPasswordBucket);
    seedRateLimitBucket(database, "account-mfa", accountMfaBucket);
    seedRateLimitBucket(database, "account-password", unrelatedAccountBucket);
    seedRateLimitBucket(database, "login-password-source", loginSourceBucket);
    seedRateLimitBucket(database, "login-mfa-global", loginGlobalBucket);

    return { database, repository };
}

function remainingRateLimitBuckets(database: FreshDatabase): string[] {
    return database.sqlite
        .query<{ bucketKey: string }, []>(
            'SELECT bucket_key AS "bucketKey" FROM auth_rate_limit_buckets ORDER BY bucket_key'
        )
        .all()
        .map(({ bucketKey }) => bucketKey);
}

describe("host password recovery", () => {
    test("prepares before prompting and preserves registered MFA by default", async () => {
        const { database, repository } = await createRecoveryFixture();
        const hashTransactionStates: boolean[] = [];
        const auditTransactionStates: boolean[] = [];
        const service = createHostPasswordRecoveryService({
            generateId: () => {
                auditTransactionStates.push(database.sqlite.inTransaction);
                return auditId;
            },
            hashPassword: () => {
                hashTransactionStates.push(database.sqlite.inTransaction);
                return Promise.resolve(resetPasswordHash);
            },
            now: () => resetAt,
            repository,
        });

        try {
            expect(service.prepare("missing-user")).toBeUndefined();
            const prepared = service.prepare("RAYMOND");
            expect(prepared?.username).toBe("raymond");
            const result = await prepared?.resetPassword({
                password: "new-password",
                resetMfa: false,
            });

            expect(result).toEqual({
                mfaReset: false,
                revokedSessions: 2,
                status: "reset",
                username: "raymond",
            });
            expect(hashTransactionStates).toEqual([false]);
            expect(auditTransactionStates).toEqual([true]);
            expect(repository.findUserByUsername("raymond")).toMatchObject({
                authenticationVersion: 2,
                mfaEnabledAt: securityUpdatedAt,
                passwordHash: resetPasswordHash,
                updatedAt: resetAt,
            });
            expect(countRows(database, "auth_sessions")).toBe(0);
            expect(countRows(database, "auth_pending_logins")).toBe(0);
            expect(countRows(database, "auth_challenges")).toBe(0);
            expect(
                database.sqlite
                    .query<{ confirmed: number }, []>(
                        "SELECT confirmed_at IS NOT NULL AS confirmed FROM user_totp_factors"
                    )
                    .all()
            ).toEqual([{ confirmed: 1 }]);
            expect(countRows(database, "user_webauthn_credentials")).toBe(1);
            expect(countRows(database, "user_recovery_codes")).toBe(1);
            expect(remainingRateLimitBuckets(database)).toEqual(
                [loginGlobalBucket, loginSourceBucket, unrelatedAccountBucket].toSorted()
            );
            expect(
                database.sqlite
                    .query<
                        {
                            action: string;
                            actorId: string;
                            actorKind: string;
                            authenticatorId: string | null;
                            metadataJson: string;
                            outcome: string;
                        },
                        []
                    >(`
                        SELECT
                            action,
                            actor_id AS "actorId",
                            actor_kind AS "actorKind",
                            authenticator_id AS "authenticatorId",
                            metadata_json AS "metadataJson",
                            outcome
                        FROM audit_events
                    `)
                    .get()
            ).toEqual({
                action: "auth.password.reset",
                actorId: "host-recovery-cli",
                actorKind: "system",
                authenticatorId: null,
                metadataJson: '{"mfaReset":false,"revokedSessions":2}',
                outcome: "succeeded",
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("removes every registered factor only for explicit MFA recovery", async () => {
        const { database, repository } = await createRecoveryFixture();
        const service = createHostPasswordRecoveryService({
            generateId: () => auditId,
            hashPassword: () => Promise.resolve(resetPasswordHash),
            now: () => resetAt,
            repository,
        });

        try {
            const result = await service.prepare("raymond")?.resetPassword({
                password: "new-password",
                resetMfa: true,
            });

            expect(result).toMatchObject({ mfaReset: true, status: "reset" });
            expect(repository.findUserByUsername("raymond")).toMatchObject({
                authenticationVersion: 2,
                mfaEnabledAt: null,
                passwordHash: resetPasswordHash,
            });
            expect(countRows(database, "user_totp_factors")).toBe(0);
            expect(countRows(database, "user_webauthn_credentials")).toBe(0);
            expect(countRows(database, "user_recovery_codes")).toBe(0);
            expect(
                database.sqlite
                    .query<{ metadataJson: string }, []>(
                        'SELECT metadata_json AS "metadataJson" FROM audit_events'
                    )
                    .get()?.metadataJson
            ).toBe('{"mfaReset":true,"revokedSessions":2}');
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects a prepared snapshot changed while hashing without cleanup", async () => {
        const { database, repository } = await createRecoveryFixture();
        const service = createHostPasswordRecoveryService({
            generateId: () => auditId,
            hashPassword: () => {
                database.sqlite
                    .query(
                        `UPDATE users
                         SET authentication_version = authentication_version + 1,
                             password_hash = ?,
                             updated_at = ?
                         WHERE id = ?`
                    )
                    .run(competingPasswordHash, resetAt.getTime(), securityUserId);
                return Promise.resolve(resetPasswordHash);
            },
            now: () => resetAt,
            repository,
        });

        try {
            const result = await service.prepare("raymond")?.resetPassword({
                password: "new-password",
                resetMfa: false,
            });

            expect(result).toEqual({ status: "state-changed" });
            expect(repository.findUserByUsername("raymond")).toMatchObject({
                authenticationVersion: 2,
                passwordHash: competingPasswordHash,
            });
            expect(countRows(database, "auth_sessions")).toBe(2);
            expect(countRows(database, "auth_pending_logins")).toBe(1);
            expect(countRows(database, "auth_challenges")).toBe(2);
            expect(countRows(database, "audit_events")).toBe(0);
            expect(remainingRateLimitBuckets(database)).toHaveLength(5);
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls every mutation back when the audit append fails", async () => {
        const { database, repository } = await createRecoveryFixture();
        const service = createHostPasswordRecoveryService({
            generateId: () => "invalid-audit-id",
            hashPassword: () => Promise.resolve(resetPasswordHash),
            now: () => resetAt,
            repository,
        });

        try {
            const prepared = service.prepare("raymond");
            if (prepared === undefined) throw new Error("Recovery target disappeared");
            expect(
                prepared.resetPassword({
                    password: "new-password",
                    resetMfa: false,
                })
            ).rejects.toThrow();
            expect(repository.findUserByUsername("raymond")).toMatchObject({
                authenticationVersion: 1,
                mfaEnabledAt: securityUpdatedAt,
                passwordHash: testDashboardPasswordHash,
            });
            expect(countRows(database, "auth_sessions")).toBe(2);
            expect(countRows(database, "auth_pending_logins")).toBe(1);
            expect(countRows(database, "auth_challenges")).toBe(2);
            expect(countRows(database, "user_totp_factors")).toBe(2);
            expect(countRows(database, "audit_events")).toBe(0);
            expect(remainingRateLimitBuckets(database)).toHaveLength(5);
        } finally {
            database.sqlite.close(true);
        }
    });
});
