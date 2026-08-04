import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Immutable migration history verified by Dashboard's future migration runner. */
export const schemaMigrations = sqliteTable("schema_migrations", {
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull(),
    checksum: text("checksum").notNull(),
    id: text("id").notNull().primaryKey(),
    releaseId: text("release_id").notNull(),
});
