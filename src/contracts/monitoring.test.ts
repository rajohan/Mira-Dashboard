import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { utf8ByteLength } from "../shared/encoding.ts";
import {
    completeMonitoringSnapshotInputSchema,
    monitoringMutationInputMaximumBytes,
} from "./monitoring.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";

function snapshot(bodyMarkdown: string) {
    return {
        completedAtMs: 2000,
        monitorKey: "dashboard-health",
        problems: [],
        report: {
            bodyMarkdown,
            kind: "health",
            metadata: {},
            source: "dashboard",
            sourceJobId: "health",
            title: "Dashboard health",
        },
        runId,
        startedAtMs: 1000,
    };
}

describe("monitoring mutation input budgets", () => {
    test("accepts a substantial snapshot below the aggregate encoded budget", () => {
        const result = v.safeParse(
            completeMonitoringSnapshotInputSchema,
            snapshot("A".repeat(400 * 1024))
        );

        expect(result.success).toBeTrue();
        if (result.success) {
            expect(utf8ByteLength(JSON.stringify(result.output))).toBeLessThan(
                monitoringMutationInputMaximumBytes
            );
        }
    });

    test("rejects a field-valid snapshot above the aggregate encoded budget", () => {
        const input = snapshot("A".repeat(600 * 1024));
        expect(utf8ByteLength(JSON.stringify(input))).toBeGreaterThan(
            monitoringMutationInputMaximumBytes
        );

        const result = v.safeParse(completeMonitoringSnapshotInputSchema, input);
        expect(result.success).toBeFalse();
        if (!result.success) {
            expect(result.issues.at(-1)?.message).toContain(
                String(monitoringMutationInputMaximumBytes)
            );
        }
    });
});
