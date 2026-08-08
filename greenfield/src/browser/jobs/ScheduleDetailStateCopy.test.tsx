import { describe, expect, test } from "bun:test";

import { maxTime } from "date-fns/constants";

import { disabledSchedule, renderScheduleDetail } from "./testSupport/ScheduleDetail.tsx";

const { screen } = await import("@testing-library/react");

describe("schedule detail interaction state", () => {
    test("wraps contract-valid schedule copy without horizontal overflow", () => {
        const longToken = "x".repeat(1000);
        renderScheduleDetail({
            schedule: {
                ...disabledSchedule(maxTime),
                activeDisableIntent: {
                    ...disabledSchedule(maxTime).activeDisableIntent!,
                    reason: longToken,
                },
                description: longToken,
                name: longToken,
            },
        });

        expect(screen.getByRole("heading", { level: 2, name: longToken })).toHaveClass(
            "wrap-anywhere"
        );
        for (const copy of screen.getAllByText(longToken)) {
            expect(copy).toHaveClass("wrap-anywhere");
        }
    });
});
