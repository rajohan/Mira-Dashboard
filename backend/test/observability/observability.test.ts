import { afterEach, describe, expect, it, jest } from "bun:test";
import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    getDatabaseOperationMetrics,
    recordDatabaseOperation,
    resetDatabaseOperationMetricsForTests,
} from "../../src/lib/databaseMetrics.ts";
import { hashedLogCorrelation, runWithLogContext } from "../../src/lib/logContext.ts";
import { getRuntimeMetrics } from "../../src/lib/runtimeMetrics.ts";
import {
    createStructuredLogger,
    enableStructuredLogOutputForTests,
    redactLogFields,
    structuredLog,
    subscribeToStructuredLogs,
} from "../../src/lib/structuredLogger.ts";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
    resetDatabaseOperationMetricsForTests();
});

function temporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

function useApplicationLogPath(logPath: string): void {
    const original = process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH;
    process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = logPath;
    cleanupCallbacks.push(() => {
        if (original === undefined) {
            delete process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH;
        } else {
            process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = original;
        }
    });
}

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

    it("sanitizes non-JSON values, cycles, and excessive nesting", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const codedError = Object.assign(new Error("failed"), {
            code: "EFAIL",
            statusCode: 503,
        });

        expect(
            redactLogFields({
                bigint: 42n,
                circular,
                codedError,
                function: () => 0,
                nested: { one: { two: { three: { four: { five: "hidden" } } } } },
                symbol: Symbol("observability"),
            })
        ).toEqual({
            bigint: "42",
            circular: { self: "[Circular]" },
            codedError: {
                code: "EFAIL",
                message: "failed",
                name: "Error",
                statusCode: 503,
            },
            function: expect.any(String),
            nested: { one: { two: { three: { four: "[Truncated]" } } } },
            symbol: "Symbol(observability)",
        });
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

    it("keeps listener failures isolated and scopes component loggers", () => {
        const output = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();
        const unsubscribe = subscribeToStructuredLogs(() => {
            throw new Error("listener failed");
        });

        try {
            const logger = createStructuredLogger("coverage-component");
            expect(() => logger.warn("observability.listener_failure")).not.toThrow();
            logger.error("observability.component", { value: 7 });

            expect(output).toHaveBeenCalledTimes(2);
            expect(JSON.parse(String(output.mock.calls[1]?.[0]).trimEnd())).toMatchObject(
                {
                    component: "coverage-component",
                    event: "observability.component",
                    level: "error",
                    value: 7,
                }
            );
        } finally {
            unsubscribe();
            disableOutput();
        }
    });

    it("writes private newline-delimited application logs and reuses the descriptor", () => {
        const root = temporaryRoot("mira-structured-log-");
        const logPath = path.join(root, "dashboard.ndjson");
        useApplicationLogPath(logPath);
        jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();

        try {
            structuredLog("warn", "observability.file_first", { secret: "hidden" });
            structuredLog("error", "observability.file_second");

            const records = readFileSync(logPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(records).toHaveLength(2);
            expect(records[0]).toMatchObject({
                event: "observability.file_first",
                secret: "[REDACTED]",
            });
            expect(records[1]).toMatchObject({ event: "observability.file_second" });
            expect(statSync(logPath).mode & 0o777).toBe(0o600);

            process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = "relative.log";
            structuredLog("warn", "observability.invalid_path");
        } finally {
            disableOutput();
        }
    });

    it("rotates an oversized application log before appending", () => {
        const root = temporaryRoot("mira-structured-log-rotation-");
        const logPath = path.join(root, "dashboard.ndjson");
        writeFileSync(logPath, Buffer.alloc(16 * 1024 * 1024, 120));
        useApplicationLogPath(logPath);
        jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();

        try {
            structuredLog("warn", "observability.rotated");

            const content = readFileSync(logPath, "utf8");
            expect(content).not.toContain("xxxxx");
            expect(JSON.parse(content.trim())).toMatchObject({
                event: "observability.rotated",
            });
            expect(statSync(logPath).size).toBeLessThan(16 * 1024 * 1024);
        } finally {
            process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = "relative.log";
            structuredLog("warn", "observability.close_rotated_file");
            disableOutput();
        }
    });

    it("disables unsafe application log files once without disrupting stderr", () => {
        const root = temporaryRoot("mira-structured-log-unsafe-");
        const logPath = path.join(root, "dashboard.ndjson");
        writeFileSync(logPath, "");
        linkSync(logPath, path.join(root, "dashboard-linked.ndjson"));
        useApplicationLogPath(logPath);
        const output = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();

        try {
            structuredLog("warn", "observability.unsafe_file");
            structuredLog("warn", "observability.disabled_file");

            expect(output).toHaveBeenCalledTimes(3);
            const disabledEvent = JSON.parse(
                String(output.mock.calls[1]?.[0]).trimEnd()
            ) as Record<string, unknown>;
            expect(disabledEvent).toMatchObject({
                event: "structured_log.application_file_disabled",
                level: "error",
                service: "mira-dashboard",
            });
            expect(readFileSync(logPath, "utf8")).toBe("");
        } finally {
            disableOutput();
        }
    });

    it("disables an application log whose parent directory is unavailable", () => {
        const root = temporaryRoot("mira-structured-log-missing-");
        const logPath = path.join(root, "missing", "dashboard.ndjson");
        useApplicationLogPath(logPath);
        const output = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const disableOutput = enableStructuredLogOutputForTests();

        try {
            structuredLog("warn", "observability.missing_parent");
            mkdirSync(path.dirname(logPath), { recursive: true });
            structuredLog("warn", "observability.still_disabled");

            expect(output).toHaveBeenCalledTimes(3);
            expect(existsSync(logPath)).toBe(false);
        } finally {
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
