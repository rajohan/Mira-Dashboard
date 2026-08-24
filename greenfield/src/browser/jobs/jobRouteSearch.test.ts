import { describe, expect, test } from "bun:test";

import { parseJobsRouteSearch } from "./jobRouteSearch.ts";

const runId = "019fdf60-0000-7000-8000-000000000001";

describe("jobs route search", () => {
    test("preserves independent canonical schedule and run deep links", () => {
        expect(
            parseJobsRouteSearch({
                runId,
                scheduleId: "system.worker-smoke",
                unknown: "dropped",
            })
        ).toEqual({
            runId,
            scheduleId: "system.worker-smoke",
        });
    });

    test("preserves OpenClaw source and bounded cron selection beside Dashboard links", () => {
        expect(
            parseJobsRouteSearch({
                cronJobId: "nightly-report",
                runId,
                scheduleId: "system.worker-smoke",
                source: "openclaw",
            })
        ).toEqual({
            cronJobId: "nightly-report",
            runId,
            scheduleId: "system.worker-smoke",
            source: "openclaw",
        });
    });

    test("drops malformed selections independently", () => {
        expect(
            parseJobsRouteSearch({
                runId: "not-a-run",
                scheduleId: "system.worker-smoke",
            })
        ).toEqual({ scheduleId: "system.worker-smoke" });
        expect(parseJobsRouteSearch({ runId, scheduleId: "Bad Schedule" })).toEqual({
            runId,
        });
        expect(parseJobsRouteSearch("invalid")).toEqual({});
        expect(parseJobsRouteSearch(null)).toEqual({});
        expect(parseJobsRouteSearch([runId, "system.worker-smoke"])).toEqual({});
        expect(parseJobsRouteSearch({ runId: 1, scheduleId: false })).toEqual({});
        expect(
            parseJobsRouteSearch({
                cronJobId: "x".repeat(257),
                runId,
                source: "external",
            })
        ).toEqual({ runId });
    });
});
