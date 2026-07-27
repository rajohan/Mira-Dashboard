import { databaseMigrations } from "./databaseMigrations/index.ts";

const CURRENT_DATABASE_SCHEMA_VERSION = databaseMigrations.at(-1)?.version ?? 0;

/**
 * Keep this range explicit. An expand migration may widen the maximum before
 * the migration ships; a contract migration must narrow it only after the
 * previous release has left the rollback window.
 */
export const DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY = Object.freeze({
    maximum: 7,
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
