import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { nonnegativeDateAction } from "../../../shared/dateTime.ts";
import {
    fullCommitShaAction,
    lowercaseSha256Action,
} from "../../../shared/validation.ts";
import { migrationIdAction } from "../migrations/validation.ts";
import { schemaMigrations } from "../schema/schemaMigrations.ts";

const migrationRefinements = {
    appliedAt: (schema: v.DateSchema<undefined>) =>
        v.pipe(
            schema,
            nonnegativeDateAction("Expected a valid nonnegative migration Date.")
        ),
    checksum: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, lowercaseSha256Action()),
    id: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, migrationIdAction("Expected a canonical migration id.")),
    releaseId: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, fullCommitShaAction()),
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
