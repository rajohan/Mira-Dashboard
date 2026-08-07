import { expect, spyOn, test } from "bun:test";

import { createStructuredLogger, type StructuredLogSink } from "./structuredLogger.ts";

const identity = Object.freeze({
    bun: "1.4.0-test",
    pid: 123,
    processRole: "web" as const,
    release: "0123456789abcdef",
    service: "mira-dashboard",
});

test("writes bounded NDJSON with fixed envelope fields and selected details", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        now: () => new Date(1_700_000_000_000),
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.info({
        component: "http",
        durationMs: 12,
        event: "http.response.created",
        fields: {
            kind: "http-response",
            method: "GET",
            status: 200,
        },
        outcome: "success",
        requestId: "01900000-0000-7000-8000-000000000001",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    const record = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
    expect(record).toMatchObject({
        component: "http",
        durationMs: 12,
        event: "http.response.created",
        fields: {
            method: "GET",
            status: 200,
        },
        level: "info",
        outcome: "success",
        requestId: "01900000-0000-7000-8000-000000000001",
        timestamp: "2023-11-14T22:13:20.000Z",
        ...identity,
    });
    expect(lines[0]).not.toContain("never-log-this");
});

test("normalizes unknown events and drops extra fields instead of relying on secret names", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });
    const sentinel = "https://gateway.invalid/?token=never-log-this";

    logger.info({
        component: "http",
        event: "http.response.created",
        fields: {
            details: sentinel,
            gatewayCredential: sentinel,
            kind: "http-response",
            method: "GET",
            status: 200,
        } as never,
    });
    logger.info({
        component: sentinel,
        event: sentinel,
        fields: { kind: "unknown", message: sentinel } as never,
    });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        fields: { method: "GET", status: 200 },
    });
    expect(JSON.parse(lines[1] ?? "null")).toMatchObject({
        component: "effect",
        event: "effect.log",
    });
    expect(JSON.parse(lines[1] ?? "null")).not.toHaveProperty("fields");
    expect(lines.join("\n")).not.toContain("never-log-this");
});

test("emits one constant fallback and never throws when the sink fails", () => {
    const fallbacks: string[] = [];
    const sink: StructuredLogSink = {
        flush() {
            throw new Error("flush secret");
        },
        write() {
            throw new Error("write secret");
        },
    };
    const logger = createStructuredLogger({
        fallbackWrite: (line) => fallbacks.push(line),
        identity,
        sink,
    });

    expect(() =>
        logger.error({ component: "http", event: "http.request.failed" })
    ).not.toThrow();
    logger.warn({ component: "http", event: "http.request.failed" });
    logger.flush();
    logger.flush();

    expect(fallbacks).toEqual([
        '{"event":"logger.sink_failed","level":"error","service":"mira-dashboard"}\n',
    ]);
});

test("uses the constant stderr fallback when none is injected", () => {
    const lines: string[] = [];
    const writeSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
    });
    try {
        const logger = createStructuredLogger({
            identity,
            sink: {
                write() {
                    throw new Error("sink failure secret");
                },
            },
        });
        logger.error({ component: "http", event: "http.request.failed" });
        logger.error({ component: "http", event: "http.request.failed" });
    } finally {
        writeSpy.mockRestore();
    }

    expect(lines).toEqual([
        '{"event":"logger.sink_failed","level":"error","service":"mira-dashboard"}\n',
    ]);
});

test("fails closed when a sink method returns asynchronous work", async () => {
    const fallbacks: string[] = [];
    const writeLogger = createStructuredLogger({
        fallbackWrite: (line) => fallbacks.push(`write:${line}`),
        identity,
        sink: {
            write: (async () => {}) as never,
        },
    });
    const flushLogger = createStructuredLogger({
        fallbackWrite: (line) => fallbacks.push(`flush:${line}`),
        identity,
        sink: {
            flush: (async () => {}) as never,
            write() {},
        },
    });

    writeLogger.info({ component: "http", event: "http.request.failed" });
    flushLogger.flush();
    await Promise.resolve();

    expect(fallbacks).toEqual([
        'write:{"event":"logger.sink_failed","level":"error","service":"mira-dashboard"}\n',
        'flush:{"event":"logger.sink_failed","level":"error","service":"mira-dashboard"}\n',
    ]);
});

