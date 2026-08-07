import { describe, expect, test } from "bun:test";

import { findTestOutputViolation, TestOutputInspector } from "./testOutputPolicy.ts";

describe("test output policy", () => {
    test.each([
        [
            "React missing act wrapper",
            "Warning: An update to Dashboard inside a test was not wrapped in act(...).",
            "React update was not wrapped in act(...)",
        ],
        [
            "React act environment",
            "The current testing environment is not configured to support act(...)",
            "React act environment is not configured",
        ],
        [
            "Headless UI animations fallback",
            "Headless UI has polyfilled `Element.prototype.getAnimations` for your tests.",
            "Headless UI Web Animations test shim is missing",
        ],
        [
            "Bun main-thread panic",
            "panic(main thread): assertion failed",
            "Bun main thread panicked",
        ],
        [
            "Bun crash banner",
            "Oh no: Bun has crashed. This indicates a bug in Bun.",
            "Bun crashed",
        ],
    ])("rejects %s", (_name, output, description) => {
        expect(findTestOutputViolation(output)).toEqual({ description });
    });

    test("allows unrelated warnings", () => {
        expect(findTestOutputViolation("Warning: fixture intentionally retried")).toBe(
            undefined
        );
    });

    test("finds a warning split across stream chunks", () => {
        const inspector = new TestOutputInspector();

        inspector.inspect("Warning: update was not wrap");
        expect(inspector.violation).toBe(undefined);

        inspector.inspect("ped in act(...)\n");
        expect(inspector.violation).toEqual({
            description: "React update was not wrapped in act(...)",
        });
    });
});
