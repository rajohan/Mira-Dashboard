import { describe, expect, it } from "bun:test";

import { OpenClawChatRuntimeMetricsRecorder } from "../src/services/chat/openClawChatMetrics.ts";

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
});
