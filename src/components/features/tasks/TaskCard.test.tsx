import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../../../types/task";
import { TaskCard } from "./TaskCard";

const sortable = vi.hoisted(() => ({
    transform: null as { x: number; y: number; scaleX: number; scaleY: number } | null,
}));

vi.mock("@dnd-kit/sortable", () => ({
    useSortable: () => ({
        attributes: { "aria-describedby": "sortable-task" },
        listeners: { onPointerDown: vi.fn() },
        setNodeRef: vi.fn(),
        transform: sortable.transform,
    }),
}));

/** Creates a task fixture for card rendering tests. */
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        number: 42,
        title: "Expand dashboard test coverage",
        body: "Cover the task board.",
        state: "OPEN",
        labels: [{ name: "in-progress" }, { name: "priority-high" }],
        assignees: [{ login: "mira-2026", avatar_url: "https://example.com/mira.png" }],
        createdAt: "2026-05-10T08:00:00.000Z",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        url: "https://example.com/tasks/42",
        ...overrides,
    };
}

describe("TaskCard", () => {
    beforeEach(() => {
        sortable.transform = null;
    });

    it("renders task metadata and calls onClick", async () => {
        const onClick = vi.fn();
        render(<TaskCard task={makeTask()} onClick={onClick} />);

        expect(screen.getByText("#42")).toBeInTheDocument();
        expect(screen.getByText("HIGH")).toBeInTheDocument();
        expect(screen.getByText("Expand dashboard test coverage")).toBeInTheDocument();
        expect(screen.getByAltText("mira-2026")).toHaveAttribute(
            "src",
            "https://example.com/mira.png"
        );

        await userEvent.click(screen.getByText("Expand dashboard test coverage"));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("stops card clicks from the drag handle", async () => {
        const onClick = vi.fn();
        render(<TaskCard task={makeTask()} onClick={onClick} />);

        await userEvent.click(screen.getByRole("button", { name: "Drag task #42" }));

        expect(onClick).not.toHaveBeenCalled();
    });

    it("shows recurring marker, fallback avatar, and dragging styling", () => {
        sortable.transform = { x: 8, y: 12, scaleX: 1, scaleY: 1 };

        render(
            <TaskCard
                isDragging
                onClick={vi.fn()}
                task={makeTask({
                    assignees: [{ name: "Raymond" }],
                    automation: {
                        type: "cron",
                        recurring: true,
                        cronJobId: "job-1",
                    },
                })}
            />
        );

        expect(screen.getByText("Recurring")).toBeInTheDocument();
        expect(screen.getByText("R")).toBeInTheDocument();
        expect(
            screen.getByText("Expand dashboard test coverage").closest("div")
                ?.parentElement
        ).toHaveClass("cursor-grabbing");
    });

    it("renders without an assignee and falls back to unknown avatar initials", () => {
        const { rerender } = render(
            <TaskCard task={makeTask({ assignees: [] })} onClick={vi.fn()} />
        );

        expect(screen.queryByText("Recurring")).not.toBeInTheDocument();
        expect(screen.queryByAltText("mira-2026")).not.toBeInTheDocument();

        rerender(
            <TaskCard
                task={makeTask({
                    assignees: [{}],
                })}
                onClick={vi.fn()}
            />
        );

        expect(screen.getByText("?")).toBeInTheDocument();
    });
});
