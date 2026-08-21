import { describe, expect, test } from "bun:test";

import { logLineMaximumCharacters } from "../../../contracts/logs.ts";
import { classifyLogSeverity, parseLogTimestamp, redactLogLine } from "./redaction.ts";

describe("log redaction", () => {
    test("redacts authorization, assignments, URL credentials, query secrets, and known tokens", () => {
        const privateFragments = [
            "abc.def.ghi",
            "hunter2",
            "user:pass",
            "token=value",
            "sk-abcdefghijklmnop",
            "ghp_abcdefghijklmnopqrstuvwxyz",
            "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
        ] as const;
        const result = [
            "Authorization: Bearer abc.def.ghi",
            "password=hunter2",
            "https://user:pass@example.test/path?token=value&safe=yes",
            "sk-abcdefghijklmnop",
            "ghp_abcdefghijklmnopqrstuvwxyz",
            "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
        ].map((line) => redactLogLine(line));
        for (const fragment of privateFragments) {
            expect(result.join("\n")).not.toContain(fragment);
        }
        expect(result.every((line) => line.includes("[REDACTED]"))).toBe(true);
    });

    test("removes complete structured and header credential values", () => {
        const privateFragments = [
            "private json suffix",
            "digest-private-nonce",
            "embedded-private-nonce",
            "cookie-private-value",
            "set-cookie-private-value",
        ] as const;
        const lines = [
            '{"password":"private json suffix","message":"retained"}',
            'Authorization: Digest username="public-name", nonce="digest-private-nonce", response="private-response"',
            '{"message":"Authorization: Digest nonce=embedded-private-nonce"}',
            "Cookie: session=cookie-private-value; theme=dark",
            "Set-Cookie: session=set-cookie-private-value; HttpOnly; Secure",
        ];

        const output = lines.map((line) => redactLogLine(line));
        expect(output[0]).toContain('"message":"retained"');
        for (const fragment of privateFragments) {
            expect(output.join("\n")).not.toContain(fragment);
        }
        expect(output.every((line) => line.includes("[REDACTED]"))).toBe(true);
    });

    test("removes complete nested credential values without expanding untrusted JSON", () => {
        const privateFragments = [
            "first-private",
            "second-private",
            "object-private",
            "backup-private",
            "malformed-private",
        ] as const;
        const output = [
            '{"password":["first-private",{"nested":"second-private"}],"safe":"retained"}',
            '{"credentials":{"primary":"object-private","backup":{"value":"backup-private"}},"safe":true}',
            '{"password":["malformed-private",{"unterminated":true}',
        ].map((line) => redactLogLine(line));

        expect(output[0]).toBe('{"password":[REDACTED],"safe":"retained"}');
        expect(output[1]).toBe('{"credentials":[REDACTED],"safe":true}');
        expect(output[2]).toBe('{"password":[REDACTED]');
        for (const fragment of privateFragments) {
            expect(output.join("\n")).not.toContain(fragment);
        }
    });

    test("fails closed for malformed value suffixes and unquoted credential headers", () => {
        const privateFragments = [
            "structured-private-suffix",
            "quoted-private-suffix",
            "digest-private-nonce",
            "digest-private-response",
            "cookie-private-primary",
            "cookie-private-secondary",
        ] as const;
        const output = [
            '{"password":["private"]structured-private-suffix,"safe":"retained"}',
            '{"password":"private"quoted-private-suffix,"safe":"retained"}',
            'authorization=Digest username="public", nonce="digest-private-nonce", response="digest-private-response"',
            "cookie=session=cookie-private-primary; admin=cookie-private-secondary",
        ].map((line) => redactLogLine(line));

        expect(output[0]).toBe('{"password":[REDACTED],"safe":"retained"}');
        expect(output[1]).toBe('{"password":[REDACTED],"safe":"retained"}');
        expect(output[2]).toBe("authorization=[REDACTED]");
        expect(output[3]).toBe("cookie=[REDACTED]");
        for (const fragment of privateFragments) {
            expect(output.join("\n")).not.toContain(fragment);
        }
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
