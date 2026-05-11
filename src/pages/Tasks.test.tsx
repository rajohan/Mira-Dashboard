import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Tasks } from "./Tasks";

type MockTask = {
    assignees: Array<{ login?: string; name?: string }>;
    automation?: { cronJobId?: string; jobName?: string };
    body?: string;
    labels: Array<{ name: string }>;
    number: number;
    title: string;
    updatedAt: string;
};

const hooks = vi.hoisted(() => ({
    assignTask: vi.fn(),
    createTask: vi.fn(),
    createTaskUpdate: vi.fn(),
    deleteTask: vi.fn(),
    deleteTaskUpdate: vi.fn(),
    moveTask: vi.fn(),
    refetch: vi.fn(),
    updateTask: vi.fn(),
    updateTaskUpdate: vi.fn(),
    useAssignTask: vi.fn(),
    useCreateTask: vi.fn(),
    useCreateTaskUpdate: vi.fn(),
    useDeleteTask: vi.fn(),
    useDeleteTaskUpdate: vi.fn(),
    useMoveTask: vi.fn(),
    useTaskUpdates: vi.fn(),
    useTasks: vi.fn(),
    useUpdateTask: vi.fn(),
    useUpdateTaskUpdate: vi.fn(),
}));

const taskModule = vi.hoisted(() => {
    const hasLabel = (task: { labels: Array<{ name: string }> }, label: string) =>
        task.labels.some((taskLabel) => taskLabel.name === label);

    return {
        columnConfig: [
            {
                id: "todo",
                label: "todo",
                filter: (task: { labels: Array<{ name: string }> }) =>
                    hasLabel(task, "todo"),
            },
            {
                id: "in-progress",
                label: "in-progress",
                filter: (task: { labels: Array<{ name: string }> }) =>
                    hasLabel(task, "in-progress"),
            },
            {
                id: "blocked",
                label: "blocked",
                filter: (task: { labels: Array<{ name: string }> }) =>
                    hasLabel(task, "blocked"),
            },
            {
                id: "done",
                label: "done",
                filter: (task: { labels: Array<{ name: string }> }) =>
                    hasLabel(task, "done"),
            },
        ],
    };
});

const dndMocks = vi.hoisted(() => ({
    handlers: null as null | {
        onDragEnd: (event: {
            active: { id: string };
            over: { id: string } | null;
        }) => Promise<void> | void;
        onDragOver: (event: { over: { id: string } | null }) => void;
        onDragStart: (event: { active: { id: string } }) => void;
    },
}));

vi.mock("@dnd-kit/core", () => ({
    DndContext: ({
        children,
        onDragEnd,
        onDragOver,
        onDragStart,
    }: {
        children: React.ReactNode;
        onDragEnd: (event: {
            active: { id: string };
            over: { id: string } | null;
        }) => Promise<void> | void;
        onDragOver: (event: { over: { id: string } | null }) => void;
        onDragStart: (event: { active: { id: string } }) => void;
    }) => {
        dndMocks.handlers = { onDragEnd, onDragOver, onDragStart };
        return <div data-testid="dnd-context">{children}</div>;
    },
    DragOverlay: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="drag-overlay">{children}</div>
    ),
}));

vi.mock("../hooks", () => ({
    useAssignTask: hooks.useAssignTask,
    useCreateTask: hooks.useCreateTask,
    useCreateTaskUpdate: hooks.useCreateTaskUpdate,
    useDeleteTask: hooks.useDeleteTask,
    useDeleteTaskUpdate: hooks.useDeleteTaskUpdate,
    useMoveTask: hooks.useMoveTask,
    useTaskUpdates: hooks.useTaskUpdates,
    useTasks: hooks.useTasks,
    useUpdateTask: hooks.useUpdateTask,
    useUpdateTaskUpdate: hooks.useUpdateTaskUpdate,
}));

