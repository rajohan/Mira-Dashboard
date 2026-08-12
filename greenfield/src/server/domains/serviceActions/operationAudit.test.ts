import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createSqliteServiceActionAuditWriter } from "./operationAudit.ts";

describe("service action operation audit", () => {
    test("persists only fixed action, run identity, and classified settlement", async () => {
        const database = await openFreshMigratedDatabase();
        const ids = [
            "019ff1c6-1a9b-7775-8f1b-d5b863b0e7a1",
            "019ff1c6-1a9b-7775-8f1b-d5b863b0e7a2",
        ];
        const writer = createSqliteServiceActionAuditWriter({
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
            actionId: "system-update",
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "user",
            },
            requestId: "request-1",
        } as const;

        try {
            await writer.record({ ...context, settlement: "attempted" });
            await writer.record({
                ...context,
                jobRunId: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b5",
                settlement: "succeeded",
            });
            const rows = database.orm
                .select()
                .from(auditEvents)
                .orderBy(asc(auditEvents.id))
                .all();

            expect(rows).toMatchObject([
                {
                    action: "service-actions.system-update.request",
                    metadataJson: '{"settlement":"attempted"}',
                    outcome: "attempted",
                    requestId: "request-1",
                    targetId: "system-update",
                    targetType: "service-action",
                },
                {
                    action: "service-actions.system-update.request",
                    metadataJson: '{"settlement":"succeeded"}',
                    outcome: "succeeded",
                    targetId: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b5",
                    targetType: "job-run",
                },
            ]);
            expect(JSON.stringify(rows)).not.toContain("apt-get");
        } finally {
            database.sqlite.close(true);
        }
    });
});
