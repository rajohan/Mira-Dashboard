import { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../../test/support/securityPassword.ts";

export const securityIdentityUserId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
export const securityIdentityPasswordHash = testDashboardPasswordHash;

export type SecurityIdentityTestDatabase = Awaited<
    ReturnType<typeof openFreshMigratedDatabase>
>;

export function insertSecurityIdentityUser(database: SecurityIdentityTestDatabase): void {
    database.sqlite.run(
        `INSERT INTO users (
            created_at,
            id,
            password_hash,
            updated_at,
            username
        ) VALUES (1000, ?, ?, 1000, 'raymond')`,
        [securityIdentityUserId, securityIdentityPasswordHash]
    );
}

export function insertAutomationPrincipal(database: SecurityIdentityTestDatabase): void {
    database.sqlite.run(`
        INSERT INTO automation_principals (
            created_at,
            id,
            label,
            updated_at
        ) VALUES (1000, 'openclaw-task-tracking', 'OpenClaw task tracking', 1000)
    `);
}