vi.mock("../components/features/tasks", () => ({
    COLUMN_CONFIG: taskModule.columnConfig,
    getColumnId: (value: string | MockTask) => {
        if (typeof value === "string") {
            return taskModule.columnConfig.some((column) => column.id === value)
                ? value
                : null;
        }
        return taskModule.columnConfig.find((column) => column.filter(value))?.id || null;
    },
    NewTaskModal: ({
        onClose,
        onSubmit,
    }: {
        onClose: () => void;
        onSubmit: (
            title: string,
            body: string,
            priority: string,
            assignee: string,
            automation: { cronJobId: string } | null
        ) => Promise<void>;
    }) => (
        <section data-testid="new-task-modal">
            <button type="button" onClick={() => onClose()}>
                Close new task
            </button>
            <button
                type="button"
                onClick={() =>
                    void onSubmit("New task", "Body", "high", "rajohan", {
                        cronJobId: "cron-1",
                    })
                }
            >
                Submit new task
            </button>
            <button
                type="button"
                onClick={() => void onSubmit("Default task", "", "", "", null)}
            >
                Submit default task
            </button>
        </section>
    ),
    TaskColumn: ({
        id,
        isOver,
        onTaskClick,
        tasks,
    }: {
        id: string;
        isOver: boolean;
        onTaskClick: (task: MockTask) => void;
        tasks: MockTask[];
    }) => (
        <section data-testid={`column-${id}`}>
            <h2>
                {id} ({tasks.length}) {isOver ? "over" : ""}
            </h2>
            {tasks.map((task) => (
                <button key={task.number} type="button" onClick={() => onTaskClick(task)}>
                    {task.title}
                </button>
            ))}
        </section>
    ),
    TaskDetailModal: ({
        onAddUpdate,
        onAssign,
        onClose,
        onDelete,
        onDeleteUpdate,
        onEditUpdate,
        onMove,
        onUpdate,
        task,
        updates,
    }: {
        onAddUpdate: (message: string) => Promise<void>;
        onAssign: (assignee: string) => Promise<void>;
        onClose: () => void;
        onDelete: () => Promise<void>;
        onDeleteUpdate: (updateId: number) => Promise<void>;
        onEditUpdate: (updateId: number, message: string) => Promise<void>;
        onMove: (column: string) => Promise<void>;
        onUpdate: (updates: { title: string }) => Promise<MockTask>;
        task: MockTask;
        updates: unknown[];
    }) => (
        <section data-testid="task-detail">
            Detail #{task.number}; updates: {updates.length}
            <button type="button" onClick={() => onClose()}>
                Close detail
            </button>
            <button type="button" onClick={() => void onMove("done")}>
                Move done
            </button>
            <button type="button" onClick={() => void onAssign("mira-2026")}>
                Assign Mira
            </button>
            <button type="button" onClick={() => void onUpdate({ title: "Updated" })}>
                Update task
            </button>
            <button type="button" onClick={() => void onAddUpdate("Progress")}>
                Add progress
            </button>
            <button type="button" onClick={() => void onEditUpdate(10, "Edited")}>
                Edit progress
            </button>
            <button type="button" onClick={() => void onDeleteUpdate(10)}>
                Delete progress
            </button>
            <button type="button" onClick={() => void onDelete()}>
                Delete task
            </button>
        </section>
    ),
    TaskOverlay: ({ task }: { task: MockTask }) => (
        <div data-testid="task-overlay">{task.title}</div>
    ),
}));

