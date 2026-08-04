import { expect, test } from "bun:test";

import { addMinutes, subMilliseconds, toDate } from "date-fns";
import * as v from "valibot";

import { incidentInsertSchema, incidentSelectSchema } from "./incidents.ts";
import { observedAt, validIncidentValues } from "./testSupport/rows.ts";

const validIncidentSelectValues = Object.freeze({
    ...validIncidentValues,
    generation: 1,
    occurrenceCount: 1,
    resolvedAt: null,
});

test("accepts consistent active and resolved incident lifecycles", () => {
    expect(v.parse(incidentInsertSchema, validIncidentValues)).toBeDefined();
    expect(v.parse(incidentSelectSchema, validIncidentSelectValues)).toBeDefined();

    const resolvedAt = addMinutes(observedAt, 1);
    expect(
        v.parse(incidentInsertSchema, {
            ...validIncidentValues,
            lastSeenAt: resolvedAt,
            resolvedAt,
            state: "resolved",
        })
    ).toBeDefined();
});

test("rejects incident rows whose lifecycle fields disagree", () => {
    const invalidOverrides = [
        { resolvedAt: observedAt, state: "active" },
        { resolvedAt: null, state: "resolved" },
        { lastSeenAt: subMilliseconds(observedAt, 1) },
        { resolvedAt: subMilliseconds(observedAt, 1), state: "resolved" },
    ] as const;

    for (const overrides of invalidOverrides) {
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                ...overrides,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentSelectSchema, {
                ...validIncidentSelectValues,
                ...overrides,
            })
        ).toThrow();
    }
});

test("requires canonical incident fingerprints at both persistence boundaries", () => {
    expect(() =>
        v.parse(incidentInsertSchema, {
            ...validIncidentValues,
            fingerprint: "not-a-sha-256-digest",
        })
    ).toThrow();
    expect(() =>
        v.parse(incidentSelectSchema, {
            ...validIncidentSelectValues,
            fingerprint: "A".repeat(64),
        })
    ).toThrow();
});

test("applies the bounded monitoring JSON policy to stored incident details", () => {
    expect(() =>
        v.parse(incidentInsertSchema, {
            ...validIncidentValues,
            detailsJson: JSON.stringify({ value: "x".repeat(64 * 1024) }),
        })
    ).toThrow("Expected bounded monitoring JSON text with an object root");
    expect(() =>
        v.parse(incidentInsertSchema, {
            ...validIncidentValues,
            detailsJson: `${" ".repeat(64 * 1024)}{}`,
        })
    ).toThrow("Expected bounded monitoring JSON text with an object root");
});

test("reuses monitoring text and timestamp policies at the incident boundary", () => {
    for (const overrides of [
        { kind: "k".repeat(101) },
        { monitorKey: "m".repeat(201) },
        { title: "t".repeat(1001) },
        { firstSeenAt: toDate(-1), lastSeenAt: toDate(-1) },
    ]) {
        expect(() =>
            v.parse(incidentInsertSchema, {
                ...validIncidentValues,
                ...overrides,
            })
        ).toThrow();
        expect(() =>
            v.parse(incidentSelectSchema, {
                ...validIncidentSelectValues,
                ...overrides,
            })
        ).toThrow();
    }
});
