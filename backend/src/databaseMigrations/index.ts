import { initialSchemaMigration } from "./0001InitialSchema.ts";
import { lifecycleIndexesMigration } from "./0002LifecycleIndexes.ts";
import { sessionValidatorHashMigration } from "./0003SessionValidatorHash.ts";
import type { DatabaseMigration } from "./types.ts";

export const databaseMigrations: readonly DatabaseMigration[] = [
    initialSchemaMigration,
    lifecycleIndexesMigration,
    sessionValidatorHashMigration,
];

export type { DatabaseMigration } from "./types.ts";
