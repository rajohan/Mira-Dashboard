import { describe, expect, test } from "bun:test";

import { parseSseMemoryCliArguments } from "./runSseMemoryQualification.ts";

const unitName = "mira-dashboard-sse-memory-019fcb3d-6cf6-7000-8000-000000000001";

describe("SSE memory qualification CLI", () => {
    test("uses parent mode by default", () => {
        expect(parseSseMemoryCliArguments([])).toEqual({ mode: "parent" });
    });

    test("accepts only one absolute child result path", () => {
        expect(
            parseSseMemoryCliArguments([
                "--child",
                "--result=/tmp/qualification/evidence.json",
                `--unit=${unitName}`,
            ])
        ).toEqual({
            mode: "child",
            resultPath: "/tmp/qualification/evidence.json",
            unitName,
        });
        for (const arguments_ of [
            ["--child"],
            ["--child", "--result=relative.json"],
            ["--result=/tmp/evidence.json", "--child"],
            ["--unknown"],
        ]) {
            expect(() => parseSseMemoryCliArguments(arguments_)).toThrow("Usage:");
        }
        expect(() =>
            parseSseMemoryCliArguments([
                "--child",
                "--result=/tmp/evidence.json",
                "--unit=invalid",
            ])
        ).toThrow("unit name is invalid");
    });
});
