import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createSqliteDeliveryOperationAuditWriter } from "./operationAudit.ts";

describe("Delivery operation audit", () => {
    test("persists redacted attempted, failed, and queued settlements", async () => {
        const database = await openFreshMigratedDatabase();
        const ids = [
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a1",
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a2",
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a3",
        ];
        const writer = createSqliteDeliveryOperationAuditWriter({
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
            operation: "deploy",
            requestId: "request-1",
        } as const;

        try {
            await writer.record({ ...context, settlement: "attempted" });
            await writer.record({ ...context, settlement: "failed" });
            await writer.record({
                ...context,
                jobRunId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
                settlement: "queued",
            });
            const rows = database.orm
                .select()
                .from(auditEvents)
                .orderBy(asc(auditEvents.id))
                .all();

            expect(rows).toMatchObject([
                {
                    action: "delivery.deploy.request",
                    metadataJson: '{"settlement":"attempted"}',
                    outcome: "attempted",
                    requestId: "request-1",
                    targetId: "deploy",
                    targetType: "delivery-operation",
                },
                {
                    action: "delivery.deploy.request",
                    metadataJson: '{"settlement":"failed"}',
                    outcome: "failed",
                    targetId: "deploy",
                    targetType: "delivery-operation",
                },
                {
                    action: "delivery.deploy.request",
                    metadataJson: '{"settlement":"succeeded"}',
                    outcome: "succeeded",
                    targetId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
                    targetType: "job-run",
                },
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });
});
