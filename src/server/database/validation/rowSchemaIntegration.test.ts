import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import * as v from "valibot";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { incidents } from "../schema/incidents.ts";
import { incidentInsertSchema, incidentSelectSchema } from "./incidents.ts";
import { incidentId, validIncidentValues } from "./testSupport/rows.ts";

describe("Drizzle Valibot database integration", () => {
    test("round-trips a migrated SQLite row through generated schemas", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            const insert = v.parse(incidentInsertSchema, validIncidentValues);
            database.orm.insert(incidents).values(insert).run();

            const selected = database.orm
                .select()
                .from(incidents)
                .where(eq(incidents.id, incidentId))
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
