import { initialSchemaMigration } from "./0001InitialSchema.ts";
import { lifecycleIndexesMigration } from "./0002LifecycleIndexes.ts";
import { sessionValidatorHashMigration } from "./0003SessionValidatorHash.ts";
import { maintenanceCoverageMigration } from "./0004MaintenanceCoverage.ts";
import { auditEventsMigration } from "./0005AuditEvents.ts";
import { multiFactorAuthenticationMigration } from "./0006MultiFactorAuthentication.ts";
import type { DatabaseMigration } from "./types.ts";

export const databaseMigrations: readonly DatabaseMigration[] = [
    initialSchemaMigration,
    lifecycleIndexesMigration,
    sessionValidatorHashMigration,
    maintenanceCoverageMigration,
    auditEventsMigration,
    multiFactorAuthenticationMigration,
];

export interface DatabaseMigrationIdentity {
    checksum: string;
    name: string;
    version: number;
}

export function databaseMigrationIdentity(
    migration: DatabaseMigration
): DatabaseMigrationIdentity {
    return {
        checksum: new Bun.CryptoHasher("sha256")
            .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
            .digest("hex"),
        name: migration.name,
        version: migration.version,
    };
}

export function databaseMigrationIdentities(): DatabaseMigrationIdentity[] {
    return databaseMigrations.map((migration) => databaseMigrationIdentity(migration));
}

export type { DatabaseMigration } from "./types.ts";
