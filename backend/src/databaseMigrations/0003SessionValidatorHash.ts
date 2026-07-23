import type { DatabaseMigration } from "./types.ts";

export const sessionValidatorHashMigration: DatabaseMigration = {
    version: 3,
    name: "session-validator-hash",
    sql: `
ALTER TABLE auth_sessions ADD COLUMN validator_hash TEXT;
`,
};
