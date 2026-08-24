import { expect, test } from "bun:test";

import { subMilliseconds, toDate } from "date-fns";
import * as v from "valibot";

import { notificationInsertSchema, notificationSelectSchema } from "./notifications.ts";
import { validNotificationValues } from "./testSupport/rows.ts";

const validNotificationSelectValues = Object.freeze({
    ...validNotificationValues,
    linkUrl: null,
    readAt: null,
});

test("accepts notifications with both incident reference fields", () => {
    expect(v.parse(notificationInsertSchema, validNotificationValues)).toBeDefined();
    expect(
        v.parse(notificationSelectSchema, validNotificationSelectValues)
    ).toBeDefined();
});

test("accepts nullable and omitted report-link fields on notification inserts", () => {
    const {
        reportId: _reportId,
        source: _source,
        ...withoutReportLink
    } = validNotificationValues;

    expect(
        v.parse(notificationInsertSchema, {
            ...validNotificationValues,
            reportId: null,
            source: null,
        })
    ).toBeDefined();
    expect(v.parse(notificationInsertSchema, withoutReportLink)).toBeDefined();
    expect(
        v.parse(notificationSelectSchema, {
            ...validNotificationSelectValues,
            reportId: null,
            source: null,
        })
    ).toBeDefined();
});

test("rejects notifications with only half of the incident reference pair", () => {
    const { incidentGeneration: _generation, ...withoutGeneration } =
        validNotificationValues;
    const { incidentId: _incidentId, ...withoutIncidentId } = validNotificationValues;

    expect(() => v.parse(notificationInsertSchema, withoutGeneration)).toThrow();
    expect(() => v.parse(notificationInsertSchema, withoutIncidentId)).toThrow();
    expect(() =>
        v.parse(notificationSelectSchema, {
            ...validNotificationSelectValues,
            incidentGeneration: null,
        })
    ).toThrow();
    expect(() =>
        v.parse(notificationSelectSchema, {
            ...validNotificationSelectValues,
            incidentId: null,
        })
    ).toThrow();
});

test("rejects notification timestamps before the Unix epoch", () => {
    expect(() =>
        v.parse(notificationInsertSchema, {
            ...validNotificationValues,
            occurredAt: toDate(-1),
        })
    ).toThrow();
    expect(() =>
        v.parse(notificationSelectSchema, {
            ...validNotificationSelectValues,
            readAt: toDate(-1),
        })
    ).toThrow();
});

test("reuses monitoring text policies and enforces notification read order", () => {
    for (const overrides of [
        { kind: "k".repeat(101) },
        { message: "m".repeat(1001) },
        { readAt: subMilliseconds(validNotificationValues.occurredAt, 1) },
        { reportId: "not-a-report-id" },
        { source: "s".repeat(201) },
        { title: "t".repeat(501) },
    ]) {
        expect(() =>
            v.parse(notificationSelectSchema, {
                ...validNotificationSelectValues,
                ...overrides,
            })
        ).toThrow();
    }
});
