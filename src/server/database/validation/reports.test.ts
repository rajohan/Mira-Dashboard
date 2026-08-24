import { expect, test } from "bun:test";

import { toDate } from "date-fns";
import * as v from "valibot";

import { reportInsertSchema, reportSelectSchema } from "./reports.ts";
import { observedAt, reportId } from "./testSupport/rows.ts";

const validReportValues = Object.freeze({
    bodyMarkdown: "All checks passed.",
    id: reportId,
    kind: "heartbeat",
    metadataJson: "{}",
    occurredAt: observedAt,
    source: "openclaw",
    sourceJobId: "ops-check:primary",
    status: "ok" as const,
    summary: null,
    title: "Heartbeat",
});

test("accepts bounded monitoring report values", () => {
    expect(v.parse(reportInsertSchema, validReportValues)).toBeDefined();
    expect(v.parse(reportSelectSchema, validReportValues)).toBeDefined();
});

test("rejects reports outside shared monitoring policies", () => {
    for (const overrides of [
        { bodyMarkdown: "b".repeat(1_000_001) },
        { kind: "k".repeat(101) },
        { occurredAt: toDate(-1) },
        { source: "s".repeat(201) },
        { sourceJobId: "j".repeat(201) },
        { status: "unknown" },
        { summary: "s".repeat(2001) },
        { title: "t".repeat(501) },
    ]) {
        expect(() =>
            v.parse(reportInsertSchema, { ...validReportValues, ...overrides })
        ).toThrow();
        expect(() =>
            v.parse(reportSelectSchema, { ...validReportValues, ...overrides })
        ).toThrow();
    }
});
