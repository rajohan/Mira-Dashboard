import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createSqliteLogMaintenanceAuditWriter } from "./operationAudit.ts";

describe("log maintenance operation audit", () => {
    test("persists distinct real and dry-run actions with bounded settlement metadata", async () => {
        const database = await openFreshMigratedDatabase();
        const ids = [
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a1",
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a2",
        ];
        const writer = createSqliteLogMaintenanceAuditWriter({
            clock: () => new Date(1000),
            database: database.orm,
            generateId: () => {
                const id = ids.shift();
                if (id === undefined) throw new Error("Audit id budget exhausted");
                return id;
            },
            writeAdmission: testImmediateDatabaseWriteAdmission,
        });
        const context = {
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "user",
            },
            policyId: "docker-managed",
            requestId: "request-1",
        } as const;

        try {
            await writer.record({
                ...context,
                dryRun: false,
                settlement: "attempted",
            });
            await writer.record({
                ...context,
                dryRun: true,
                settlement: "queued",
            });
            const rows = database.orm
                .select()
                .from(auditEvents)
                .orderBy(asc(auditEvents.id))
                .all();

            expect(rows).toMatchObject([
                {
                    action: "logs.maintenance.request",
                    metadataJson: '{"settlement":"attempted"}',
                    outcome: "attempted",
                    targetId: "docker-managed",
                    targetType: "log-maintenance-policy",
                },
                {
                    action: "logs.maintenance.dry-run.request",
                    metadataJson: '{"settlement":"succeeded"}',
                    outcome: "succeeded",
                },
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });
});
