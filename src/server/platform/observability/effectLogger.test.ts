import { expect, test } from "bun:test";

import { Effect, Logger } from "effect";

import { createEffectLoggerLayer } from "./effectLogger.ts";
import { createStructuredLogger } from "./structuredLogger.ts";

test("preserves safe annotations and replaces the default Effect logger", async () => {
    const lines: string[] = [];
    const structuredLogger = createStructuredLogger({
        identity: {
            bun: "1.4.0-test",
            pid: 123,
            processRole: "web",
            release: "test-revision",
            service: "mira-dashboard",
        },
        sink: {
            write(line) {
                lines.push(line);
            },
        },
    });
    const layer = createEffectLoggerLayer(structuredLogger, "Debug");
    const program = Effect.gen(function* () {
        const activeLoggers = yield* Effect.service(Logger.CurrentLoggers);
        yield* Effect.logInfo("runner failed", { password: "message-secret" }).pipe(
            Effect.annotateLogs({
                component: "realtime-event-pump",
                event: "realtime.runner.failed",
                failureKind: "unexpected-runner-defect",
                password: "annotation-secret",
                requestId: "01900000-0000-7000-8000-000000000001",
            })
        );
        return {
            includesDefault: activeLoggers.has(Logger.defaultLogger),
            loggerCount: activeLoggers.size,
        };
    }).pipe(Effect.provide(layer));

    expect(await Effect.runPromise(program)).toEqual({
        includesDefault: false,
        loggerCount: 1,
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
    expect(record).toMatchObject({
        component: "realtime-event-pump",
        event: "realtime.runner.failed",
        fields: {
            failureKind: "unexpected-runner-defect",
        },
        level: "info",
        requestId: "01900000-0000-7000-8000-000000000001",
    });
    expect(lines[0]).not.toContain("message-secret");
    expect(lines[0]).not.toContain("annotation-secret");
    expect(lines[0]).not.toContain("runner failed");
});
