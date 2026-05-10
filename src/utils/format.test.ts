import { describe, expect, it } from "vitest";

import {
    formatDate,
    formatDateStamp,
    formatDuration,
    formatLoad,
    formatOsloDate,
    formatOsloTime,
    formatSize,
    formatTokenCount,
    formatTokens,
    formatUptime,
    formatWeekdayShort,
    getTokenPercent,
} from "./format";

describe("format utils", () => {
    const date = new Date(2026, 4, 10, 6, 7, 8);

    it("formats dates and times", () => {
        expect(formatDate(date)).toBe("10.05.2026, 06:07");
        expect(formatDateStamp(date)).toBe("2026-05-10");
        expect(formatOsloTime(date)).toBe("06:07:08");
        expect(formatOsloDate(date)).toBe("Sunday 10. May 2026");
        expect(formatWeekdayShort(date)).toBe("Sun");
    });

    it("formats durations safely", () => {
        expect(formatDuration(null)).toBe("Unknown");
        const missingTimestamp: number | undefined = undefined;
        expect(formatDuration(missingTimestamp)).toBe("Unknown");
        expect(formatDuration(Date.now())).toMatch(/less than a minute|minute/u);
    });

    it("formats system values", () => {
        expect(formatUptime(59)).toBe("0m");
        expect(formatUptime(3_600 + 120)).toBe("1h 2m");
        expect(formatUptime(86_400 + 7_200)).toBe("1d 2h");
        expect(formatSize(512)).toBe("512 B");
        expect(formatSize(2_048)).toBe("2.0 KB");
        expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
        expect(formatLoad([0.123, 1.2, 9])).toBe("0.12, 1.20, 9.00");
    });

    it("formats token values", () => {
        expect(formatTokens(12_345, 128_000)).toBe("12.3k / 128k");
        expect(formatTokenCount(999)).toBe("999");
        expect(formatTokenCount(12_345)).toBe("12.3K");
        expect(formatTokenCount(1_234_567)).toBe("1.23M");
        expect(getTokenPercent(void 0, 100)).toBe(0);
        expect(getTokenPercent(null, 100)).toBe(0);
        expect(getTokenPercent(50, 100)).toBe(50);
        expect(getTokenPercent(150, 100)).toBe(100);
        expect(getTokenPercent(50, 0)).toBe(0);
    });
});
