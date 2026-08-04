import { describe, expect, test } from "bun:test";

import {
    formatSseMemoryQualificationError,
    parseSseMemoryCliArguments,
} from "./runSseMemoryQualification.ts";

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

    test("formats nested and aggregate CLI failures without losing causes", () => {
        const nested = formatSseMemoryQualificationError(
            new Error("outer failure", { cause: new Error("inner failure") })
        );
        expect(nested).toContain("outer failure");
        expect(nested).toContain("inner failure");

        const aggregate = formatSseMemoryQualificationError(
            new AggregateError(
                [new Error("operation failed"), new Error("cleanup failed")],
                "combined failure"
            )
        );
        expect(aggregate).toContain("combined failure");
        expect(aggregate).toContain("operation failed");
        expect(aggregate).toContain("cleanup failed");
        expect(formatSseMemoryQualificationError("not an error")).toBe(
            "SSE memory qualification failed"
        );
    });
});
