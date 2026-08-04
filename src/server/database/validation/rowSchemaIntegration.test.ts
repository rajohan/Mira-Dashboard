import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import * as v from "valibot";

import { openFreshMigratedDatabase } from "../migrations/freshDatabaseFixture.ts";
import { incidents } from "../schema/incidents.ts";
import { incidentInsertSchema, incidentSelectSchema } from "./incidents.ts";

describe("Drizzle Valibot database integration", () => {
    test("round-trips a migrated SQLite row through generated schemas", async () => {
        const database = await openFreshMigratedDatabase();
        const id = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
        const observedAt = new Date("2026-08-03T22:00:00.000Z");

        try {
            const insert = v.parse(incidentInsertSchema, {
                detailsJson: '{"mount":"/"}',
                fingerprint: "filesystem:root-pressure",
                firstSeenAt: observedAt,
                id,
                kind: "system",
                lastSeenAt: observedAt,
                monitorKey: "ops-check",
                severity: "warning",
                state: "active",
                title: "Root filesystem pressure",
            });
            database.orm.insert(incidents).values(insert).run();

            const selected = database.orm
                .select()
                .from(incidents)
                .where(eq(incidents.id, id))
                .get();

            expect(v.parse(incidentSelectSchema, selected)).toEqual({
                ...insert,
                generation: 1,
                occurrenceCount: 1,
                resolvedAt: null,
            });
        } finally {
            database.sqlite.close(true);
        }
    });
});
