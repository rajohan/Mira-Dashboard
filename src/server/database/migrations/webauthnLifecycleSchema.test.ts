import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../test/support/securityPassword.ts";

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const sessionId = "a".repeat(32);
const pendingLoginId = "c".repeat(32);
const validChallengeId = "019fc968-1a9b-7790-8f1b-d5b863b0e7b4";
const validCredentialId = "019fc968-1a9b-7791-9f1b-d5b863b0e7b4";
const externalCredentialId = "AdKXJEch1aV5Wo7bj7qLHskVY4OoNaj9qu8TPdJ7kSAgUeRx";

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

interface ChallengeRow {
    readonly authenticationVersion: number;
    readonly challenge: string;
    readonly configFingerprint: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly id: string;
    readonly pendingLoginId: string | null;
    readonly purpose: string;
    readonly sessionId: string | null;
}

interface CredentialRow {
    readonly algorithm: number;
    readonly backedUp: number;
    readonly counter: number;
    readonly createdAt: number;
    readonly credentialId: string;
    readonly deviceType: string;
    readonly id: string;
    readonly label: string;
    readonly lastUsedAt: number | null;
    readonly publicKey: Uint8Array;
    readonly rpId: string;
    readonly transportMask: number;
    readonly userId: string;
}

interface ForeignKeyRow {
    readonly onDelete: string;
    readonly sourceColumn: string;
    readonly targetTable: string;
}

interface IndexRow {
    readonly name: string;
    readonly sql: string | null;
}

interface QueryPlanRow {
    readonly detail: string;
}

interface TableInfoRow {
    readonly name: string;
    readonly notNull: number;
    readonly primaryKeyPosition: number;
}

interface TableListRow {
    readonly name: string;
    readonly strict: number;
}

const validChallenge: ChallengeRow = Object.freeze({
    authenticationVersion: 1,
    challenge: "A".repeat(32),
    configFingerprint: "e".repeat(64),
    createdAt: 2000,
    expiresAt: 302_000,
    id: validChallengeId,
    pendingLoginId: null,
    purpose: "registration",
    sessionId,
});

const validCredential: CredentialRow = Object.freeze({
    algorithm: -7,
    backedUp: 0,
    counter: 0,
    createdAt: 2000,
    credentialId: externalCredentialId,
    deviceType: "singleDevice",
    id: validCredentialId,
    label: "Primary security key",
    lastUsedAt: null,
    publicKey: Buffer.from([165, 1, 2]),
    rpId: "dashboard.example.com",
    transportMask: 64,
    userId,
});

function insertIdentityFixture(database: FreshDatabase): void {
    database.sqlite.run(
        `INSERT INTO users (
            created_at,
            email,
            id,
            password_hash,
            updated_at,
            username
        ) VALUES (1000, lower(hex(randomblob(16))) || '@example.com', ?, ?, 1000, 'raymond')`,
        [userId, testDashboardPasswordHash]
    );
    database.sqlite.run(
        `INSERT INTO auth_sessions (
            authenticated_at,
            authentication_version,
            auth_method,
            created_at,
            expires_at,
            id,
            last_seen_at,
            password_verified_at,
            user_id,
            validator_hash
        ) VALUES (1000, 1, 'password', 1000, 1000000, ?, 1000, 1000, ?, ?)`,
        [sessionId, userId, "b".repeat(64)]
    );
    database.sqlite.run(
        `INSERT INTO auth_pending_logins (
            allows_recovery,
            allows_totp,
            allows_webauthn,
            authentication_version,
            created_at,
            expires_at,
            id,
            password_verified_at,
            replaced_session_id,
            user_id,
            validator_hash
        ) VALUES (0, 0, 1, 1, 2000, 301000, ?, 1000, ?, ?, ?)`,
        [pendingLoginId, sessionId, userId, "d".repeat(64)]
    );
}

function insertChallenge(
    database: FreshDatabase,
    replacements: Partial<ChallengeRow> = {}
): void {
    const row = { ...validChallenge, ...replacements };
    database.sqlite.run(
        `INSERT INTO auth_challenges (
            authentication_version,
            challenge,
            config_fingerprint,
            created_at,
            expires_at,
            id,
            pending_login_id,
            purpose,
            session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.authenticationVersion,
            row.challenge,
            row.configFingerprint,
            row.createdAt,
            row.expiresAt,
            row.id,
            row.pendingLoginId,
            row.purpose,
            row.sessionId,
        ]
    );
}

function insertCredential(
    database: FreshDatabase,
    replacements: Partial<CredentialRow> = {}
): void {
    const row = { ...validCredential, ...replacements };
    database.sqlite.run(
        `INSERT INTO user_webauthn_credentials (
            algorithm,
            backed_up,
            counter,
            created_at,
            credential_id,
            device_type,
            id,
            label,
            last_used_at,
            public_key,
            rp_id,
            transport_mask,
            user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.algorithm,
            row.backedUp,
            row.counter,
            row.createdAt,
            row.credentialId,
            row.deviceType,
            row.id,
            row.label,
            row.lastUsedAt,
            row.publicKey,
            row.rpId,
            row.transportMask,
            row.userId,
        ]
    );
}

