import { describe, expect, test } from "bun:test";

import {
    createSystemHttpProcedureMetrics,
    systemHttpMetricProceduresFromUrl,
} from "./httpProcedureMetrics.ts";

describe("HTTP procedure metrics", () => {
    test("uses fixed buckets and one bounded overflow without retaining arbitrary paths", () => {
        const metrics = createSystemHttpProcedureMetrics();
        metrics.record({
            durationMs: 12.4,
            procedures: ["system.metrics"],
            status: 200,
        });
        metrics.record({
            durationMs: 4,
            procedures: ["future.secret-bearing-name"],
            status: 503,
        });

        const snapshot = metrics.snapshot();
        expect(
            snapshot.procedures.find(({ procedure }) => procedure === "system.metrics")
        ).toEqual({
            errorCount: 0,
            maximumDurationMs: 12,
            procedure: "system.metrics",
            requestCount: 1,
            totalDurationMs: 12,
        });
        expect(
            snapshot.procedures.find(({ procedure }) => procedure === "overflow")
        ).toEqual({
            errorCount: 1,
            maximumDurationMs: 4,
            procedure: "overflow",
            requestCount: 1,
            totalDurationMs: 4,
        });
        expect(JSON.stringify(snapshot)).not.toContain("secret-bearing-name");
    });

    test("extracts exact decoded batch names and contains malformed escapes", () => {
        expect(
            systemHttpMetricProceduresFromUrl(
                new URL(
                    "https://dashboard.test/trpc/cache.getHeartbeat,system.metrics?batch=1"
                )
            )
        ).toEqual(["cache.getHeartbeat", "system.metrics"]);
        expect(
            systemHttpMetricProceduresFromUrl(
                new URL("https://dashboard.test/trpc/system%2Emetrics")
            )
        ).toEqual(["system.metrics"]);
        expect(
            systemHttpMetricProceduresFromUrl(
                new URL("https://dashboard.test/trpc/system%ZZmetrics")
            )
        ).toEqual(["overflow"]);
        expect(
            systemHttpMetricProceduresFromUrl(
                new URL("https://dashboard.test/api/health/live")
            )
        ).toEqual([]);
    });
});
