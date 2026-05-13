import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Task, TaskUpdate } from "../../../types/task";
import { TaskDetailModal } from "./TaskDetailModal";

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        number: 88,
        title: "Review dashboard task coverage",
        body: "Keep work reviewable and **do not deploy** without approval.",
        state: "OPEN",
        labels: [{ name: "in-progress" }, { name: "priority-medium" }],
        assignees: [{ login: "mira-2026" }],
        createdAt: "2026-05-10T08:00:00.000Z",
        updatedAt: new Date(Date.now() - 120_000).toISOString(),
        url: "https://example.com/tasks/8",
        ...overrides,
    };
}

const updates: TaskUpdate[] = [
    {
        id: 31,
        taskId: 88,
        author: "mira-2026",
        messageMd: "Added component coverage.",
        createdAt: "2026-05-10T09:00:00.000Z",
    },
];

function renderModal(
    overrides: Partial<React.ComponentProps<typeof TaskDetailModal>> = {}
) {
    const props: React.ComponentProps<typeof TaskDetailModal> = {
        task: makeTask(),
        onClose: vi.fn(),
        onMove: vi.fn(async () => {}),
        onAssign: vi.fn(async () => {}),
        onDelete: vi.fn(async () => {}),
        onUpdate: vi
            .fn()
            .mockImplementation(async (next) => ({ ...makeTask(), ...next })),
        updates,
        onAddUpdate: vi.fn(async () => {}),
        onEditUpdate: vi.fn(async () => {}),
        onDeleteUpdate: vi.fn(async () => {}),
        ...overrides,
    };

    render(<TaskDetailModal {...props} />);
    return props;
}

describe("TaskDetailModal", () => {
    it("renders nothing without a selected task", () => {
        renderModal({ task: null });

        expect(
            screen.queryByText(/Review dashboard task coverage/)
        ).not.toBeInTheDocument();
    });

    it("renders task details, markdown body, updates, and automation state", async () => {
        renderModal({
            task: makeTask({
                automation: {
                    type: "cron",
                    recurring: true,
                    cronJobId: "job-88",
                    jobName: "Dashboard autopilot",
                    enabled: true,
                    scheduleSummary: "Twice daily",
                    sessionTarget: "session:dashboard-autopilot",
                    model: "codex",
                    thinking: "high",
                    runningAtMs: Date.now() - 65_000,
                    lastDurationMs: 65_000,
                    source: "cron",
                },
            }),
        });

        expect(
            await screen.findByText("#88: Review dashboard task coverage")
        ).toBeInTheDocument();
        expect(screen.getByText("IN-PROGRESS")).toBeInTheDocument();
        expect(screen.getByText("MEDIUM")).toBeInTheDocument();
        expect(screen.getAllByRole("link", { name: "@mira-2026" })[0]).toHaveAttribute(
            "href",
            "https://github.com/mira-2026"
        );
        expect(screen.getByText("Backed by OpenClaw cron")).toBeInTheDocument();
        expect(screen.getByText("RUNNING")).toBeInTheDocument();
        expect(screen.getByText("Dashboard autopilot")).toBeInTheDocument();
        expect(screen.getByText("Twice daily")).toBeInTheDocument();
        expect(screen.getByText("session:dashboard-autopilot")).toBeInTheDocument();
        expect(screen.getByText("codex · high")).toBeInTheDocument();
        expect(screen.getByText("1m 5s")).toBeInTheDocument();
        expect(screen.getByText("Live cron state")).toBeInTheDocument();
        expect(screen.getByText("do not deploy")).toBeInTheDocument();
        expect(screen.getByText("Added component coverage.")).toBeInTheDocument();
    });

    it("moves, assigns, deletes, adds, edits, and deletes progress updates", async () => {
        const user = userEvent.setup();
        const props = renderModal({
            task: makeTask({ assignees: [{ login: "rajohan" }] }),
        });

        await user.click(screen.getByRole("button", { name: "Move to New" }));
        await user.click(screen.getByRole("button", { name: "Mark Done" }));
        await user.click(screen.getByRole("button", { name: "Assign to Mira" }));
        await user.type(
            screen.getByPlaceholderText("Markdown supported"),
            "  New progress note  "
        );
        await user.click(screen.getByRole("button", { name: "Add Update" }));

        const updateCard = screen
            .getByText("Added component coverage.")
            .closest("div")!.parentElement!;
        await user.click(within(updateCard).getByRole("button", { name: "Edit" }));
        await user.clear(within(updateCard).getByRole("textbox"));
        await user.type(within(updateCard).getByRole("textbox"), "  Edited progress  ");
        await user.click(within(updateCard).getByRole("button", { name: "Save" }));
        await user.click(within(updateCard).getByRole("button", { name: "Delete" }));

        await user.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

        expect(props.onMove).toHaveBeenNthCalledWith(1, "todo");
        expect(props.onMove).toHaveBeenNthCalledWith(2, "done");
        expect(props.onAssign).toHaveBeenCalledWith("mira-2026");
        expect(props.onAddUpdate).toHaveBeenCalledWith("New progress note");
        expect(props.onEditUpdate).toHaveBeenCalledWith(31, "Edited progress");
        expect(props.onDeleteUpdate).toHaveBeenCalledWith(31);
        expect(props.onDelete).toHaveBeenCalledTimes(1);
    });

    it("handles remaining move, assign, and edit cancel controls", async () => {
        const user = userEvent.setup();
        const props = renderModal({
            task: makeTask({ assignees: [], labels: [{ name: "todo" }] }),
        });

        await user.click(screen.getByRole("button", { name: "Move to In Progress" }));
        await user.click(screen.getByRole("button", { name: "Move to Blocked" }));
        await user.click(screen.getByRole("button", { name: "Assign to Raymond" }));
        await user.click(screen.getAllByRole("button", { name: "Edit" }).at(-1)!);
        await user.click(screen.getByRole("button", { name: "Cancel Edit" }));

        expect(props.onMove).toHaveBeenNthCalledWith(1, "in-progress");
        expect(props.onMove).toHaveBeenNthCalledWith(2, "blocked");
        expect(props.onAssign).toHaveBeenCalledWith("rajohan");
    });

    it("saves task edits and clears automation when cron id is blank", async () => {
        const user = userEvent.setup();
        const onUpdate = vi.fn().mockResolvedValue(makeTask());
        renderModal({
            onUpdate,
            task: makeTask({
                labels: [
                    { name: "todo" },
                    { name: "priority-high" },
                    { name: "custom-label" },
                ],
                automation: {
                    type: "cron",
                    recurring: true,
                    cronJobId: "job-88",
                    scheduleSummary: "Daily",
                    sessionTarget: "session:old",
                },
            }),
        });

        await user.click(screen.getAllByRole("button", { name: "Edit" }).at(-1)!);
        await user.clear(screen.getByLabelText("Title"));
        await user.type(screen.getByLabelText("Title"), "  Refined task title  ");
        const description = screen.getByDisplayValue(
            "Keep work reviewable and **do not deploy** without approval."
        );
        await user.clear(description);
        await user.type(description, "Updated body");
        await user.click(screen.getByRole("button", { name: "low" }));
        await user.clear(screen.getByLabelText("Cron job ID"));
        await user.click(screen.getByRole("button", { name: "Save Changes" }));

        expect(onUpdate).toHaveBeenCalledWith({
            title: "Refined task title",
            body: "Updated body",
            labels: ["todo", "custom-label", "priority-low"],
            automation: null,
        });
    });
});
