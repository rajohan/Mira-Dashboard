import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../../types/task";
import { TaskColumn } from "./TaskColumn";

vi.mock("@dnd-kit/core", () => ({
    useDroppable: () => ({ setNodeRef: vi.fn() }),
}));

vi.mock("@dnd-kit/sortable", () => ({
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
        attributes: {},
        listeners: {},
        setNodeRef: vi.fn(),
        transform: null,
    }),
    verticalListSortingStrategy: vi.fn(),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        number: 3,
        title: "Cover task columns",
        state: "OPEN",
        labels: [{ name: "todo" }, { name: "priority-low" }],
        assignees: [{ login: "mira-2026" }],
        createdAt: "2026-05-10T08:00:00.000Z",
        updatedAt: new Date(Date.now() - 5_000).toISOString(),
        url: "https://example.com/tasks/3",
        ...overrides,
    };
}

describe("TaskColumn", () => {
    it("renders configured column title, count, and tasks", async () => {
        const onTaskClick = vi.fn();
        const task = makeTask();
        render(
            <TaskColumn
                id="todo"
                tasks={[task]}
                isOver={false}
                onTaskClick={onTaskClick}
            />
        );

        expect(screen.getByText("New")).toBeInTheDocument();
        expect(screen.getByText("1")).toBeInTheDocument();
        expect(screen.getByText("Cover task columns")).toBeInTheDocument();

        await userEvent.click(screen.getByText("Cover task columns"));

        expect(onTaskClick).toHaveBeenCalledWith(task);
    });

    it("renders empty state and drop highlight", () => {
        render(<TaskColumn id="blocked" tasks={[]} isOver onTaskClick={vi.fn()} />);

        expect(screen.getByText("Blocked")).toBeInTheDocument();
        expect(screen.getByText("No tasks")).toBeInTheDocument();
        expect(screen.getByText("No tasks").parentElement).toHaveClass(
            "border-accent-500/50"
        );
    });
});
