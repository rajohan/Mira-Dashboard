import { describe, expect, test } from "bun:test";

import { classifyResourceBudgetUnitCollection } from "./resourceBudgetOrchestration.ts";

describe("resource-budget orchestration", () => {
    test("accepts only an explicit not-found load state as collected", () => {
        expect(
            classifyResourceBudgetUnitCollection({
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=not-found\n",
            })
        ).toEqual({ state: "collected" });
        expect(
            classifyResourceBudgetUnitCollection({
                exitCode: 0,
                stderr: "",
                stdout: "LoadState=loaded\n",
            })
        ).toEqual({ state: "pending" });
    });

    test("surfaces systemctl failures instead of treating them as cleanup", () => {
        const result = classifyResourceBudgetUnitCollection({
            exitCode: 1,
            stderr: "Failed to connect to bus",
            stdout: "",
        });

        expect(result.state).toBe("failed");
        if (result.state !== "failed") throw new Error("Expected failed inspection");
        expect(result.error._tag).toBe("ResourceBudgetOrchestrationError");
        expect(result.error.operation).toBe("inspect-unit-collection");
        expect(result.error.cause).toEqual({
            exitCode: 1,
            stderr: "Failed to connect to bus",
        });
    });
});
