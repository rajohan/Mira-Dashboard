import { describe, expect, test } from "bun:test";

import { nextScheduleOccurrence } from "./scheduleTime.ts";

describe("durable schedule occurrence calculation", () => {
    test("advances interval cadence from the original occurrence without drift", () => {
        expect(
            nextScheduleOccurrence(
                { intervalMs: 60_000, kind: "interval" },
                250_000,
                100_000
            )
        ).toBe(280_000);
    });

    test("keeps a retained interval occurrence that is already strictly future", () => {
        expect(
            nextScheduleOccurrence({ intervalMs: 60_000, kind: "interval" }, 1000, 60_000)
        ).toBe(60_000);
    });

    test("uses Effect Cron's deterministic spring-gap normalization", () => {
        const afterMs = Date.UTC(2026, 2, 29, 0, 0);
        expect(
            nextScheduleOccurrence(
                {
                    kind: "daily",
                    timeOfDay: "02:30",
                    timeZone: "Europe/Oslo",
                },
                afterMs
            )
        ).toBe(Date.UTC(2026, 2, 29, 1, 30));
    });

    test("chooses one fall-overlap occurrence and never duplicates cadence", () => {
        const schedule = {
            kind: "daily" as const,
            timeOfDay: "02:30",
            timeZone: "Europe/Oslo",
        };
        const first = nextScheduleOccurrence(schedule, Date.UTC(2026, 9, 25, 0, 0));
        expect(first).toBe(Date.UTC(2026, 9, 25, 0, 30));
        expect(nextScheduleOccurrence(schedule, first ?? 0)).toBe(
            Date.UTC(2026, 9, 26, 1, 30)
        );
    });

    test("returns no occurrence when the next timestamp overflows its contract", () => {
        expect(
            nextScheduleOccurrence(
                { intervalMs: 60_000, kind: "interval" },
                8_640_000_000_000_000,
                8_640_000_000_000_000
            )
        ).toBeUndefined();
    });
});
