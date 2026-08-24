import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { schemaMigrations } from "../schema/schemaMigrations.ts";

const migrationRefinements = {
    checksum: (schema: v.StringSchema<undefined>) =>
        v.pipe(
            schema,
            v.regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 checksum.")
        ),
};

const generatedSchemaMigrationSelectSchema = createSelectSchema(
    schemaMigrations,
    migrationRefinements
);

/** Validates immutable migration history rows read from SQLite. */
export const schemaMigrationSelectSchema = v.strictObject(
    generatedSchemaMigrationSelectSchema.entries
);

const generatedSchemaMigrationInsertSchema = createInsertSchema(
    schemaMigrations,
    migrationRefinements
);

/** Validates values before an immutable migration history insert. */
export const schemaMigrationInsertSchema = v.strictObject(
    generatedSchemaMigrationInsertSchema.entries
);