describe("WebAuthn lifecycle baseline schema", () => {
    test("creates strict tables, cascading bindings, and lookup indexes", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(
                database.sqlite
                    .query<TableListRow, []>(`
                        SELECT name, strict
                        FROM pragma_table_list
                        WHERE name IN ('auth_challenges', 'user_webauthn_credentials')
                        ORDER BY name
                    `)
                    .all()
            ).toEqual([
                { name: "auth_challenges", strict: 1 },
                { name: "user_webauthn_credentials", strict: 1 },
            ]);

            for (const table of ["auth_challenges", "user_webauthn_credentials"]) {
                expect(
                    database.sqlite
                        .query<TableInfoRow, [string]>(`
                            SELECT
                                name,
                                "notnull" AS "notNull",
                                pk AS "primaryKeyPosition"
                            FROM pragma_table_info(?)
                            WHERE name = 'id'
                        `)
                        .get(table)
                ).toEqual({ name: "id", notNull: 1, primaryKeyPosition: 1 });
            }

            expect(
                database.sqlite
                    .query<ForeignKeyRow, []>(`
                        SELECT
                            "from" AS "sourceColumn",
                            "table" AS "targetTable",
                            on_delete AS "onDelete"
                        FROM pragma_foreign_key_list('auth_challenges')
                        ORDER BY "sourceColumn"
                    `)
                    .all()
            ).toEqual([
                {
                    onDelete: "CASCADE",
                    sourceColumn: "pending_login_id",
                    targetTable: "auth_pending_logins",
                },
                {
                    onDelete: "CASCADE",
                    sourceColumn: "session_id",
                    targetTable: "auth_sessions",
                },
            ]);
            expect(
                database.sqlite
                    .query<ForeignKeyRow, []>(`
                        SELECT
                            "from" AS "sourceColumn",
                            "table" AS "targetTable",
                            on_delete AS "onDelete"
                        FROM pragma_foreign_key_list('user_webauthn_credentials')
                    `)
                    .all()
            ).toEqual([
                {
                    onDelete: "CASCADE",
                    sourceColumn: "user_id",
                    targetTable: "users",
                },
            ]);

            const challengeIndexes = database.sqlite
                .query<IndexRow, []>(`
                    SELECT name, sql
                    FROM sqlite_schema
                    WHERE type = 'index'
                      AND tbl_name = 'auth_challenges'
                      AND sql IS NOT NULL
                    ORDER BY name
                `)
                .all();
            expect(challengeIndexes.map((row) => row.name)).toEqual([
                "auth_challenges_expires_at_idx",
                "auth_challenges_pending_login_purpose_unique",
                "auth_challenges_session_purpose_unique",
            ]);
            expect(
                challengeIndexes
                    .filter((row) => row.name.endsWith("purpose_unique"))
                    .every((row) => row.sql?.toLowerCase().includes("where"))
            ).toBeTrue();

            const queryPlans = [
                database.sqlite
                    .query<QueryPlanRow, [number]>(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM auth_challenges
                        WHERE expires_at <= ?
                        ORDER BY expires_at, id
                    `)
                    .all(302_000),
                database.sqlite
                    .query<QueryPlanRow, [string]>(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM auth_challenges
                        WHERE session_id = ?
                          AND purpose = 'registration'
                    `)
                    .all(sessionId),
                database.sqlite
                    .query<QueryPlanRow, [string]>(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM auth_challenges
                        WHERE pending_login_id = ?
                          AND purpose = 'login'
                    `)
                    .all(pendingLoginId),
                database.sqlite
                    .query<QueryPlanRow, [string]>(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM user_webauthn_credentials
                        WHERE credential_id = ?
                    `)
                    .all(externalCredentialId),
                database.sqlite
                    .query<QueryPlanRow, [string]>(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM user_webauthn_credentials
                        WHERE user_id = ?
                        ORDER BY created_at, id
                    `)
                    .all(userId),
            ].flat();
            const planText = queryPlans.map((row) => row.detail).join("\n");
            expect(planText).toContain("auth_challenges_expires_at_idx");
            expect(planText).toContain("auth_challenges_pending_login_purpose_unique");
            expect(planText).toContain("auth_challenges_session_purpose_unique");
            expect(planText).toContain("user_webauthn_credentials_credential_id_unique");
            expect(planText).toContain("user_webauthn_credentials_user_created_idx");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces challenge encoding, purpose binding, lifetime, and uniqueness", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertIdentityFixture(database);

            for (const [constraint, replacements] of [
                [
                    "auth_challenges_authentication_version_check",
                    { authenticationVersion: 0 },
                ],
                ["auth_challenges_challenge_check", { challenge: "A".repeat(33) }],
                [
                    "auth_challenges_config_fingerprint_check",
                    { configFingerprint: "E".repeat(64) },
                ],
                ["auth_challenges_binding_check", { purpose: "login", sessionId }],
                [
                    "auth_challenges_binding_check",
                    { pendingLoginId, purpose: "registration", sessionId: null },
                ],
                ["auth_challenges_time_check", { expiresAt: 2000 }],
                ["auth_challenges_time_check", { expiresAt: 302_001 }],
            ] satisfies [string, Partial<ChallengeRow>][]) {
                expect(() => insertChallenge(database, replacements)).toThrow(constraint);
            }

            insertChallenge(database);
            expect(() =>
                insertChallenge(database, {
                    id: "019fc968-1a9b-7792-af1b-d5b863b0e7b4",
                })
            ).toThrow("UNIQUE constraint failed");
            insertChallenge(database, {
                id: "019fc968-1a9b-7793-bf1b-d5b863b0e7b4",
                purpose: "step-up",
            });
            insertChallenge(database, {
                id: "019fc968-1a9b-7794-8f1b-d5b863b0e7b4",
                pendingLoginId,
                purpose: "login",
                sessionId: null,
            });
            expect(() =>
                insertChallenge(database, {
                    id: "019fc968-1a9b-7795-9f1b-d5b863b0e7b4",
                    pendingLoginId,
                    purpose: "login",
                    sessionId: null,
                })
            ).toThrow("UNIQUE constraint failed");

            database.sqlite.run("DELETE FROM auth_sessions WHERE id = ?", [sessionId]);
            expect(
                database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM auth_challenges
                    `)
                    .get()
            ).toEqual({ count: 1 });
            database.sqlite.run("DELETE FROM auth_pending_logins WHERE id = ?", [
                pendingLoginId,
            ]);
            expect(
                database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM auth_challenges
                    `)
                    .get()
            ).toEqual({ count: 0 });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces credential bounds, device state, ownership, and global identity", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertIdentityFixture(database);

            for (const [constraint, replacements] of [
                ["user_webauthn_credentials_algorithm_check", { algorithm: -257 }],
                ["user_webauthn_credentials_counter_check", { counter: 4_294_967_296 }],
                [
                    "user_webauthn_credentials_credential_id_check",
                    { credentialId: "A".repeat(9) },
                ],
                ["user_webauthn_credentials_device_state_check", { backedUp: 1 }],
                ["user_webauthn_credentials_label_check", { label: "Unsafe\u0007" }],
                [
                    "user_webauthn_credentials_public_key_check",
                    { publicKey: Buffer.alloc(0) },
                ],
                ["user_webauthn_credentials_rp_id_check", { rpId: " " }],
                ["user_webauthn_credentials_time_check", { lastUsedAt: 1999 }],
                [
                    "user_webauthn_credentials_transport_mask_check",
                    { transportMask: 128 },
                ],
            ] satisfies [string, Partial<CredentialRow>][]) {
                expect(() => insertCredential(database, replacements)).toThrow(
                    constraint
                );
            }

            expect(() =>
                insertCredential(database, {
                    userId: "019fc968-1a9b-7796-af1b-d5b863b0e7b4",
                })
            ).toThrow("FOREIGN KEY constraint failed");
            insertCredential(database);
            expect(() =>
                insertCredential(database, {
                    id: "019fc968-1a9b-7797-bf1b-d5b863b0e7b4",
                })
            ).toThrow("UNIQUE constraint failed");

            database.sqlite.run("DELETE FROM users WHERE id = ?", [userId]);
            expect(
                database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM user_webauthn_credentials
                    `)
                    .get()
            ).toEqual({ count: 0 });
        } finally {
            database.sqlite.close(true);
        }
    });
});
