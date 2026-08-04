import { describe, expect, test } from "bun:test";

import { parseISO } from "date-fns";
import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { createQualificationDatabase } from "./database.ts";
import {
    qualificationEvents,
    qualificationIncidentInsertSchema,
    qualificationIncidents,
    qualificationIncidentSelectSchema,
} from "./schema.ts";

interface QueryPlanRow {
    detail: string;
}

describe("Drizzle on Bun SQLite", () => {
    test("keeps typed queries, raw SQL, constraints, and native access", () => {
        const database = createQualificationDatabase();
        const openedAt = parseISO("2026-08-03T20:00:00.000Z");
        const incidentKey = "system:filesystem:root-pressure";

        try {
            const insert = v.parse(qualificationIncidentInsertSchema, {
                incidentKey,
                lastSeenAt: openedAt,
                status: "open",
            });

            const incidentId = database.orm.transaction((transaction) => {
                const incident = transaction
                    .insert(qualificationIncidents)
                    .values(insert)
                    .returning({ id: qualificationIncidents.id })
                    .get();

                transaction
                    .insert(qualificationEvents)
                    .values({
                        aggregateId: incident.id,
                        createdAt: openedAt,
                        payload: JSON.stringify({ incidentKey }),
                        topic: "incident.opened",
                    })
                    .run();

                return incident.id;
            });

            const preparedIncident = database.orm
                .select()
                .from(qualificationIncidents)
                .where(eq(qualificationIncidents.id, sql.placeholder("incidentId")))
                .prepare();
            const selected = preparedIncident.get({ incidentId });

            expect(v.parse(qualificationIncidentSelectSchema, selected)).toEqual({
                id: incidentId,
                incidentKey,
                lastSeenAt: openedAt,
                resolvedAt: null,
                status: "open",
            });
            expect(database.orm.$client).toBe(database.sqlite);

            expect(() =>
                database.orm
                    .insert(qualificationIncidents)
                    .values({
                        incidentKey,
                        lastSeenAt: openedAt,
                        status: "open",
                    })
                    .run()
            ).toThrow();

            const rawRows = database.orm.all<{ incidentKey: string }>(sql`
                SELECT incident_key AS incidentKey
                FROM qualification_incidents
                WHERE incident_key = ${incidentKey}
            `);
            expect(rawRows).toEqual([{ incidentKey }]);

            const plan = database.sqlite
                .query<QueryPlanRow, [string]>(`
                    EXPLAIN QUERY PLAN
                    SELECT id
                    FROM qualification_incidents
                    WHERE status = ?
                    ORDER BY last_seen_at DESC
                `)
                .all("open");
            expect(plan.some((row) => row.detail.includes("status_seen_idx"))).toBeTrue();

            expect(
                database.sqlite
                    .query<{ eventCount: number }, []>(
                        "SELECT count(*) AS eventCount FROM qualification_events"
                    )
                    .get()
            ).toEqual({ eventCount: 1 });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rolls back synchronous transactions atomically", () => {
        const database = createQualificationDatabase();

        try {
            expect(() =>
                database.orm.transaction((transaction) => {
                    transaction
                        .insert(qualificationIncidents)
                        .values({
                            incidentKey: "system:memory:pressure",
                            lastSeenAt: parseISO("2026-08-03T20:05:00.000Z"),
                            status: "open",
                        })
                        .run();
                    throw new Error("qualification rollback");
                })
            ).toThrow("qualification rollback");

            expect(database.orm.select().from(qualificationIncidents).all()).toEqual([]);
        } finally {
            database.sqlite.close(true);
        }
    });
});
