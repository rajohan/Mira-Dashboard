import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Task } from "../../../types/task";
import { TaskOverlay } from "./TaskOverlay";

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        number: 7,
        title: "Review dashboard coverage gaps",
        state: "OPEN",
        labels: [{ name: "priority-medium" }],
        assignees: [],
        createdAt: "2026-05-10T08:00:00.000Z",
        updatedAt: "2026-05-10T09:00:00.000Z",
        url: "https://example.com/tasks/7",
        ...overrides,
    };
}

describe("TaskOverlay", () => {
    it("renders dragged task summary", () => {
        render(<TaskOverlay task={makeTask()} />);

        expect(screen.getByText("#7")).toBeInTheDocument();
        expect(screen.getByText("MEDIUM")).toBeInTheDocument();
        expect(screen.getByText("Review dashboard coverage gaps")).toBeInTheDocument();
    });

    it("shows recurring automation marker", () => {
        render(
            <TaskOverlay
                task={makeTask({
                    automation: {
                        type: "cron",
                        recurring: true,
                        cronJobId: "job-1",
                    },
                })}
            />
        );

        expect(screen.getByText("Recurring")).toBeInTheDocument();
    });
});
