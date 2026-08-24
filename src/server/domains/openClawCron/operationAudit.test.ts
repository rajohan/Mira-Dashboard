import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import {
    createSqliteOpenClawCronOperationAuditWriter,
    openClawCronAuditTargetFingerprint,
} from "./operationAudit.ts";

describe("OpenClaw cron operation audit", () => {
    test("persists only sanitized settlement and a domain-separated target fingerprint", async () => {
        const database = await openFreshMigratedDatabase();
        const ids = [
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a1",
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a2",
        ];
        const writer = createSqliteOpenClawCronOperationAuditWriter({
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
            operation: "delete",
            requestId: "request-1",
            targetId: "private-nightly-provider-id",
        } as const;

        try {
            await writer.record({ ...context, settlement: "attempted" });
            await writer.record({ ...context, settlement: "partial" });
            const rows = database.orm
                .select()
                .from(auditEvents)
                .orderBy(asc(auditEvents.id))
                .all();

            expect(rows).toMatchObject([
                {
                    action: "openclaw.cron.delete",
                    metadataJson: '{"settlement":"attempted"}',
                    outcome: "attempted",
                    requestId: "request-1",
                    targetId: openClawCronAuditTargetFingerprint(
                        "private-nightly-provider-id"
                    ),
                    targetType: "openclaw-cron-job",
                },
                {
                    action: "openclaw.cron.delete",
                    metadataJson: '{"settlement":"partial"}',
                    outcome: "failed",
                },
            ]);
            expect(JSON.stringify(rows)).not.toContain("private-nightly-provider-id");
        } finally {
            database.sqlite.close(true);
        }
    });
});
