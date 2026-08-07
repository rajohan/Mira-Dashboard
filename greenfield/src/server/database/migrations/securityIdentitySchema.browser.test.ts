import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import {
    insertSecurityIdentityUser,
    securityIdentityPasswordHash,
    securityIdentityUserId,
} from "./testSupport/securityIdentitySchema.ts";

describe("browser security identity schema", () => {
    test("enforces canonical users, session versions, and unique validators", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertSecurityIdentityUser(database);
            database.sqlite.run(`
                INSERT INTO auth_sessions (
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
                ) VALUES (1000, 1, 'password', 1000, 5000, '${"a".repeat(32)}', 1000, 1000, '${securityIdentityUserId}', '${"b".repeat(64)}')
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
                    ["019fc968-1a9b-4773-bf1b-d5b863b0e7b4", securityIdentityPasswordHash]
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
                    [`${securityIdentityUserId}\0`, securityIdentityPasswordHash]
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
                    ["019fc968-1a9b-7773-bf1b-d5b863b0e7b4", securityIdentityPasswordHash]
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
                    [
                        "019fc968-1a9b-7775-bf1b-d5b863b0e7b4",
                        securityIdentityPasswordHash,
                        "ray\0admin",
                    ]
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
                        password_verified_at,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 0, 'password', 1000, 5000, '${"c".repeat(32)}', 1000, 1000, '${securityIdentityUserId}', '${"d".repeat(64)}')
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
                        password_verified_at,
                        user_agent,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 1, 'password', 1000, 5000, '${"f".repeat(32)}', 1000, 1000, char(9), '${securityIdentityUserId}', '${"e".repeat(64)}')
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
                    ["019fc968-1a9b-7777-bf1b-d5b863b0e7b4", securityIdentityPasswordHash]
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
                        password_verified_at,
                        user_id,
                        validator_hash
                    ) VALUES (1000, 1, 'password', 1000, 5000, '${"e".repeat(32)}', 1000, 1000, '${securityIdentityUserId}', '${"b".repeat(64)}')
                `)
            ).toThrow("UNIQUE constraint failed: auth_sessions.validator_hash");
        } finally {
            database.sqlite.close(true);
        }
    });
    test("rejects embedded NUL across browser security scalars", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (1000, ?, ?, 1000, 'nul-password')`,
                    [
                        "019fc968-1a9b-7775-8f1b-d5b863b0e7b4",
                        `${securityIdentityPasswordHash}\0suffix`,
                    ]
                )
            ).toThrow("users_password_hash_check");

            insertSecurityIdentityUser(database);
            expect(() =>
                database.sqlite.run("UPDATE users SET password_hash = ? WHERE id = ?", [
                    `${securityIdentityPasswordHash}\0suffix`,
                    securityIdentityUserId,
                ])
            ).toThrow("users_password_hash_check");

            const insertSession = `
                INSERT INTO auth_sessions (
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
                ) VALUES (1000, 1, 'password', 1000, 5000, ?, 1000, 1000, ?, ?)
            `;
            expect(() =>
                database.sqlite.run(insertSession, [
                    `${"a".repeat(32)}\0suffix`,
                    securityIdentityUserId,
                    "b".repeat(64),
                ])
            ).toThrow("auth_sessions_id_check");
            expect(() =>
                database.sqlite.run(insertSession, [
                    "c".repeat(32),
                    securityIdentityUserId,
                    `${"d".repeat(64)}\0suffix`,
                ])
            ).toThrow("auth_sessions_validator_hash_check");
            database.sqlite.run(insertSession, [
                "a".repeat(32),
                securityIdentityUserId,
                "b".repeat(64),
            ]);
            expect(() =>
                database.sqlite.run("UPDATE auth_sessions SET id = ? WHERE id = ?", [
                    `${"a".repeat(32)}\0suffix`,
                    "a".repeat(32),
                ])
            ).toThrow("auth_sessions_id_check");
            expect(() =>
                database.sqlite.run(
                    "UPDATE auth_sessions SET validator_hash = ? WHERE id = ?",
                    [`${"b".repeat(64)}\0suffix`, "a".repeat(32)]
                )
            ).toThrow("auth_sessions_validator_hash_check");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects unreviewed Argon2 parameters on insert and update", async () => {
        const database = await openFreshMigratedDatabase();
        const unreviewedHash = securityIdentityPasswordHash.replace("t=3", "t=9");

        try {
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO users (
                        created_at,
                        id,
                        password_hash,
                        updated_at,
                        username
                    ) VALUES (1000, ?, ?, 1000, 'unsafe-hash')`,
                    ["019fc968-1a9b-7775-8f1b-d5b863b0e7b4", unreviewedHash]
                )
            ).toThrow("users_password_hash_check");

            insertSecurityIdentityUser(database);
            expect(() =>
                database.sqlite.run("UPDATE users SET password_hash = ? WHERE id = ?", [
                    unreviewedHash,
                    securityIdentityUserId,
                ])
            ).toThrow("users_password_hash_check");
        } finally {
            database.sqlite.close(true);
        }
    });
});
