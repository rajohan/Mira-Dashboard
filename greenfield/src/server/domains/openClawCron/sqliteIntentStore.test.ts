import { describe, expect, test } from "bun:test";

import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createSqliteOpenClawCronIntentStore } from "./sqliteIntentStore.ts";

const actor = {
    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "user",
} as const;

describe("SQLite OpenClaw cron intent store", () => {
    test("returns only active expired intents in bounded expiry order", async () => {
        const database = await openFreshMigratedDatabase();
        const generatedIds = [
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a1",
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a2",
            "019fc968-1a9b-7775-8f1b-d5b863b0e7a3",
        ];
        const store = createSqliteOpenClawCronIntentStore(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            () => {
                const id = generatedIds.shift();
                if (id === undefined) throw new Error("Test id budget exhausted");
                return id;
            }
        );

        try {
            await store.replaceActive({
                actor,
                expiresAtMs: 900,
                externalJobId: "later-expired",
                reason: "Maintenance",
                recordedAtMs: 100,
            });
            const earlier = await store.replaceActive({
                actor,
                expiresAtMs: 800,
                externalJobId: "earlier-expired",
                reason: "Maintenance",
                recordedAtMs: 100,
            });
            await store.replaceActive({
                actor,
                expiresAtMs: 2000,
                externalJobId: "future",
                reason: "Maintenance",
                recordedAtMs: 100,
            });

            expect(await store.listExpired(1000, 1)).toEqual([
                {
                    expiresAtMs: 800,
                    externalJobId: "earlier-expired",
                    revision: earlier.revision,
                },
            ]);
            expect(
                await store.closeActive({
                    actor: { id: "expiry-reconciler", kind: "system" },
                    atMs: 1000,
                    expectedRevision: earlier.revision,
                    externalJobId: "earlier-expired",
                    reason: "expired",
                })
            ).toBeTrue();
            expect(await store.listExpired(1000, 10)).toMatchObject([
                { externalJobId: "later-expired" },
            ]);
        } finally {
            database.sqlite.close(true);
        }
    });
});
