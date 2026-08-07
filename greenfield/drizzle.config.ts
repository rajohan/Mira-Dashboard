import { defineConfig } from "drizzle-kit";

export default defineConfig({
    breakpoints: true,
    dbCredentials: {
        // Drizzle Kit requires a SQLite target even for schema-only commands. Runtime
        // database paths are resolved separately; this ignored path is tooling-only.
        url: "./data/drizzle-kit.db",
    },
    dialect: "sqlite",
    out: "./migrations",
    schema: "./src/server/database/schema/drizzleSchema.ts",
    strict: true,
    verbose: true,
});
