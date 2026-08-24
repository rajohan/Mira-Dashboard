import { expect, test } from "bun:test";

import { addMinutes, subMilliseconds, toDate } from "date-fns";
import * as v from "valibot";

import { monitorRunInsertSchema, monitorRunSelectSchema } from "./monitorRuns.ts";
import { observedAt, validMonitorRunValues } from "./testSupport/rows.ts";

const validMonitorRunSelectValues = Object.freeze({
    ...validMonitorRunValues,
    completedAt: null,
});

test("accepts consistent running and completed monitor runs", () => {
    expect(v.parse(monitorRunInsertSchema, validMonitorRunValues)).toBeDefined();
    expect(v.parse(monitorRunSelectSchema, validMonitorRunSelectValues)).toBeDefined();

    expect(
        v.parse(monitorRunInsertSchema, {
            ...validMonitorRunValues,
            completedAt: addMinutes(observedAt, 1),
            state: "succeeded",
        })
    ).toBeDefined();
});

test("rejects monitor-run rows whose completion fields disagree", () => {
    const invalidPairs = [
        {
            insert: { ...validMonitorRunValues, completedAt: observedAt },
            select: { ...validMonitorRunSelectValues, completedAt: observedAt },
        },
        {
            insert: { ...validMonitorRunValues, state: "succeeded" },
            select: {
                ...validMonitorRunSelectValues,
                completedAt: null,
                state: "succeeded",
            },
        },
        {
            insert: {
                ...validMonitorRunValues,
                completedAt: subMilliseconds(observedAt, 1),
                state: "failed",
            },
            select: {
                ...validMonitorRunSelectValues,
                completedAt: subMilliseconds(observedAt, 1),
                state: "failed",
            },
        },
    ] as const;

    for (const invalid of invalidPairs) {
        expect(() => v.parse(monitorRunInsertSchema, invalid.insert)).toThrow();
        expect(() => v.parse(monitorRunSelectSchema, invalid.select)).toThrow();
    }
});

test("reuses the monitoring key and timestamp policies at the run boundary", () => {
    for (const overrides of [
        { monitorKey: "m".repeat(201) },
        { submissionSha256: `${"a".repeat(64)}\0suffix` },
        { startedAt: toDate(-1) },
    ]) {
        expect(() =>
            v.parse(monitorRunInsertSchema, {
                ...validMonitorRunValues,
                ...overrides,
            })
        ).toThrow();
        expect(() =>
            v.parse(monitorRunSelectSchema, {
                ...validMonitorRunSelectValues,
                ...overrides,
            })
        ).toThrow();
    }
});
