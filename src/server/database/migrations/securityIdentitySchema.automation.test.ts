import { describe, expect, test } from "bun:test";

import { applicationCapabilities } from "../../../contracts/security.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { insertAutomationPrincipal } from "./testSupport/securityIdentitySchema.ts";

describe("automation identity schema", () => {
    test("rejects embedded NUL and Unicode separators across automation security scalars", async () => {
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
            for (const separator of ["\u2028", "\u2029"]) {
                expect(() =>
                    database.sqlite.run(
                        `INSERT INTO automation_principals (
                            created_at,
                            id,
                            label,
                            updated_at
                        ) VALUES (1000, 'separator-principal', ?, 1000)`,
                        [`Unsafe${separator}label`]
                    )
                ).toThrow("automation_principals_label_check");
            }

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
            const insertCapability = database.sqlite.query<void, [string, number]>(`
                    INSERT INTO automation_principal_capabilities (
                        capability,
                        granted_at,
                        principal_id
                    ) VALUES (?, ?, 'openclaw-task-tracking')
                `);
            for (const [index, capability] of applicationCapabilities.entries()) {
                insertCapability.run(capability, 1000 + index);
            }
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
                    '019fc968-1a9b-7771-9f1b-d5b863b0e7b4',
                    'Primary credential',
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
                    UPDATE automation_principal_capabilities
                    SET granted_at = 8640000000000001
                    WHERE capability = 'reports:read'
                      AND principal_id = 'openclaw-task-tracking'
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
                        prefix,
                        principal_id,
                        revoked_at,
                        validator_hash
                    ) VALUES (
                        1000,
                        5000,
                        '019fc968-1a9b-7774-8f1b-d5b863b0e7b4',
                        'Invalid credential',
                        '${"e".repeat(32)}',
                        'openclaw-task-tracking',
                        999,
                        '${"f".repeat(64)}'
                    )
                `)
            ).toThrow("automation_credentials_time_check");

            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_credentials (
                        created_at,
                        id,
                        label,
                        prefix,
                        principal_id,
                        replaces_credential_id,
                        validator_hash
                    ) VALUES (
                        2000,
                        '019fc968-1a9b-7779-8f1b-d5b863b0e7b4',
                        'Self replacement',
                        '${"5".repeat(32)}',
                        'openclaw-task-tracking',
                        '019fc968-1a9b-7779-8f1b-d5b863b0e7b4',
                        '${"6".repeat(64)}'
                    )
                `)
            ).toThrow("automation_credentials_replacement_check");

            database.sqlite.run(`
                INSERT INTO automation_principals (
                    created_at,
                    id,
                    label,
                    updated_at
                ) VALUES (1000, 'openclaw-daily-brief', 'OpenClaw daily brief', 1000)
            `);
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_credentials (
                        created_at,
                        id,
                        label,
                        prefix,
                        principal_id,
                        replaces_credential_id,
                        validator_hash
                    ) VALUES (
                        2000,
                        '019fc968-1a9b-777c-8f1b-d5b863b0e7b4',
                        'Cross-principal replacement',
                        '${"0".repeat(32)}',
                        'openclaw-daily-brief',
                        '019fc968-1a9b-7771-9f1b-d5b863b0e7b4',
                        '${"1".repeat(64)}'
                    )
                `)
            ).toThrow("automation credential replacement must share principal");

            database.sqlite.run(`
                INSERT INTO automation_credentials (
                    created_at,
                    id,
                    label,
                    prefix,
                    principal_id,
                    replaces_credential_id,
                    validator_hash
                ) VALUES (
                    2000,
                    '019fc968-1a9b-777a-8f1b-d5b863b0e7b4',
                    'Replacement one',
                    '${"7".repeat(32)}',
                    'openclaw-task-tracking',
                    '019fc968-1a9b-7771-9f1b-d5b863b0e7b4',
                    '${"8".repeat(64)}'
                )
            `);
            expect(() =>
                database.sqlite.run(`
                    UPDATE automation_credentials
                    SET principal_id = 'openclaw-daily-brief'
                    WHERE id = '019fc968-1a9b-777a-8f1b-d5b863b0e7b4'
                `)
            ).toThrow("automation credential replacement must share principal");
            expect(() =>
                database.sqlite.run(`
                    UPDATE automation_credentials
                    SET principal_id = 'openclaw-daily-brief'
                    WHERE id = '019fc968-1a9b-7771-9f1b-d5b863b0e7b4'
                `)
            ).toThrow("automation credential predecessor must share principal");
            expect(() =>
                database.sqlite.run(`
                    INSERT INTO automation_credentials (
                        created_at,
                        id,
                        label,
                        prefix,
                        principal_id,
                        replaces_credential_id,
                        validator_hash
                    ) VALUES (
                        2001,
                        '019fc968-1a9b-777b-8f1b-d5b863b0e7b4',
                        'Replacement two',
                        '${"9".repeat(32)}',
                        'openclaw-task-tracking',
                        '019fc968-1a9b-7771-9f1b-d5b863b0e7b4',
                        '${"a".repeat(64)}'
                    )
                `)
            ).toThrow(
                "UNIQUE constraint failed: automation_credentials.replaces_credential_id"
            );
            database.sqlite.run(`
                DELETE FROM automation_credentials
                WHERE id = '019fc968-1a9b-7771-9f1b-d5b863b0e7b4'
            `);
            expect(
                database.sqlite
                    .query<{ replacesCredentialId: string | null }, []>(`
                        SELECT replaces_credential_id AS replacesCredentialId
                        FROM automation_credentials
                        WHERE id = '019fc968-1a9b-777a-8f1b-d5b863b0e7b4'
                    `)
                    .get()
            ).toEqual({ replacesCredentialId: null });
        } finally {
            database.sqlite.close(true);
        }
    });
});
