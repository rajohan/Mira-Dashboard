import { describe, expect, test } from "bun:test";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { insertAutomationPrincipal } from "./testSupport/securityIdentitySchema.ts";

describe("automation identity schema", () => {
    test("rejects embedded NUL across automation security scalars", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO automation_principals (
                        created_at,
                        id,
                        label,
                        updated_at
                    ) VALUES (1000, ?, 'NUL principal', 1000)`,
                    ["openclaw-task-tracking\0suffix"]
                )
            ).toThrow("automation_principals_id_check");

            insertAutomationPrincipal(database);
            expect(() =>
                database.sqlite.run(
                    "UPDATE automation_principals SET id = ? WHERE id = 'openclaw-task-tracking'",
                    ["openclaw-task-tracking\0suffix"]
                )
            ).toThrow("automation_principals_id_check");

            const insertCredential = `
                INSERT INTO automation_credentials (
                    created_at,
                    id,
                    label,
                    prefix,
                    principal_id,
                    validator_hash
                ) VALUES (1000, ?, 'NUL credential', ?, 'openclaw-task-tracking', ?)
            `;
            expect(() =>
                database.sqlite.run(insertCredential, [
                    "019fc968-1a9b-7776-8f1b-d5b863b0e7b4",
                    `${"e".repeat(32)}\0suffix`,
                    "f".repeat(64),
                ])
            ).toThrow("automation_credentials_prefix_check");
            expect(() =>
                database.sqlite.run(insertCredential, [
                    "019fc968-1a9b-7777-8f1b-d5b863b0e7b4",
                    "1".repeat(32),
                    `${"2".repeat(64)}\0suffix`,
                ])
            ).toThrow("automation_credentials_validator_hash_check");
            const credentialId = "019fc968-1a9b-7778-8f1b-d5b863b0e7b4";
            database.sqlite.run(insertCredential, [
                credentialId,
                "3".repeat(32),
                "4".repeat(64),
            ]);
            expect(() =>
                database.sqlite.run(
                    "UPDATE automation_credentials SET prefix = ? WHERE id = ?",
                    [`${"3".repeat(32)}\0suffix`, credentialId]
                )
            ).toThrow("automation_credentials_prefix_check");
            expect(() =>
                database.sqlite.run(
                    "UPDATE automation_credentials SET validator_hash = ? WHERE id = ?",
                    [`${"4".repeat(64)}\0suffix`, credentialId]
                )
            ).toThrow("automation_credentials_validator_hash_check");
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
});
