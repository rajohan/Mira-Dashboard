import { describe, expect, test } from "bun:test";

import {
    formatDashboardDateTime,
    formatDashboardDateTimeParts,
    formatDashboardDateTimeToMinute,
    formatDashboardRelativeTime,
    formatDashboardWeekdayDate,
} from "./formatDateTime.ts";

describe("formatDashboardDateTime", () => {
    test("uses day-first dates and a 24-hour clock in local time", () => {
        const localTimestamp = new Date(2026, 7, 8, 21, 32, 45).getTime();

        expect(formatDashboardDateTime(localTimestamp)).toBe("08.08.2026 · 21:32:45");
        expect(formatDashboardDateTimeToMinute(localTimestamp)).toBe(
            "08.08.2026 · 21:32"
        );
        expect(formatDashboardDateTimeParts(localTimestamp)).toEqual([
            "08.08.2026",
            "21:32:45",
        ]);
        expect(formatDashboardWeekdayDate(localTimestamp)).toBe("Saturday, 08.08.2026");
    });

    test("formats activity relative to an explicit reference clock", () => {
        const referenceTimestamp = new Date(2026, 7, 14, 15, 22).getTime();

        expect(
            formatDashboardRelativeTime(
                referenceTimestamp - 13 * 60_000,
                referenceTimestamp
            )
        ).toBe("13 minutes ago");
    });
});
