import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { applicationCapabilities } from "../../../contracts/security.ts";
import { automationPrincipals } from "./automationPrincipals.ts";
import { timestampMillisecondsCheck } from "./checks.ts";

/** Explicit least-privilege grants for a named automation principal. */
export const automationPrincipalCapabilities = sqliteTable(
    "automation_principal_capabilities",
    {
        capability: text("capability", { enum: applicationCapabilities }).notNull(),
        grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
        principalId: text("principal_id")
            .notNull()
            .references(() => automationPrincipals.id, { onDelete: "cascade" }),
    },
    (table) => [
        check(
            "automation_principal_capabilities_capability_check",
            sql`${table.capability} IN ('agents:read', 'agents:write', 'cache:read', 'cache:write', 'gateway-sessions:read', 'gateway-sessions:write', 'jobs:read', 'jobs:write', 'monitoring:write', 'notifications:read', 'notifications:write', 'reports:read', 'reports:write', 'tasks:read', 'tasks:write')`
        ),
        check(
            "automation_principal_capabilities_granted_at_check",
            timestampMillisecondsCheck(table.grantedAt)
        ),
        primaryKey({
            columns: [table.principalId, table.capability],
            name: "automation_principal_capabilities_pk",
        }),
    ]
);
