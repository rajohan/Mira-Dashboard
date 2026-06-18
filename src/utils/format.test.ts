import { describe, expect, it } from "vitest";

import {
    APP_TIME_ZONE,
    appTimeOfDayToUtcTimeOfDay,
    formatDate,
    formatDateStamp,
    formatDuration,
    formatLoad,
    formatOsloClock,
    formatOsloDate,
    formatOsloTime,
    formatSize,
    formatTokenCount,
    formatTokens,
    formatUptime,
    formatUtcTimeOfDayInAppTimeZone,
    formatWeekdayShort,
    getTokenPercent,
} from "./format";

describe("format utils", () => {
    const date = new Date(Date.UTC(2026, 4, 10, 6, 7, 8));

    it("formats dates and times", () => {
        expect(APP_TIME_ZONE).toBe("Europe/Oslo");
        expect(formatDate(date)).toBe("10.05.2026, 08:07");
        expect(formatOsloClock("2026-05-10T06:07:08.000Z")).toBe("08:07");
        expect(formatDateStamp(date)).toBe("2026-05-10");
        expect(formatOsloTime(date)).toBe("08:07:08");
        expect(formatOsloDate(date)).toBe("Sunday 10. May 2026");
        expect(formatWeekdayShort(date)).toBe("Sun");
    });

    it("converts schedule time-of-day values between UTC and Oslo", () => {
        const summerReference = "2026-06-18T02:10:00.000Z";
        const winterReference = "2026-01-18T03:10:00.000Z";

        expect(formatUtcTimeOfDayInAppTimeZone("02:10", summerReference)).toBe("04:10");
        expect(formatUtcTimeOfDayInAppTimeZone("03:10", winterReference)).toBe("04:10");
        expect(formatUtcTimeOfDayInAppTimeZone("23:30", "2026-03-28T23:30:00.000Z")).toBe(
            "00:30"
        );
        expect(formatUtcTimeOfDayInAppTimeZone("00:00", 0)).toBe("01:00");
        expect(formatUtcTimeOfDayInAppTimeZone("02:10")).toMatch(/^\d{2}:\d{2}$/u);
        expect(formatUtcTimeOfDayInAppTimeZone("02:10", "not-a-date")).toMatch(
            /^\d{2}:\d{2}$/u
        );
        expect(appTimeOfDayToUtcTimeOfDay("04:10", summerReference)).toBe("02:10");
        expect(appTimeOfDayToUtcTimeOfDay("04:10", winterReference)).toBe("03:10");
        expect(appTimeOfDayToUtcTimeOfDay("01:00", 0)).toBe("00:00");
        expect(appTimeOfDayToUtcTimeOfDay("04:10", "not-a-date")).toMatch(
            /^\d{2}:\d{2}$/u
        );
        expect(appTimeOfDayToUtcTimeOfDay("04:10")).toMatch(/^\d{2}:\d{2}$/u);
        expect(formatUtcTimeOfDayInAppTimeZone(undefined)).toBe("--:--");
        expect(formatUtcTimeOfDayInAppTimeZone("bad-time")).toBe("--:--");
        expect(appTimeOfDayToUtcTimeOfDay("bad-time")).toBe("bad-time");
    });

    it("handles invalid date inputs gracefully", () => {
        const invalidDate = new Date(Number("NaN"));
        expect(formatDate("not-a-date")).toBe("not-a-date");
        expect(formatDate(Symbol("bad-date") as unknown as string)).toBe(
            "Symbol(bad-date)"
        );
        expect(formatOsloClock("not-a-date")).toBe("--:--");
        expect(formatOsloClock(Symbol("bad-date") as unknown as string)).toBe("--:--");
        expect(formatDate(Infinity)).toBe("Infinity");
        expect(formatDateStamp(invalidDate)).toBe("unknown-date");
        expect(formatDateStamp("bad-date" as unknown as Date)).toBe("unknown-date");
        expect(formatOsloTime("bad-date" as unknown as Date)).toBe("--:--:--");
        expect(formatOsloDate(invalidDate)).toBe("Unknown date");
        expect(formatOsloDate("bad-date" as unknown as Date)).toBe("Unknown date");
        expect(formatWeekdayShort(invalidDate)).toBe("---");
        expect(formatWeekdayShort("bad-date" as unknown as Date)).toBe("---");
        expect(formatDuration(Number("NaN"))).toBe("Unknown");
    });

    it("formats durations safely", () => {
        expect(formatDuration(undefined)).toBe("Unknown");
        const missingTimestamp: number | undefined = undefined;
        expect(formatDuration(missingTimestamp)).toBe("Unknown");
        expect(formatDuration(Date.now())).toMatch(/less than a minute|minute/u);
    });

    it("formats system values", () => {
        expect(formatUptime(59)).toBe("0m");
        expect(formatUptime(3600 + 120)).toBe("1h 2m");
        expect(formatUptime(86_400 + 7200)).toBe("1d 2h");
        expect(formatSize(512)).toBe("512 B");
        expect(formatSize(2048)).toBe("2.0 KB");
        expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
        expect(formatSize(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
        expect(formatSize(3 * 1024 * 1024 * 1024 * 1024)).toBe("3.0 TB");
        expect(formatSize(Number("NaN"))).toBe("Unknown");
        expect(formatSize(Infinity)).toBe("Unknown");
        expect(formatSize(-1)).toBe("Unknown");
        expect(formatLoad([0.123, 1.2, 9])).toBe("0.12, 1.20, 9.00");
    });

    it("formats token values", () => {
        expect(formatTokens(12_345, 128_000)).toBe("12.3k / 128k");
        expect(formatTokenCount(999)).toBe("999");
        expect(formatTokenCount(12_345)).toBe("12.3K");
        expect(formatTokenCount(1_234_567)).toBe("1.23M");
        expect(getTokenPercent(void 0, 100)).toBe(0);
        expect(getTokenPercent(undefined, 100)).toBe(0);
        expect(getTokenPercent(50, 100)).toBe(50);
        expect(getTokenPercent(150, 100)).toBe(100);
        expect(getTokenPercent(50, 0)).toBe(0);
    });
});
