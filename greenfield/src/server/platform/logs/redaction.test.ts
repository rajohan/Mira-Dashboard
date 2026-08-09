import { describe, expect, test } from "bun:test";

import { logLineMaximumCharacters } from "../../../contracts/logs.ts";
import { classifyLogSeverity, parseLogTimestamp, redactLogLine } from "./redaction.ts";

describe("log redaction", () => {
    test("redacts authorization, assignments, URL credentials, query secrets, and known tokens", () => {
        const line = [
            "Authorization: Bearer abc.def.ghi",
            "password=hunter2",
            "https://user:pass@example.test/path?token=value&safe=yes",
            "sk-abcdefghijklmnop",
            "ghp_abcdefghijklmnopqrstuvwxyz",
            "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
        ].join(" ");
        const result = redactLogLine(line);
        expect(result).not.toContain("abc.def.ghi");
        expect(result).not.toContain("hunter2");
        expect(result).not.toContain("user:pass");
        expect(result).not.toContain("token=value");
        expect(result).not.toContain("sk-abcdefghijklmnop");
        expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
        expect(result.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(6);
    });

    test("replaces NUL and truncates before the contract boundary", () => {
        const result = redactLogLine(
            `start\0${"x".repeat(logLineMaximumCharacters * 2)}`
        );
        expect(result).not.toContain("\0");
        expect(result.length).toBeLessThanOrEqual(logLineMaximumCharacters);
        expect(result).toEndWith("… [truncated]");
    });

    test("projects severity and explicit UTC timestamps without parsing arbitrary JSON", () => {
        const line = '{"level":"warning","time":"2026-08-09T12:34:56.000Z"}';
        expect(classifyLogSeverity(line)).toBe("warn");
        expect(parseLogTimestamp(line)).toBe(Date.parse("2026-08-09T12:34:56.000Z"));
        expect(classifyLogSeverity("ordinary output")).toBe("unknown");
        expect(parseLogTimestamp("timestamp=tomorrow")).toBeUndefined();
    });
});
