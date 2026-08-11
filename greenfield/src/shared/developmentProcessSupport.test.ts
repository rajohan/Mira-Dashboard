import { describe, expect, test } from "bun:test";

import {
    developmentStartupFailureMessage,
    parseDevelopmentSourceCommit,
} from "./developmentProcessSupport.ts";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

describe("development process support", () => {
    test("accepts exactly one lowercase source commit for either process", () => {
        expect(parseDevelopmentSourceCommit([sourceCommit], "web")).toBe(sourceCommit);
        expect(parseDevelopmentSourceCommit([sourceCommit], "worker")).toBe(sourceCommit);
    });

    test("rejects malformed or additional source arguments with the process label", () => {
        expect(() => parseDevelopmentSourceCommit([], "web")).toThrow(
            "Development web requires one exact source commit"
        );
        expect(() =>
            parseDevelopmentSourceCommit([sourceCommit.toUpperCase()], "worker")
        ).toThrow("Development worker requires one exact source commit");
        expect(() =>
            parseDevelopmentSourceCommit([sourceCommit, "extra"], "web")
        ).toThrow("Development web requires one exact source commit");
    });

    test("includes only bounded single-line Error messages in startup diagnostics", () => {
        expect(
            developmentStartupFailureMessage("web", new Error("Invalid release"))
        ).toBe("Mira Dashboard development web startup failed: Invalid release");
        expect(
            developmentStartupFailureMessage("worker", new Error("unsafe\nsecond line"))
        ).toBe("Mira Dashboard development worker startup failed");
        expect(developmentStartupFailureMessage("worker", "raw failure")).toBe(
            "Mira Dashboard development worker startup failed"
        );
    });
});
