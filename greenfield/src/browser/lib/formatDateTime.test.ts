import { describe, expect, test } from "bun:test";

import {
    formatDashboardDateTime,
    formatDashboardDateTimeToMinute,
} from "./formatDateTime.ts";

describe("formatDashboardDateTime", () => {
    test("uses day-first dates and a 24-hour clock in local time", () => {
        const localTimestamp = new Date(2026, 7, 8, 21, 32, 45).getTime();

        expect(formatDashboardDateTime(localTimestamp)).toBe("08.08.2026 · 21:32:45");
        expect(formatDashboardDateTimeToMinute(localTimestamp)).toBe(
            "08.08.2026 · 21:32"
        );
    });
});
