import { describe, expect, test } from "bun:test";

import { formatMoltbookTime, truncateMoltbookText } from "./moltbookPresentation.ts";

describe("Moltbook presentation", () => {
    test("truncates by Unicode code point without splitting surrogate pairs", () => {
        expect(truncateMoltbookText("A😀B", 2)).toBe("A😀…");
        expect(truncateMoltbookText("A😀B", 3)).toBe("A😀B");
    });

    test("contains invalid timestamps without breaking the card tree", () => {
        expect(formatMoltbookTime(Number.NaN)).toBe("Unknown time");
        expect(formatMoltbookTime(Number.POSITIVE_INFINITY)).toBe("Unknown time");
    });
});
