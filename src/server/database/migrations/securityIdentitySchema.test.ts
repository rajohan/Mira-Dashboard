import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

interface QueryPlanRow {
    detail: string;
}

interface TableListRow {
    name: string;
    strict: number;
}

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const passwordHash =
    "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaGVkLXZhbGlkYXRvci1ieXRlcw";

function insertUser(database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>) {
    database.sqlite.run(
        `INSERT INTO users (
            created_at,
            id,
            password_hash,
            updated_at,
            username
        ) VALUES (1000, ?, ?, 1000, 'raymond')`,
        [userId, passwordHash]
    );
}

function insertAutomationPrincipal(
    database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>
) {
    database.sqlite.run(`
        INSERT INTO automation_principals (
            created_at,
            id,
            label,
            updated_at
        ) VALUES (1000, 'openclaw-task-tracking', 'OpenClaw task tracking', 1000)
    `);
}

describe("security identity schema", () => {
    test("creates every security-core table as STRICT", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const strictByTable = new Map(
                database.sqlite
                    .query<TableListRow, []>("PRAGMA table_list")
                    .all()
                    .map((row) => [row.name, row.strict])
            );

            for (const table of [
                "audit_events",
                "auth_sessions",
                "automation_credentials",
                "automation_principal_capabilities",
                "automation_principals",
                "users",
            ]) {
                expect(strictByTable.get(table)).toBe(1);
            }
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces canonical users, session versions, and unique validators", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertUser(database);
            database.sqlite.run(`
                INSERT INTO auth_sessions (
                    authenticated_at,
                    authentication_version,
                    auth_method,
                    created_at,
                    expires_at,
                    id,
                    last_seen_at,
                    user_id,
                    validator_hash
                ) VALUES (1000, 1, 'password', 1000, 5000, '${"a".repeat(32)}', 1000, '${userId}', '${"b".repeat(64)}')
            `);

            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (1000, ?, ?, 1000, 'invalid-uuid')`,
                    ["019fc968-1a9b-4773-bf1b-d5b863b0e7b4", passwordHash]
                )
            ).toThrow("users_id_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (1000, ?, ?, 1000, 'nul-uuid')`,
                    [`${userId}\0`, passwordHash]
                )
            ).toThrow("users_id_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (1000, ?, ?, 1000, 'raymond')`,
                    ["019fc968-1a9b-7773-bf1b-d5b863b0e7b4", passwordHash]
                )
            ).toThrow("UNIQUE constraint failed: users.username");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (1000, ?, ?, 1000, ?)`,
                    ["019fc968-1a9b-7775-bf1b-d5b863b0e7b4", passwordHash, "ray\0admin"]
                )
            ).toThrow("users_username_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO auth_sessions (
                        authenticated_at,
                        authentication_version,
                        auth_method,
                        created_at,
                        expires_at,
                        id,
                        last_seen_at,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 0, 'password', 1000, 5000, '${"c".repeat(32)}', 1000, '${userId}', '${"d".repeat(64)}')
                `)
            ).toThrow("auth_sessions_authentication_version_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO auth_sessions (
                        authenticated_at,
                        authentication_version,
                        auth_method,
                        created_at,
                        expires_at,
                        id,
                        last_seen_at,
                        user_agent,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 1, 'password', 1000, 5000, '${"f".repeat(32)}', 1000, char(9), '${userId}', '${"e".repeat(64)}')
                `)
            ).toThrow("auth_sessions_user_agent_check");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (8640000000000001, ?, ?, 8640000000000001, 'future-user')`,
                    ["019fc968-1a9b-7777-bf1b-d5b863b0e7b4", passwordHash]
                )
            ).toThrow("users_created_at_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO auth_sessions (
                        authenticated_at,
                        authentication_version,
                        auth_method,
                        created_at,
                        expires_at,
                        id,
                        last_seen_at,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 1, 'password', 1000, 5000, '${"e".repeat(32)}', 1000, '${userId}', '${"b".repeat(64)}')
                `)
            ).toThrow("UNIQUE constraint failed: auth_sessions.validator_hash");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("closes automation capabilities and constrains credential lifecycle", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertAutomationPrincipal(database);
            database.sqlite.run(`
                INSERT INTO automation_principal_capabilities (
                    capability,
                    granted_at,
                    principal_id
                ) VALUES ('notifications:read', 1000, 'openclaw-task-tracking')
            `);
            database.sqlite.run(`
                INSERT INTO automation_credentials (
                    created_at,
                    expires_at,
                    id,
                    label,
                    last_used_at,
                    prefix,
                    principal_id,
                    validator_hash
                ) VALUES (
                    1000,
                    5000,
                    '019fc968-1a9b-7771-9f1b-d5b863b0e7b4',
                    'Primary credential',
                    2000,
                    '${"c".repeat(32)}',
                    'openclaw-task-tracking',
                    '${"d".repeat(64)}'
                )
            `);

            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_principal_capabilities (
                        capability,
                        granted_at,
                        principal_id
                    ) VALUES ('root:everything', 1000, 'openclaw-task-tracking')
                `)
            ).toThrow("automation_principal_capabilities_capability_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_principals (
                        created_at,
                        id,
                        label,
                        updated_at
                    ) VALUES (1000, 'blank-label', char(10), 1000)
                `)
            ).toThrow("automation_principals_label_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_credentials (
                        created_at,
                        id,
                        label,
                        prefix,
                        principal_id,
                        validator_hash
                    ) VALUES (
                        1000,
                        '019fc968-1a9b-7778-8f1b-d5b863b0e7b4',
                        char(12288),
                        '${"1".repeat(32)}',
                        'openclaw-task-tracking',
                        '${"2".repeat(64)}'
                    )
                `)
            ).toThrow("automation_credentials_label_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_principal_capabilities (
                        capability,
                        granted_at,
                        principal_id
                    ) VALUES ('reports:read', 8640000000000001, 'openclaw-task-tracking')
                `)
            ).toThrow("automation_principal_capabilities_granted_at_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_credentials (
                        created_at,
                        expires_at,
                        id,
                        label,
                        prefix,
                        principal_id,
                        validator_hash
                    ) VALUES (
                        1000,
                        5000,
                        '019fc968-1a9b-4774-8f1b-d5b863b0e7b4',
                        'Invalid identifier',
                        '${"e".repeat(32)}',
                        'openclaw-task-tracking',
                        '${"f".repeat(64)}'
                    )
                `)
            ).toThrow("automation_credentials_id_check");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_credentials (
                        created_at,
                        expires_at,
                        id,
                        label,
                        last_used_at,
                        prefix,
                        principal_id,
                        validator_hash
                    ) VALUES (
                        1000,
                        5000,
                        '019fc968-1a9b-7774-8f1b-d5b863b0e7b4',
                        'Invalid credential',
                        5000,
                        '${"e".repeat(32)}',
                        'openclaw-task-tracking',
                        '${"f".repeat(64)}'
                    )
                `)
            ).toThrow("automation_credentials_time_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("supports session administration and credential lookup indexes", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const sessionPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM auth_sessions
                    WHERE user_id = ?
                    ORDER BY last_seen_at DESC, created_at DESC, id DESC
                    LIMIT 100
                `)
                .all(userId);
            const credentialPlan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM automation_credentials
                    WHERE prefix = ?
                `)
                .all("c".repeat(32));

            expect(
                sessionPlan.some((row) =>
                    row.detail.includes("auth_sessions_user_last_seen_idx")
                )
            ).toBeTrue();
            expect(
                credentialPlan.some((row) =>
                    row.detail.includes("automation_credentials_prefix_unique")
                )
            ).toBeTrue();
        } finally {
            database.sqlite.close(true);
        }
    });
});
