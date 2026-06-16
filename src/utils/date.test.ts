import { describe, expect, it } from "vitest";

import { currentYear } from "./date";

describe("date utils", () => {
    it("returns the current calendar year", () => {
        const date = new Date();
        expect(currentYear()).toBe(date.getFullYear());
    });
});
