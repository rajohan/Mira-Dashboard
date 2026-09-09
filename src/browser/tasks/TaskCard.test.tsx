import { describe, expect, jest, test } from "bun:test";

import { act } from "react";

import type { TaskSummary } from "../../contracts/taskModel.ts";
import { formatDashboardDateTimeToMinute } from "../lib/formatDateTime.ts";
import { TaskCardContent } from "./TaskCard.tsx";

const { render } = await import("@testing-library/react");

const mountTimeMs = 1_800_000_000_000;

function summaryTask(updatedAtMs: number): TaskSummary {
    return Object.freeze({
        assignee: "mira-2026",
        createdAtMs: mountTimeMs - 86_400_000,
        id: "019fd984-63e8-7404-a7da-80c6f243794f",
        labels: ["automation"],
        number: 232,
        priority: "high",
        status: "in-progress",
        title: "Keep relative task timestamps fresh",
        updatedAtMs,
        version: 1,
    });
}

describe("task card relative time", () => {
    test("refreshes the relative label as the presentation clock advances", async () => {
        jest.useFakeTimers();
        try {
            const nowSpy = jest.spyOn(Date, "now");
            let clock = mountTimeMs;
            nowSpy.mockImplementation(() => clock);

            const view = render(
                <TaskCardContent task={summaryTask(clock - 2 * 86_400_000)} />
            );
            expect(view.getByText("2 days ago")).toBeTruthy();
            expect(
                view.getByTitle(formatDashboardDateTimeToMinute(clock - 2 * 86_400_000))
            ).toBeTruthy();

            await act(async () => {
                clock += 3 * 86_400_000;
                jest.advanceTimersByTime(30_000);
                await Promise.resolve();
            });

            expect(view.getByText("5 days ago")).toBeTruthy();
            expect(view.queryByText("2 days ago")).toBeNull();

            view.unmount();
        } finally {
            jest.useRealTimers();
            jest.restoreAllMocks();
        }
    });
});
