import { describe, expect, test } from "bun:test";

import { loadReviewedOpenClawFixtures } from "../openclaw/reviewedFixtures.ts";
import { simulateChatBatching } from "./chatBatchingModel.ts";
import {
    buildChatBatchingTrace,
    chatBatchingCandidateIntervalsMs,
    chatBatchingConcurrencyLevels,
    qualifyChatBatching,
} from "./chatBatchingQualification.ts";

describe("current OpenClaw chat batching qualification", () => {
    test("selects the smallest bounded interval from every reviewed candidate", async () => {
        const { audit } = await loadReviewedOpenClawFixtures();
        const evidence = qualifyChatBatching(audit.chat);

        expect(evidence).toMatchObject({
            maximumAdditionalVisualDelayMs: 150,
            maximumCrashWindowMs: 150,
            maximumScheduledTransactionsPerSecond: 7,
            selectedIntervalMs: 150,
            sourceDeltaThrottleMs: 150,
        });
        expect([
            ...new Set(evidence.candidates.map(({ metrics }) => metrics.intervalMs)),
        ]).toEqual([...chatBatchingCandidateIntervalsMs]);
        expect([
            ...new Set(evidence.candidates.map(({ concurrency }) => concurrency)),
        ]).toEqual([...chatBatchingConcurrencyLevels]);
        expect(
            chatBatchingCandidateIntervalsMs
                .filter((intervalMs) => intervalMs < 150)
                .every((intervalMs) =>
                    evidence.candidates
                        .filter(({ metrics }) => metrics.intervalMs === intervalMs)
                        .some(({ accepted }) => !accepted)
                )
        ).toBeTrue();
        expect(
            evidence.candidates
                .filter(({ metrics }) => metrics.intervalMs === 150)
                .every(({ accepted }) => accepted)
        ).toBeTrue();
        expect(
            evidence.candidates
                .filter(({ metrics }) => metrics.intervalMs > 150)
                .every(({ accepted }) => !accepted)
        ).toBeTrue();
    });

    test("flushes tool and terminal boundaries without losing ordered events", async () => {
        const { audit } = await loadReviewedOpenClawFixtures();
        const trace = buildChatBatchingTrace(audit.chat, 8);
        const metrics = simulateChatBatching(trace, 150);

        expect(metrics.committedEvents).toBe(trace.length);
        expect(metrics.boundaryMaximumCommitDelayMs).toBe(0);
        expect(metrics.terminalMaximumCommitDelayMs).toBe(0);
        expect(metrics.maximumCommitDelayMs).toBeLessThanOrEqual(150);
        expect(metrics.transactions).toBeLessThan(trace.length);
        expect(metrics.scheduledTransactions).toBeLessThan(trace.length);
        expect(metrics.maximumPendingBytes).toBeGreaterThan(0);
        expect(metrics.boundaryTransactions).toBeGreaterThan(0);
    });

    test("is deterministic and rejects malformed sequence or interval input", async () => {
        const { audit } = await loadReviewedOpenClawFixtures();
        const trace = buildChatBatchingTrace(audit.chat, 4);
        expect(qualifyChatBatching(audit.chat)).toEqual(qualifyChatBatching(audit.chat));
        expect(() => simulateChatBatching(trace, 0)).toThrow();
        expect(() =>
            simulateChatBatching(
                trace.map((event, index) =>
                    index === 0 ? { ...event, sequence: 2 } : event
                ),
                150
            )
        ).toThrow("sequence is not contiguous");
    });
});
