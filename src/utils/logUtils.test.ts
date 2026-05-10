import { describe, expect, it } from "vitest";

import {
    formatLogTime,
    getLevelColor,
    getSubsystemColor,
    parseLogLine,
} from "./logUtils";

describe("log utils", () => {
    it("ignores blank log lines", () => {
        expect(parseLogLine("")).toBeNull();
        expect(parseLogLine("   ")).toBeNull();
    });

    it("parses structured JSON logs", () => {
        const entry = parseLogLine(
            JSON.stringify({
                level: "warn",
                time: "2026-05-10T06:07:08.000Z",
                msg: "gateway: reconnecting",
            }),
            1
        );

        expect(entry).toMatchObject({
            level: "warn",
            ts: "2026-05-10T06:07:08.000Z",
            subsystem: "gateway",
            msg: "reconnecting",
        });
        expect(entry?.id).toContain("-1");
    });

    it("parses JSON with _meta level/date", () => {
        const entry = parseLogLine(
            JSON.stringify({
                _meta: { logLevelName: "ERROR", date: "2026-05-10T06:07:08.000Z" },
                "0": "[exec] command done",
            }),
            10
        );

        expect(entry).toMatchObject({
            level: "error",
            ts: "2026-05-10T06:07:08.000Z",
            subsystem: "exec",
            msg: "command done",
        });
    });

    it("parses JSON with lvl and timestamp fields", () => {
        const entry = parseLogLine(
            JSON.stringify({
                lvl: "debug",
                timestamp: "2026-01-01T00:00:00Z",
                "0": "hello",
            }),
            11
        );

        expect(entry).toMatchObject({ level: "debug", ts: "2026-01-01T00:00:00Z" });
    });

    it("parses JSON with nested positional args", () => {
        const entry = parseLogLine(
            JSON.stringify({
                "0": '{"subsystem":"memory","msg":"cached"}',
                "1": "fallback",
            }),
            12
        );

        expect(entry).toMatchObject({ subsystem: "memory", msg: "cached" });
    });

    it("parses JSON with positional number args", () => {
        const entry = parseLogLine(JSON.stringify({ "0": 42 }), 13);

        expect(entry?.msg).toBe("42");
    });

    it("parses JSON with positional-two fallback", () => {
        const entry = parseLogLine(
            JSON.stringify({ "0": null, "1": null, "2": "third arg message" }),
            14
        );

        expect(entry?.msg).toContain("third arg");
    });

    it("parses JSON with msg/message fallback", () => {
        const entry = parseLogLine(JSON.stringify({ message: "fallback message" }), 15);

        expect(entry?.msg).toContain("fallback message");
    });

    it("parses JSON with non-string msg as stringifyCompact", () => {
        const entry = parseLogLine(JSON.stringify({ msg: { key: "val" } }), 16);

        expect(entry?.msg).toContain("key");
    });

    it("parses JSON where entire parsed object is stringified when no msg found", () => {
        const entry = parseLogLine(JSON.stringify({ "0": "" }), 17);

        expect(entry).not.toBeNull();
        expect(entry?.msg).toBeTruthy();
    });

    it("parses plain text with prefix like 'agent/subsystem: msg'", () => {
        const entry = parseLogLine("[agent/sub] doing stuff", 20);

        expect(entry).toMatchObject({ subsystem: "sub", msg: "doing stuff" });
    });

    it("parses plain text with colon prefix", () => {
        const entry = parseLogLine("tools: hammer time", 21);

        expect(entry).toMatchObject({ subsystem: "tools", msg: "hammer time" });
    });

    it("parses plain text without prefix", () => {
        const entry = parseLogLine("just a plain log line", 22);

        expect(entry).toMatchObject({ subsystem: "", msg: "just a plain log line" });
    });

    it("handles JSON preceded by non-brace text", () => {
        const entry = parseLogLine(
            'prefix {"level":"info","time":"2026-01-01T00:00:00Z","0":"hello"}',
            23
        );

        expect(entry).toMatchObject({ level: "info", msg: "hello" });
    });

    it("handles non-JSON that starts with brace but fails parse", () => {
        const entry = parseLogLine("{broken json text", 24);

        expect(entry).not.toBeNull();
        expect(entry?.raw).toBe("{broken json text");
    });

    it("formats log time and colors", () => {
        expect(formatLogTime()).toBe("");
        expect(formatLogTime("2026-05-10T06:07:08.000Z")).toMatch(/08:07:08|06:07:08/u);
        // Invalid date string falls back to --:--:-- via formatOsloTime catch
        expect(formatLogTime("not-a-date")).toBe("--:--:--");
    });

    it("returns correct level colors for all levels", () => {
        expect(getLevelColor("fatal")).toContain("red");
        expect(getLevelColor("error")).toContain("red");
        expect(getLevelColor("warn")).toContain("yellow");
        expect(getLevelColor("info")).toContain("blue");
        expect(getLevelColor("debug")).toContain("primary");
        expect(getLevelColor("trace")).toContain("primary");
        expect(getLevelColor("unknown")).toContain("primary");
    });

    it("returns correct subsystem colors", () => {
        expect(getSubsystemColor()).toBe("");
        expect(getSubsystemColor("exec")).toBe("text-green-400");
        expect(getSubsystemColor("tools")).toBe("text-orange-400");
        expect(getSubsystemColor("agent")).toBe("text-purple-400");
        expect(getSubsystemColor("gateway")).toBe("text-cyan-400");
        expect(getSubsystemColor("cron")).toBe("text-pink-400");
        expect(getSubsystemColor("session")).toBe("text-indigo-400");
        expect(getSubsystemColor("http")).toBe("text-teal-400");
        expect(getSubsystemColor("ws")).toBe("text-amber-400");
        expect(getSubsystemColor("memory")).toBe("text-emerald-400");
        expect(getSubsystemColor("unknown")).toBe("text-purple-400");
    });

    it("normalizes agent/ prefix in subsystem", () => {
        const entry = parseLogLine("[agent/gateway] hello", 30);
        expect(entry?.subsystem).toBe("gateway");
    });
});
