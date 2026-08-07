import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { utf8ByteLength } from "../shared/encoding.ts";
import { monitoringMutationInputMaximumBytes } from "./monitoring.ts";
import { upsertReportInputSchema } from "./reports.ts";

const reportId = "018f6f50-6a9e-7b88-8000-000000000002";

function report(bodyMarkdown: string) {
    return {
        bodyMarkdown,
        id: reportId,
        kind: "daily-summary",
        metadata: {},
        occurredAtMs: 1000,
        source: "openclaw",
        sourceJobId: "daily-summary",
        status: "ok",
        title: "Daily summary",
    };
}

describe("report mutation input budgets", () => {
    test("accepts a substantial report below the aggregate encoded budget", () => {
        const result = v.safeParse(
            upsertReportInputSchema,
            report("A".repeat(400 * 1024))
        );

        expect(result.success).toBeTrue();
        if (result.success) {
            expect(utf8ByteLength(JSON.stringify(result.output))).toBeLessThan(
                monitoringMutationInputMaximumBytes
            );
        }
    });

    test("rejects a field-valid report above the aggregate encoded budget", () => {
        const input = report("A".repeat(600 * 1024));
        expect(utf8ByteLength(JSON.stringify(input))).toBeGreaterThan(
            monitoringMutationInputMaximumBytes
        );

        const result = v.safeParse(upsertReportInputSchema, input);
        expect(result.success).toBeFalse();
        if (!result.success) {
            expect(result.issues.at(-1)?.message).toContain(
                String(monitoringMutationInputMaximumBytes)
            );
        }
    });
});
