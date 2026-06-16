import { describe, expect, it } from "vitest";

import {
    currentIsoString,
    currentYear,
    isoStringFromDate,
    timestampFromDateString,
} from "./date";

describe("date utils", () => {
    it("returns the current timestamp in ISO 8601 format", () => {
        expect(currentIsoString()).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
        );
    });

    it("converts valid date-like values to ISO strings", () => {
        expect(isoStringFromDate(0)).toBe("1970-01-01T00:00:00.000Z");
        expect(isoStringFromDate("2026-06-16T02:00:00.000Z")).toBe(
            "2026-06-16T02:00:00.000Z"
        );
        expect(isoStringFromDate(new Date("2026-06-16T03:00:00.000Z"))).toBe(
            "2026-06-16T03:00:00.000Z"
        );
    });

    it("rejects invalid date-like values", () => {
        expect(() => isoStringFromDate("not a date")).toThrow("Invalid date value");
    });

    it("returns timestamps for valid date strings and null for invalid inputs", () => {
        expect(timestampFromDateString("1970-01-01T00:00:00.000Z")).toBe(0);
        expect(timestampFromDateString("not a date")).toBeNull();
    });

    it("returns the current calendar year", () => {
        const date = new Date();
        expect(currentYear()).toBe(date.getFullYear());
    });
});
