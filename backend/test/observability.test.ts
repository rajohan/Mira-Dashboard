import { afterEach, describe, expect, it, jest } from "bun:test";

import {
    getDatabaseOperationMetrics,
    recordDatabaseOperation,
    resetDatabaseOperationMetricsForTests,
} from "../src/lib/databaseMetrics.ts";
import { hashedLogCorrelation, runWithLogContext } from "../src/lib/logContext.ts";
import { getRuntimeMetrics } from "../src/lib/runtimeMetrics.ts";
import {
    enableStructuredLogOutputForTests,
    redactLogFields,
    structuredLog,
    subscribeToStructuredLogs,
} from "../src/lib/structuredLogger.ts";

afterEach(() => {
    resetDatabaseOperationMetricsForTests();
});

describe("application observability", () => {
    it("redacts secrets recursively without mutating caller-owned fields", () => {
        const fields = {
            authorization: "Bearer top-secret",
            error: new Error("request failed with Bearer hidden-token"),
            nested: {
                cookieHeader: "session=private",
                password: "password-value",
                passwordHash: "password-hash",
                url: "https://example.test/path?token=query-secret&view=full",
            },
            safe: "visible",
        };

        expect(redactLogFields(fields)).toEqual({
            authorization: "[REDACTED]",
            error: {
                message: "request failed with Bearer [REDACTED]",
                name: "Error",
            },
            nested: {
                cookieHeader: "[REDACTED]",
                password: "[REDACTED]",
                passwordHash: "[REDACTED]",
                url: "https://example.test/path?token=[REDACTED]&view=full",
            },
            safe: "visible",
        });
        expect(fields.nested.password).toBe("password-value");
    });

    it("redacts embedded authorization and truncates oversized strings", () => {
        const oversized = "x".repeat(9000);
        const result = redactLogFields({
            message: "upstream sent Basic dXNlcjpwYXNzd29yZA==",
            oversized,
        });

        expect(result.message).toBe("upstream sent Basic [REDACTED]");
        expect(String(result.oversized)).toEndWith("…[Truncated]");
        expect(String(result.oversized).length).toBeLessThan(oversized.length);
    });

    it("emits correlated newline-safe JSON events", () => {
        const warn = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();

        try {
            runWithLogContext(
                {
                    jobId: "job-7",
                    requestId: "request-8",
                    sessionId: "session-hash",
                },
                () => {
                    structuredLog("warn", "observability.test", {
                        apiToken: "secret-token",
                        message: "one\nline",
                    });
                }
            );

            expect(warn).toHaveBeenCalledTimes(1);
            const [line] = warn.mock.calls[0] ?? [];
            expect(typeof line).toBe("string");
            const event = JSON.parse(String(line).trimEnd()) as Record<string, unknown>;
            expect(event).toMatchObject({
                apiToken: "[REDACTED]",
                event: "observability.test",
                jobId: "job-7",
                level: "warn",
                message: "one\nline",
                requestId: "request-8",
                service: "mira-dashboard",
                sessionId: "session-hash",
            });
            expect(String(line).split("\n")).toHaveLength(2);
            expect(String(line)).toEndWith("\n");
        } finally {
            disableOutput();
        }
    });

    it("publishes complete structured lines without letting listeners affect output", () => {
        const warn = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();
        const received: string[] = [];
        const unsubscribe = subscribeToStructuredLogs((line) => {
            received.push(line);
        });

        try {
            structuredLog("warn", "observability.live");
            unsubscribe();
            structuredLog("warn", "observability.after_unsubscribe");

            expect(warn).toHaveBeenCalledTimes(2);
            expect(received).toHaveLength(1);
            expect(JSON.parse(received[0]!)).toMatchObject({
                event: "observability.live",
                level: "warn",
            });
        } finally {
            unsubscribe();
            disableOutput();
        }
    });

    it("uses stable non-reversible session correlation values", () => {
        const first = hashedLogCorrelation("session", "sensitive-session-id");
        const second = hashedLogCorrelation("session", "sensitive-session-id");
        const differentNamespace = hashedLogCorrelation(
            "authorization",
            "sensitive-session-id"
        );

        expect(first).toHaveLength(16);
        expect(first).toBe(second);
        expect(first).not.toBe(differentNamespace);
        expect(first).not.toContain("sensitive");
    });

    it("aggregates database latency and SQLite lock errors", () => {
        recordDatabaseOperation(4);
        recordDatabaseOperation(8, { code: "SQLITE_BUSY_TIMEOUT" });
        recordDatabaseOperation(Number.NaN, { code: "OTHER_ERROR" });

        expect(getDatabaseOperationMetrics()).toEqual({
            averageDurationMs: 4,
            lockErrors: 1,
            maxDurationMs: 8,
            operations: 3,
        });
    });

    it("samples runtime memory and event-loop delay", async () => {
        const metrics = await getRuntimeMetrics();

        expect(metrics.eventLoopDelayMs).toBeGreaterThanOrEqual(0);
        expect(metrics.heapTotalBytes).toBeGreaterThan(0);
        expect(metrics.heapUsedBytes).toBeGreaterThan(0);
        expect(metrics.rssBytes).toBeGreaterThan(0);
        expect(metrics.uptimeSeconds).toBeGreaterThan(0);
    });
});
