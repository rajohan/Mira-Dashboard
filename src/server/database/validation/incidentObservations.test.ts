import { expect, test } from "bun:test";

import { toDate } from "date-fns";
import * as v from "valibot";

import {
    incidentObservationInsertSchema,
    incidentObservationSelectSchema,
} from "./incidentObservations.ts";
import { validObservationValues } from "./testSupport/rows.ts";

const validObservationSelectValues = Object.freeze({
    ...validObservationValues,
    id: 1,
});

test("accepts bounded monitoring observation values", () => {
    expect(
        v.parse(incidentObservationInsertSchema, validObservationValues)
    ).toBeDefined();
    expect(
        v.parse(incidentObservationSelectSchema, validObservationSelectValues)
    ).toBeDefined();
});

test("rejects observations outside shared monitoring policies", () => {
    for (const overrides of [
        { kind: "k".repeat(101) },
        { observedAt: toDate(-1) },
        { title: "t".repeat(1001) },
    ]) {
        expect(() =>
            v.parse(incidentObservationInsertSchema, {
                ...validObservationValues,
                ...overrides,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentObservationSelectSchema, {
                ...validObservationSelectValues,
                ...overrides,
            })
        ).toThrow();
    }
});