test("contains an asynchronous fallback double-fault", async () => {
    const options = {
        fallbackWrite() {},
        identity,
        sink: {
            write() {
                throw new Error("sink failure secret");
            },
        },
    };
    Object.defineProperty(options, "fallbackWrite", {
        value: () => Promise.reject(new Error("fallback failure secret")),
    });
    const logger = createStructuredLogger(options);

    expect(() =>
        logger.error({ component: "http", event: "http.request.failed" })
    ).not.toThrow();
    await Bun.sleep(0);
});

test("normalizes invalid dynamic levels and rejects invalid process roles", () => {
    const lines: string[] = [];
    const levels: unknown[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line, level) {
                lines.push(line);
                levels.push(level);
            },
        },
    });
    logger.log("level-secret" as never, {
        component: "http",
        event: "http.request.failed",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({ level: "error" });
    expect(levels).toEqual(["error"]);
    expect(lines[0]).not.toContain("level-secret");
    expect(() =>
        createStructuredLogger({
            identity: { ...identity, processRole: "script" as never },
            sink: { write() {} },
        })
    ).toThrow("Structured logger identity is invalid");
});

test("drops invalid optional identities and rejects invalid fixed envelopes safely", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });
    logger.info({
        component: "http",
        event: "http.completed",
        requestId: "contains a space",
    });
    expect(JSON.parse(lines[0] ?? "null")).not.toHaveProperty("requestId");

    expect(() =>
        createStructuredLogger({
            identity: { ...identity, service: "Invalid Service" },
            sink: {
                write() {
                    throw new Error("unreachable invalid logger sink");
                },
            },
        })
    ).toThrow("Structured logger identity is invalid");
    for (const maximumSerializedBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
        expect(() =>
            createStructuredLogger({
                identity,
                limits: { maximumSerializedBytes },
                sink: { write() {} },
            })
        ).toThrow("Structured logger limits are invalid");
    }
});

test("accepts the exact Bun canary version-with-revision identity", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity: {
            ...identity,
            bun: "1.4.0-canary.1+43783cedd",
        },
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.info({ component: "runtime", event: "runtime.started" });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        bun: "1.4.0-canary.1+43783cedd",
    });
});

test("snapshots limits and bound sink methods at construction", () => {
    const fallbacks: string[] = [];
    const limits = { maximumSerializedBytes: 1 };
    const boundedWrites: string[] = [];
    const boundedLogger = createStructuredLogger({
        fallbackWrite: (line) => fallbacks.push(line),
        identity,
        limits,
        sink: {
            write(line) {
                boundedWrites.push(line);
            },
        },
    });
    limits.maximumSerializedBytes = Number.MAX_SAFE_INTEGER;

    const calls: string[] = [];
    const originalFlush: NonNullable<StructuredLogSink["flush"]> = () => {
        calls.push("original-flush");
    };
    const originalWrite: StructuredLogSink["write"] = () => {
        calls.push("original-write");
    };
    const sink = { flush: originalFlush, write: originalWrite };
    const fixedSinkLogger = createStructuredLogger({ identity, sink });
    sink.write = () => {
        calls.push("replacement-write");
    };
    sink.flush = () => {
        calls.push("replacement-flush");
    };

    boundedLogger.info({ component: "runtime", event: "runtime.started" });
    fixedSinkLogger.info({ component: "runtime", event: "runtime.started" });
    fixedSinkLogger.flush();

    expect(boundedWrites).toEqual([]);
    expect(fallbacks).toEqual([
        '{"event":"logger.sink_failed","level":"error","service":"mira-dashboard"}\n',
    ]);
    expect(calls).toEqual(["original-write", "original-flush"]);
});
