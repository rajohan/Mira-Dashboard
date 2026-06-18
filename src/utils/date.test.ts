import { describe, expect, it } from "vitest";

import {
    APP_LOCALE_CODE,
    APP_TIME_ZONE,
    appTimeZoneParts,
    appZonedUtcDate,
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

    it("returns timestamps for valid date strings and undefined for invalid inputs", () => {
        expect(timestampFromDateString("1970-01-01T00:00:00.000Z")).toBe(0);
        expect(timestampFromDateString("not a date")).toBeUndefined();
    });

    it("returns the current calendar year", () => {
        const expectedYear = appTimeZoneParts(new Date()).year;
        expect(currentYear()).toBe(expectedYear);
    });

    it("returns app timezone date parts", () => {
        const date = new Date("2026-06-17T22:30:45.000Z");

        expect(APP_TIME_ZONE).toBe("Europe/Oslo");
        expect(APP_LOCALE_CODE).toBe("en-US");
        expect(appTimeZoneParts(date)).toEqual({
            day: 18,
            hour: 0,
            minute: 30,
            month: 6,
            second: 45,
            weekday: "Thursday",
            year: 2026,
        });
        expect(appZonedUtcDate(date).toISOString()).toBe("2026-06-18T00:30:45.000Z");
    });

    it("returns exact app timezone midnight without normalizing to 24:00", () => {
        const date = new Date("2026-06-17T22:00:00.000Z");

        expect(appTimeZoneParts(date)).toEqual({
            day: 18,
            hour: 0,
            minute: 0,
            month: 6,
            second: 0,
            weekday: "Thursday",
            year: 2026,
        });
        expect(appZonedUtcDate(date).toISOString()).toBe("2026-06-18T00:00:00.000Z");
    });
});
