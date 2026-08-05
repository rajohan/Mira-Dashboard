import { describe, expect, test } from "bun:test";

import { createAuthenticationWorkBudget } from "./authenticationWorkBudget.ts";

describe("authentication work budget", () => {
    test("bounds successful and failed work in one rolling window", () => {
        let nowMs = 1000;
        const budget = createAuthenticationWorkBudget(3, 60_000, () => nowMs);

        expect(budget.consume(2)).toEqual({ accepted: true });
        expect(budget.consume()).toEqual({ accepted: true });
        expect(budget.consume()).toEqual({
            accepted: false,
            retryAfterSeconds: 60,
        });
        nowMs += 60_000;
        expect(budget.consume()).toEqual({ accepted: true });
    });

    test("rejects invalid budgets, units, and clocks", () => {
        expect(() => createAuthenticationWorkBudget(0, 1)).toThrow(RangeError);
        expect(() => createAuthenticationWorkBudget(1, 0)).toThrow(RangeError);
        expect(() =>
            createAuthenticationWorkBudget(1, 1, () => Number.NaN).consume()
        ).toThrow(RangeError);
        expect(() => createAuthenticationWorkBudget(1, 1).consume(2)).toThrow(RangeError);
    });
});