vi.mock("../components/ui/ConfirmModal", () => ({
    ConfirmModal: ({
        isOpen,
        message,
        onCancel,
        onConfirm,
        title,
    }: {
        isOpen: boolean;
        message: string;
        onCancel: () => void;
        onConfirm: () => void;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid={`confirm-${title}`}>
                <p>{message}</p>
                <button type="button" onClick={onCancel}>
                    Cancel {title}
                </button>
                <button type="button" onClick={onConfirm}>
                    Confirm {title}
                </button>
            </section>
        ) : null,
}));

function task(overrides: Partial<MockTask>): MockTask {
    return {
        assignees: [{ login: "mira-2026" }],
        body: "Body",
        labels: [{ name: "todo" }, { name: "priority-medium" }],
        number: 1,
        title: "Task one",
        updatedAt: "2026-05-11T00:00:00.000Z",
        ...overrides,
    };
}

function mockTaskHooks(overrides = {}) {
    hooks.useTasks.mockReturnValue({
        data: [
            task({
                labels: [{ name: "todo" }, { name: "priority-high" }],
                number: 1,
                title: "Build tests",
            }),
            task({
                assignees: [{ login: "rajohan" }],
                labels: [{ name: "done" }, { name: "priority-low" }],
                number: 2,
                title: "Ship dashboard",
            }),
        ],
        error: null,
        isLoading: false,
        refetch: hooks.refetch,
        ...overrides,
    });
}

describe("Tasks page", () => {
    beforeEach(() => {
        dndMocks.handlers = null;
        hooks.assignTask.mockResolvedValue(task({ number: 1, title: "Assigned" }));
        hooks.createTask.mockResolvedValue(task({ number: 3, title: "New task" }));
        hooks.createTaskUpdate.mockResolvedValue(Promise.resolve());
        hooks.deleteTask.mockResolvedValue(Promise.resolve());
        hooks.deleteTaskUpdate.mockResolvedValue(Promise.resolve());
        hooks.moveTask.mockResolvedValue(task({ labels: [{ name: "done" }] }));
        hooks.refetch.mockResolvedValue(Promise.resolve());
        hooks.updateTask.mockResolvedValue(task({ number: 1, title: "Updated" }));
        hooks.updateTaskUpdate.mockResolvedValue(Promise.resolve());
        hooks.useAssignTask.mockReturnValue({ mutateAsync: hooks.assignTask });
        hooks.useCreateTask.mockReturnValue({ mutateAsync: hooks.createTask });
        hooks.useCreateTaskUpdate.mockReturnValue({
            mutateAsync: hooks.createTaskUpdate,
        });
        hooks.useDeleteTask.mockReturnValue({ mutateAsync: hooks.deleteTask });
        hooks.useDeleteTaskUpdate.mockReturnValue({
            mutateAsync: hooks.deleteTaskUpdate,
        });
        hooks.useMoveTask.mockReturnValue({ mutateAsync: hooks.moveTask });
        hooks.useTaskUpdates.mockReturnValue({ data: [{ id: 10 }] });
        hooks.useTasks.mockReset();
        hooks.useUpdateTask.mockReturnValue({ mutateAsync: hooks.updateTask });
        hooks.useUpdateTaskUpdate.mockReturnValue({
            mutateAsync: hooks.updateTaskUpdate,
        });
        mockTaskHooks();
    });

    it("renders loading, error retry, and task columns", async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(<Tasks />);

        expect(screen.getByTestId("column-todo")).toHaveTextContent("todo (1)");
        expect(screen.getByTestId("column-done")).toHaveTextContent("done (1)");

        hooks.useTasks.mockReturnValue({
            data: [],
            error: null,
            isLoading: true,
            refetch: hooks.refetch,
        });
        rerender(<Tasks />);
        expect(container.querySelector(".animate-spin")).toBeInTheDocument();

        hooks.useTasks.mockReturnValue({
            data: [],
            error: new Error("Tasks unavailable"),
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(<Tasks />);
        expect(screen.getByText("Tasks unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(hooks.refetch).toHaveBeenCalledTimes(1);
    });

    it("filters tasks by search and assignee", async () => {
        const user = userEvent.setup();

        render(<Tasks />);

        await user.type(screen.getByPlaceholderText("Search tasks..."), "ship");
        expect(screen.getByTestId("column-todo")).toHaveTextContent("todo (0)");
        expect(screen.getByTestId("column-done")).toHaveTextContent("done (1)");

        await user.click(screen.getByRole("button", { name: "Mira" }));
        expect(screen.getByTestId("column-done")).toHaveTextContent("done (0)");
    });

    it("creates a new task", async () => {
        const user = userEvent.setup();

        render(<Tasks />);

        await user.click(screen.getByRole("button", { name: "New Task" }));
        expect(screen.getByTestId("new-task-modal")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Submit new task" }));

        expect(hooks.createTask).toHaveBeenCalledWith({
            assignee: "rajohan",
            automation: { cronJobId: "cron-1" },
            body: "Body",
            labels: ["priority-high"],
            title: "New task",
        });

        await user.click(screen.getByRole("button", { name: "New Task" }));
        await user.click(screen.getByRole("button", { name: "Submit default task" }));

        expect(hooks.createTask).toHaveBeenLastCalledWith({
            assignee: "mira-2026",
            automation: null,
            body: "",
            labels: [],
            title: "Default task",
        });
    });

    it("moves tasks through drag and drop events", async () => {
        render(<Tasks />);

        expect(dndMocks.handlers).not.toBeNull();
        const handlers = dndMocks.handlers!;

        act(() => {
            handlers.onDragStart({ active: { id: "1" } });
        });
        expect(screen.getByTestId("task-overlay")).toHaveTextContent("Build tests");

        act(() => {
            handlers.onDragOver({ over: { id: "done" } });
        });
        expect(screen.getByTestId("column-done")).toHaveTextContent("over");

        await act(async () => {
            await handlers.onDragEnd({ active: { id: "1" }, over: { id: "done" } });
        });

        expect(hooks.moveTask).toHaveBeenCalledWith({
            number: 1,
            columnLabel: "done",
        });
        expect(screen.queryByTestId("task-overlay")).not.toBeInTheDocument();
    });

    it("opens task details and performs task/update actions", async () => {
        const user = userEvent.setup();

        render(<Tasks />);

        await user.click(screen.getByRole("button", { name: "Build tests" }));
        expect(screen.getByTestId("task-detail")).toHaveTextContent(
            "Detail #1; updates: 1"
        );

        await user.click(screen.getByRole("button", { name: "Move done" }));
        await user.click(screen.getByRole("button", { name: "Assign Mira" }));
        await user.click(screen.getByRole("button", { name: "Update task" }));
        await user.click(screen.getByRole("button", { name: "Add progress" }));
        await user.click(screen.getByRole("button", { name: "Edit progress" }));
        await user.click(screen.getByRole("button", { name: "Delete progress" }));
        await user.click(
            screen.getByRole("button", { name: "Confirm Delete progress update" })
        );
        await user.click(screen.getByRole("button", { name: "Delete task" }));
        await user.click(screen.getByRole("button", { name: "Confirm Delete task" }));

        expect(hooks.moveTask).toHaveBeenCalledWith({ number: 1, columnLabel: "done" });
        expect(hooks.assignTask).toHaveBeenCalledWith({
            number: 1,
            assignee: "mira-2026",
        });
        expect(hooks.updateTask).toHaveBeenCalledWith({
            number: 1,
            updates: { title: "Updated" },
        });
        expect(hooks.createTaskUpdate).toHaveBeenCalledWith({
            taskId: 1,
            author: "rajohan",
            messageMd: "Progress",
        });
        expect(hooks.updateTaskUpdate).toHaveBeenCalledWith({
            taskId: 1,
            updateId: 10,
            author: "rajohan",
            messageMd: "Edited",
        });
        expect(hooks.deleteTaskUpdate).toHaveBeenCalledWith({
            taskId: 1,
            updateId: 10,
        });
        expect(hooks.deleteTask).toHaveBeenCalledWith({ number: 1 });
    });
});
