import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import {
    createSqliteOpenClawSettingsOperationAuditWriter,
    openClawSettingsAuditTargetFingerprint,
} from "./operationAudit.ts";

describe("OpenClaw settings operation audit", () => {
    test("persists only sanitized settlement and a domain-separated target fingerprint", async () => {
        const database = await openFreshMigratedDatabase();
        const ids = [
            "019ff1c6-1a9b-7775-8f1b-d5b863b0e7a1",
            "019ff1c6-1a9b-7775-8f1b-d5b863b0e7a2",
        ];
        const writer = createSqliteOpenClawSettingsOperationAuditWriter({
            clock: () => new Date(1000),
            database: database.orm,
            generateId: () => {
                const id = ids.shift();
                if (id === undefined) throw new Error("Audit id budget exhausted");
                return id;
            },
            writeAdmission: testImmediateDatabaseWriteAdmission,
        });
        const privateSkillKey = "private-skill-key";
        const context = {
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "user",
            },
            operation: "set-skill-enabled",
            requestId: "request-1",
            targetId: `skill:${privateSkillKey}`,
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
                    action: "openclaw.settings.set-skill-enabled",
                    metadataJson: '{"settlement":"attempted"}',
                    outcome: "attempted",
                    requestId: "request-1",
                    targetId: openClawSettingsAuditTargetFingerprint(
                        `skill:${privateSkillKey}`
                    ),
                    targetType: "openclaw-settings-control",
                },
                {
                    action: "openclaw.settings.set-skill-enabled",
                    metadataJson: '{"settlement":"partial"}',
                    outcome: "failed",
                },
            ]);
            expect(JSON.stringify(rows)).not.toContain(privateSkillKey);
        } finally {
            database.sqlite.close(true);
        }
    });
});
