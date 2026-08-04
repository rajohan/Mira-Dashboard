import { defineConfig } from "drizzle-kit";

export default defineConfig({
    breakpoints: true,
    dbCredentials: {
        url: "./data/drizzle-kit.db",
    },
    dialect: "sqlite",
    out: "./migrations",
    schema: "./src/server/database/schema/drizzleSchema.ts",
    strict: true,
    verbose: true,
});
