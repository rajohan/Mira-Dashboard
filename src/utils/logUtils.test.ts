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

    it("parses plain text subsystem prefixes", () => {
        expect(parseLogLine("[agent/main] hello", 2)).toMatchObject({
            subsystem: "main",
            msg: "hello",
        });
        expect(parseLogLine("cron: running", 3)).toMatchObject({
            subsystem: "cron",
            msg: "running",
        });
    });

    it("formats log time and colors", () => {
        expect(formatLogTime()).toBe("");
        expect(formatLogTime("2026-05-10T06:07:08.000Z")).toMatch(/08:07:08|06:07:08/u);
        expect(getLevelColor("fatal")).toContain("red");
        expect(getLevelColor("warn")).toContain("yellow");
        expect(getLevelColor("debug")).toContain("primary");
        expect(getLevelColor("unknown")).toContain("primary");
        expect(getSubsystemColor()).toBe("");
        expect(getSubsystemColor("exec")).toBe("text-green-400");
        expect(getSubsystemColor("unknown")).toBe("text-purple-400");
    });
});
