import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { npmVersion as drizzleOrmVersion } from "drizzle-orm/version";

import { automationCredentials } from "./automationCredentials.ts";
import { automationPrincipals } from "./automationPrincipals.ts";

const supportedDrizzleMetadataVersion = "1.0.0-rc.5";

function assertSupportedDrizzleMetadataVersion(): void {
    if (drizzleOrmVersion !== supportedDrizzleMetadataVersion) {
        throw new Error(
            `Automation schema metadata assertions require Drizzle ${supportedDrizzleMetadataVersion}; review the adapter for ${drizzleOrmVersion}`
        );
    }
}

function indexShape(index: ReturnType<typeof getTableConfig>["indexes"][number]) {
    return {
        columns: index.config.columns.map((column) =>
            "name" in column ? column.name : undefined
        ),
        name: index.config.name,
        partial: index.config.where !== undefined,
        unique: index.config.unique,
    };
}

describe("automation identity Drizzle persistence schema", () => {
    test("declares control-safe principals with active and stable pagination indexes", () => {
        assertSupportedDrizzleMetadataVersion();
        const config = getTableConfig(automationPrincipals);

        expect(config.columns.map((column) => column.name)).toEqual([
            "authorization_version",
            "created_at",
            "disabled_at",
            "id",
            "label",
            "updated_at",
        ]);
        expect(config.checks.map((constraint) => constraint.name).toSorted()).toEqual([
            "automation_principals_authorization_version_check",
            "automation_principals_id_check",
            "automation_principals_label_check",
            "automation_principals_time_check",
        ]);
        expect(config.indexes.map(indexShape)).toEqual([
            {
                columns: ["created_at", "id"],
                name: "automation_principals_created_id_idx",
                partial: false,
                unique: false,
            },
            {
                columns: ["created_at", "id"],
                name: "automation_principals_active_created_id_idx",
                partial: true,
                unique: false,
            },
        ]);
    });

    test("declares staged credential rotation, bounded active lookup, and stable history", () => {
        assertSupportedDrizzleMetadataVersion();
        const config = getTableConfig(automationCredentials);

        expect(config.columns.map((column) => column.name)).toEqual([
            "created_at",
            "expires_at",
            "id",
            "label",
            "prefix",
            "principal_id",
            "replaces_credential_id",
            "revoked_at",
            "validator_hash",
            "validator_version",
        ]);
        expect(config.checks.map((constraint) => constraint.name).toSorted()).toEqual([
            "automation_credentials_id_check",
            "automation_credentials_label_check",
            "automation_credentials_prefix_check",
            "automation_credentials_replacement_check",
            "automation_credentials_time_check",
            "automation_credentials_validator_hash_check",
            "automation_credentials_validator_version_check",
        ]);

        const principalReference = config.foreignKeys.find(
            (foreignKey) => foreignKey.reference().columns[0]?.name === "principal_id"
        );
        const replacementReference = config.foreignKeys.find(
            (foreignKey) =>
                foreignKey.reference().columns[0]?.name === "replaces_credential_id"
        );
        expect(principalReference?.reference().foreignTable).toBe(automationPrincipals);
        expect(principalReference?.onDelete).toBe("cascade");
        expect(replacementReference?.reference().foreignTable).toBe(
            automationCredentials
        );
        expect(replacementReference?.reference().foreignColumns[0]?.name).toBe("id");
        expect(replacementReference?.onDelete).toBe("set null");

        expect(config.indexes.map(indexShape)).toEqual([
            {
                columns: ["principal_id", "created_at", "id"],
                name: "automation_credentials_principal_created_idx",
                partial: false,
                unique: false,
            },
            {
                columns: ["principal_id", "created_at", "id"],
                name: "automation_credentials_active_principal_created_idx",
                partial: true,
                unique: false,
            },
            {
                columns: ["replaces_credential_id"],
                name: "automation_credentials_replacement_idx",
                partial: false,
                unique: false,
            },
            {
                columns: ["replaces_credential_id"],
                name: "automation_credentials_active_replacement_unique",
                partial: true,
                unique: true,
            },
            {
                columns: ["prefix"],
                name: "automation_credentials_prefix_unique",
                partial: false,
                unique: true,
            },
            {
                columns: ["validator_version", "validator_hash"],
                name: "automation_credentials_validator_unique",
                partial: false,
                unique: true,
            },
        ]);
    });
});
