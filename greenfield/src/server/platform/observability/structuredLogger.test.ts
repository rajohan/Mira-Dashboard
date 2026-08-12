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

test("records realtime wake failures without exposing raw failure text", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.warn({
        component: "realtime-event-pump",
        event: "realtime.wake.failed",
        failure: new Error("never-log-this"),
        outcome: "server-error",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "realtime-event-pump",
        event: "realtime.wake.failed",
        level: "warn",
        outcome: "server-error",
    });
    expect(JSON.parse(lines[0] ?? "null")).toHaveProperty("failure");
    expect(lines[0]).not.toContain("never-log-this");
});

test("preserves Gateway realtime bridge failures without exposing raw causes", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.error({
        component: "gateway-realtime-bridge",
        event: "gateway.realtime.bridge_failed",
        failure: new Error("wss://gateway.invalid/?token=never-log-this"),
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "gateway-realtime-bridge",
        event: "gateway.realtime.bridge_failed",
        level: "error",
    });
    expect(lines[0]).not.toContain("never-log-this");
});

test("preserves the reviewed cron expiry failure event", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.warn({
        component: "openclaw-cron-expiry",
        event: "openclaw_cron.expiry_reconciliation.failed",
        failure: new Error("OpenClaw cron expiry reconciliation failed: conflict"),
        outcome: "server-error",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "openclaw-cron-expiry",
        event: "openclaw_cron.expiry_reconciliation.failed",
        level: "warn",
        outcome: "server-error",
    });
});

test("records only fingerprinted session-audit settlement failures", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });
    const sensitiveKey = "agent:private-person:main";
    const targetFingerprint = `sha256:${"a".repeat(64)}`;

    logger.error({
        component: "gateway-session-audit",
        event: "gateway.session.audit_settlement_failed",
        failure: new Error(`database failed for ${sensitiveKey}`),
        fields: {
            action: "delete",
            auditOutcome: "succeeded",
            kind: "gateway-session-audit-settlement",
            targetFingerprint,
        },
        outcome: "server-error",
        requestId: "01900000-0000-7000-8000-000000000001",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "gateway-session-audit",
        event: "gateway.session.audit_settlement_failed",
        fields: {
            action: "delete",
            auditOutcome: "succeeded",
            targetFingerprint,
        },
        level: "error",
        outcome: "server-error",
    });
    expect(lines[0]).not.toContain(sensitiveKey);
});

test("records only classified OpenClaw cron audit settlement fields", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });
    const sensitiveId = "private-nightly-provider-id";
    const targetFingerprint = `sha256:${"b".repeat(64)}`;

    logger.warn({
        component: "openclaw-cron-audit",
        event: "openclaw_cron.audit_settlement.failed",
        failure: new Error(`database failed for ${sensitiveId}`),
        fields: {
            kind: "openclaw-cron-audit-settlement",
            operation: "reconcile-expired",
            settlement: "partial",
            targetFingerprint,
        },
        outcome: "server-error",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "openclaw-cron-audit",
        event: "openclaw_cron.audit_settlement.failed",
        fields: {
            operation: "reconcile-expired",
            settlement: "partial",
            targetFingerprint,
        },
        level: "warn",
        outcome: "server-error",
    });
    expect(lines[0]).not.toContain(sensitiveId);
});

test("records only classified OpenClaw settings audit settlement fields", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });
    const sensitiveTarget = "skill:private-skill-key";
    const targetFingerprint = `sha256:${"c".repeat(64)}`;

    logger.warn({
        component: "openclaw-settings-audit",
        event: "openclaw_settings.audit_settlement.failed",
        failure: new Error(`database failed for ${sensitiveTarget}`),
        fields: {
            kind: "openclaw-settings-audit-settlement",
            operation: "set-skill-enabled",
            settlement: "partial",
            targetFingerprint,
        },
        outcome: "server-error",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "openclaw-settings-audit",
        event: "openclaw_settings.audit_settlement.failed",
        fields: {
            operation: "set-skill-enabled",
            settlement: "partial",
            targetFingerprint,
        },
        level: "warn",
        outcome: "server-error",
    });
    expect(lines[0]).not.toContain(sensitiveTarget);
});

test("records bounded OpenClaw settings mutation queue observations", () => {
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
        component: "openclaw-settings",
        durationMs: 125,
        event: "openclaw_settings.mutation_queue.waited",
        fields: {
            kind: "openclaw-settings-mutation-queue",
            queueDepth: 2,
        },
        outcome: "success",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "openclaw-settings",
        durationMs: 125,
        event: "openclaw_settings.mutation_queue.waited",
        fields: { queueDepth: 2 },
        level: "info",
        outcome: "success",
    });
});

test("records only fixed log-maintenance audit settlement fields", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.error({
        component: "logs-maintenance-audit",
        event: "logs.maintenance.audit_settlement_failed",
        fields: {
            dryRun: true,
            kind: "logs-maintenance-audit-settlement",
            policyId: "docker-managed",
            settlement: "queued",
        },
        outcome: "server-error",
    });

    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        component: "logs-maintenance-audit",
        event: "logs.maintenance.audit_settlement_failed",
        fields: {
            dryRun: true,
            policyId: "docker-managed",
            settlement: "queued",
        },
        level: "error",
        outcome: "server-error",
    });
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

test("filters below the configured process log level", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
        identity,
        minimumLevel: "warn",
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });

    logger.debug({ component: "runtime", event: "runtime.started" });
    logger.info({ component: "runtime", event: "runtime.started" });
    logger.warn({ component: "runtime", event: "runtime.started" });
    logger.error({ component: "runtime", event: "runtime.start_failed" });

    expect(
        lines.map((line) => {
            const record = JSON.parse(line) as { readonly level?: unknown };
            return record.level;
        })
    ).toEqual(["warn", "error"]);
    expect(() =>
        createStructuredLogger({
            identity,
            minimumLevel: "trace" as never,
            sink: { write() {} },
        })
    ).toThrow("Structured logger minimum level is invalid");
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
