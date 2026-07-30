import { afterEach, describe, expect, it } from "bun:test";

import { parseChatProjectionShadowObservation } from "../../contracts/chatProjectionTelemetry.ts";
import {
    getChatProjectionShadowMetrics,
    OpenClawChatRuntimeMetricsRecorder,
    recordChatProjectionShadowObservation,
    resetChatProjectionShadowMetricsForTests,
} from "../src/chat/openClawChatMetrics.ts";
import { metricsRoutes } from "../src/routes/metricsRoutes.ts";

afterEach(() => {
    resetChatProjectionShadowMetricsForTests();
});

describe("OpenClaw chat runtime observability", () => {
    it("measures bounded replay gauges, limit evictions, and rolling store writes", () => {
        let now = 1000;
        const recorder = new OpenClawChatRuntimeMetricsRecorder(() => now);
        recorder.observeReplayBytes(400);
        recorder.observeReplayBytes(200);
        recorder.recordEviction("memory");
        recorder.recordEviction("session");
        recorder.recordPersistenceWrite(true);
        recorder.recordPersistenceWrite(false);

        expect(
            recorder.snapshot({
                currentBytes: 200,
                events: 2,
                maxBytes: 1000,
                runs: 1,
                sessions: 1,
            })
        ).toEqual({
            persistence: {
                writeAttempts: 2,
                writeFailures: 1,
                writes: 1,
                writesPerMinute: 1,
            },
            replay: {
                currentBytes: 200,
                events: 2,
                maxBytes: 1000,
                memoryEvictions: 1,
                peakBytes: 400,
                runs: 1,
                sessionEvictions: 1,
                sessions: 1,
            },
        });

        now += 60_001;
        expect(
            recorder.snapshot({
                currentBytes: 100,
                events: 1,
                maxBytes: 1000,
                runs: 1,
                sessions: 1,
            }).persistence.writesPerMinute
        ).toBe(0);
    });

    it("counts content-free canonical projection parity dimensions", () => {
        recordChatProjectionShadowObservation(
            parseChatProjectionShadowObservation({
                canonicalActiveRunCount: 1,
                canonicalCompactionPhase: "none",
                canonicalRowCount: 2,
                differenceKinds: [],
                legacyActiveRunCount: 1,
                legacyCompactionPhase: "none",
                legacyRowCount: 2,
                matches: true,
                schemaVersion: 1,
                turnCount: 1,
            }),
            Date.parse("2026-07-30T10:00:00.000Z")
        );
        recordChatProjectionShadowObservation(
            parseChatProjectionShadowObservation({
                canonicalActiveRunCount: 0,
                canonicalCompactionPhase: "complete",
                canonicalRowCount: 1,
                differenceKinds: ["active-runs", "compaction-status", "rows"],
                legacyActiveRunCount: 1,
                legacyCompactionPhase: "active",
                legacyRowCount: 2,
                matches: false,
                schemaVersion: 1,
                turnCount: 1,
            })
        );
        recordChatProjectionShadowObservation(
            parseChatProjectionShadowObservation({
                differenceKinds: ["canonical-error"],
                legacyActiveRunCount: 1,
                legacyCompactionPhase: "active",
                legacyRowCount: 2,
                matches: false,
                schemaVersion: 1,
            })
        );

        expect(getChatProjectionShadowMetrics()).toEqual({
            activeRunMismatches: 1,
            canonicalErrors: 1,
            compactionStatusMismatches: 1,
            lastObservedAt: expect.any(String),
            matches: 1,
            mismatches: 2,
            observations: 3,
            rowMismatches: 1,
        });
    });

    it("accepts strict observations and rejects content-bearing telemetry", async () => {
        const validResponse = await metricsRoutes[
            "/api/metrics/chat-projection-shadow"
        ].POST(
            new Request("http://localhost/api/metrics/chat-projection-shadow", {
                body: JSON.stringify({
                    canonicalActiveRunCount: 0,
                    canonicalCompactionPhase: "none",
                    canonicalRowCount: 0,
                    differenceKinds: [],
                    legacyActiveRunCount: 0,
                    legacyCompactionPhase: "none",
                    legacyRowCount: 0,
                    matches: true,
                    schemaVersion: 1,
                    turnCount: 0,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(validResponse.status).toBe(200);
        expect(await validResponse.json()).toEqual({ isOk: true });
        expect(getChatProjectionShadowMetrics().observations).toBe(1);

        const invalidResponse = await metricsRoutes[
            "/api/metrics/chat-projection-shadow"
        ].POST(
            new Request("http://localhost/api/metrics/chat-projection-shadow", {
                body: JSON.stringify({
                    canonicalActiveRunCount: 0,
                    canonicalCompactionPhase: "none",
                    canonicalRowCount: 0,
                    differenceKinds: [],
                    legacyActiveRunCount: 0,
                    legacyCompactionPhase: "none",
                    legacyFingerprint: "must-not-cross-the-boundary",
                    legacyRowCount: 0,
                    matches: true,
                    schemaVersion: 1,
                    turnCount: 0,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(invalidResponse.status).toBe(400);
        expect(getChatProjectionShadowMetrics().observations).toBe(1);
    });
});
