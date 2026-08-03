import { databaseMigrations } from "../databaseMigrations/registry.ts";

const CURRENT_DATABASE_SCHEMA_VERSION = databaseMigrations.at(-1)?.version ?? 0;

/**
 * Runtime schema versions this release can safely open. This is not a promise
 * that migrations are reversible: failed coordinated cutovers restore their
 * pre-cutover snapshot before older code starts, while later manual rollbacks
 * remain bounded by the live schema.
 */
export const DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY = Object.freeze({
    maximum: 9,
    minimum: 6,
    target: CURRENT_DATABASE_SCHEMA_VERSION,
});

interface DatabaseSchemaCompatibility {
    maximum: number;
    minimum: number;
}

if (
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target <
        DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum ||
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target >
        DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum
) {
    throw new Error(
        "Dashboard database schema target is outside the declared release compatibility range"
    );
}

export function isDatabaseSchemaCompatible(
    version: number,
    compatibility: DatabaseSchemaCompatibility = DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY
): boolean {
    return (
        Number.isSafeInteger(version) &&
        version >= compatibility.minimum &&
        version <= compatibility.maximum
    );
}
