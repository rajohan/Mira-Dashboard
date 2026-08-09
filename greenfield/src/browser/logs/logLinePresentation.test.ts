import { describe, expect, test } from "bun:test";

import type { LogLine } from "../../contracts/logs.ts";
import { presentRedactedLogLine } from "./logLinePresentation.ts";

function line(
    value: string,
    overrides: Partial<Pick<LogLine, "severity" | "timestampMs">> = {}
): LogLine {
    return {
        id: "a".repeat(64),
        line: value,
        severity: overrides.severity ?? "unknown",
        ...(overrides.timestampMs === undefined
            ? {}
            : { timestampMs: overrides.timestampMs }),
    };
}

describe("redacted log-line presentation", () => {
    test("projects legacy OpenClaw metadata, source, and message fields", () => {
        const presentation = presentRedactedLogLine(
            line(
                '{"_meta":{"logLevelName":"WARN","date":"2026-06-23T08:00:00.000Z"},"0":"[agent/main] Ready"}'
            )
        );

        expect(presentation).toMatchObject({
            details: [],
            kind: "structured",
            level: "warn",
            message: "Ready",
            source: "main",
            timestampMs: Date.parse("2026-06-23T08:00:00.000Z"),
        });
    });

    test("projects encoded nested records and preserves redacted structured details", () => {
        const presentation = presentRedactedLogLine(
            line(
                String.raw`{"0":"{\"module\":\"worker\",\"message\":\"Credential [REDACTED]\",\"requestId\":\"request-42\"}","level":"debug"}`
            )
        );

        expect(presentation).toMatchObject({
            kind: "structured",
            level: "debug",
            message: "Credential [REDACTED]",
            source: "worker",
        });
        expect(presentation.details).toContainEqual({
            key: "requestId",
            value: "request-42",
        });
        expect(presentation.raw).toContain("[REDACTED]");
    });

    test("uses the OpenClaw positional summary instead of its encoded subsystem descriptor", () => {
        const presentation = presentRedactedLogLine(
            line(
                String.raw`{"0":"{\"subsystem\":\"gateway/ws\"}","1":"↔ response ✓ request-42","_meta":{"date":"2026-08-10T01:02:03.000Z","logLevelName":"INFO","name":"{\"subsystem\":\"gateway/ws\"}"}}`
            )
        );

        expect(presentation).toMatchObject({
            kind: "structured",
            level: "info",
            message: "↔ response ✓ request-42",
            source: "gateway/ws",
            timestampMs: Date.parse("2026-08-10T01:02:03.000Z"),
        });
        expect(presentation.message).not.toContain("subsystem");
    });

    test("parses traditional kernel and syslog date, process, priority, and facility prefixes", () => {
        const referenceTimestampMs = new Date(2026, 7, 10, 12).getTime();
        const kernel = presentRedactedLogLine(
            line("Aug 10 01:23:45 host kernel: [123.456] device ready"),
            { referenceTimestampMs, sourceId: "host.kern" }
        );
        const auth = presentRedactedLogLine(
            line("<34>Aug 10 01:24:45 host sshd[42]: Accepted publickey"),
            { referenceTimestampMs, sourceId: "host.auth" }
        );

        expect(kernel).toMatchObject({
            kind: "raw",
            level: "unknown",
            message: "[123.456] device ready",
            source: "kernel",
            timestampMs: new Date(2026, 7, 10, 1, 23, 45).getTime(),
        });
        expect(auth).toMatchObject({
            facility: "auth",
            level: "error",
            message: "Accepted publickey",
            source: "sshd",
            timestampMs: new Date(2026, 7, 10, 1, 24, 45).getTime(),
        });
    });

    test("parses ISO syslog and package timestamps with trustworthy source fallbacks", () => {
        const system = presentRedactedLogLine(
            line(
                "2026-08-10T01:25:45.123456+02:00 host systemd[1]: Started reviewed service"
            ),
            { sourceId: "host.syslog" }
        );
        const packageLine = presentRedactedLogLine(
            line("2026-08-10 01:26:45 status installed safe-package:amd64 1.0"),
            { sourceId: "host.dpkg" }
        );

        expect(system).toMatchObject({
            message: "Started reviewed service",
            source: "systemd",
            timestampMs: Date.parse("2026-08-10T01:25:45.123+02:00"),
        });
        expect(packageLine).toMatchObject({
            message: "status installed safe-package:amd64 1.0",
            source: "dpkg",
            timestampMs: Date.parse("2026-08-10 01:26:45"),
        });
    });

    test("normalizes textual level and bracketed source prefixes", () => {
        const presentation = presentRedactedLogLine(
            line("2026-08-10T01:27:45.000Z [WARN] [http] request rejected"),
            { sourceId: "host.syslog" }
        );

        expect(presentation).toMatchObject({
            level: "warn",
            message: "request rejected",
            source: "http",
            timestampMs: Date.parse("2026-08-10T01:27:45.000Z"),
        });
    });

    test("bounds field count, nesting depth, and rendered value length", () => {
        const fields = Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [
                `field${index}`,
                index === 0
                    ? {
                          nested: {
                              deeper: {
                                  deepest: "x".repeat(500),
                              },
                          },
                      }
                    : index,
            ])
        );
        const presentation = presentRedactedLogLine(
            line(JSON.stringify({ event: "worker.completed", ...fields }))
        );

        expect(presentation.message).toBe("worker.completed");
        expect(presentation.details).toHaveLength(8);
        expect(presentation.omittedFieldCount).toBe(4);
        expect(presentation.detailsTruncated).toBe(true);
        expect(presentation.details.every(({ value }) => value.length <= 240)).toBe(true);
    });

    test("keeps malformed JSON and markup as one inert raw redacted fallback", () => {
        const raw = '{bad json Credential [REDACTED] <script>alert("x")</script>';
        const presentation = presentRedactedLogLine(
            line(raw, { severity: "error", timestampMs: 1_800_000_000_000 })
        );

        expect(presentation).toEqual({
            details: [],
            detailsTruncated: false,
            kind: "raw",
            level: "error",
            message: raw,
            omittedFieldCount: 0,
            raw,
            timestampMs: 1_800_000_000_000,
        });
    });

    test("uses the server projection when structured metadata is absent", () => {
        const presentation = presentRedactedLogLine(
            line("gateway: connected", {
                severity: "info",
                timestampMs: 1_800_000_000_000,
            })
        );

        expect(presentation).toMatchObject({
            kind: "raw",
            level: "info",
            message: "connected",
            source: "gateway",
            timestampMs: 1_800_000_000_000,
        });
    });
});
