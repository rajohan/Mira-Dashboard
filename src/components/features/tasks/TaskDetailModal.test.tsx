import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Task, TaskUpdate } from "../../../types/task";
import {
    formatTaskColumnBadge,
    normalizeTaskDetailColumn,
    TaskDetailModal,
} from "./TaskDetailModal";

function isoStringFromNowOffset(offsetMs: number): string {
    const date = new Date(Date.now() + offsetMs);
    return date.toISOString();
}

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        number: 88,
        title: "Review dashboard task coverage",
        body: "Keep work reviewable and **do not deploy** without approval.",
        state: "OPEN",
        labels: [{ name: "in-progress" }, { name: "priority-medium" }],
        assignees: [{ login: "mira-2026" }],
        createdAt: "2026-05-10T08:00:00.000Z",
        updatedAt: isoStringFromNowOffset(-120_000),
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
    it("normalizes missing task columns for badge and movement state", () => {
        expect(formatTaskColumnBadge(null)).toBe("UNASSIGNED");
        expect(formatTaskColumnBadge()).toBe("UNASSIGNED");
        expect(formatTaskColumnBadge("in-progress")).toBe("IN-PROGRESS");
        expect(normalizeTaskDetailColumn(null)).toBe("todo");
        expect(normalizeTaskDetailColumn()).toBe("todo");
        expect(normalizeTaskDetailColumn("done")).toBe("done");
    });

    it("renders nothing without a selected task", () => {
        renderModal({ task: null });

        expect(
            screen.queryByText(/Review dashboard task coverage/)
        ).not.toBeInTheDocument();
    });

    it("opens cleanly after rendering with no selected task", async () => {
        const props: React.ComponentProps<typeof TaskDetailModal> = {
            task: null,
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
        };

        const { rerender } = render(<TaskDetailModal {...props} />);

        expect(
            screen.queryByText(/Review dashboard task coverage/)
        ).not.toBeInTheDocument();

        rerender(
            <TaskDetailModal
                {...props}
                task={makeTask({ title: "Opened after idle state" })}
            />
        );

        expect(
            await screen.findByText("#88: Opened after idle state")
        ).toBeInTheDocument();
    });

    it("resets edit drafts when switching selected tasks", async () => {
        const user = userEvent.setup();
        const props: React.ComponentProps<typeof TaskDetailModal> = {
            task: makeTask({ number: 88, title: "First task" }),
            onClose: vi.fn(),
            onMove: vi.fn(async () => {}),
            onAssign: vi.fn(async () => {}),
            onDelete: vi.fn(async () => {}),
            onUpdate: vi.fn(async () => makeTask()),
            updates,
            onAddUpdate: vi.fn(async () => {}),
            onEditUpdate: vi.fn(async () => {}),
            onDeleteUpdate: vi.fn(async () => {}),
        };
        const { rerender } = render(<TaskDetailModal {...props} />);

        await user.click(screen.getAllByRole("button", { name: "Edit" }).at(-1)!);
        await user.clear(screen.getByLabelText("Title"));
        await user.type(screen.getByLabelText("Title"), "Unsaved draft");
        const updateCard = screen
            .getByText("Added component coverage.")
            .closest("div")!.parentElement!;
        await user.click(
            within(updateCard).getByRole("button", {
                name: "Edit progress update #31",
            })
        );

        rerender(
            <TaskDetailModal
                {...props}
                task={makeTask({ number: 89, title: "Second task" })}
            />
        );

        expect(await screen.findByText("#89: Second task")).toBeInTheDocument();
        expect(screen.queryByDisplayValue("Unsaved draft")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("textbox", {
                name: "Message for progress update #31",
            })
        ).not.toBeInTheDocument();
    });

    it("preserves edit drafts when the same task refreshes while editing", async () => {
        const user = userEvent.setup();
        const task = makeTask({
            number: 88,
            title: "First task",
            body: "Original body",
            labels: [{ name: "in-progress" }, { name: "priority-medium" }],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "job-original",
                scheduleSummary: "Original schedule",
                sessionTarget: "session:original",
            },
        });
        const props: React.ComponentProps<typeof TaskDetailModal> = {
            task,
            onClose: vi.fn(),
            onMove: vi.fn(async () => {}),
            onAssign: vi.fn(async () => {}),
            onDelete: vi.fn(async () => {}),
            onUpdate: vi.fn(async () => task),
            updates,
            onAddUpdate: vi.fn(async () => {}),
            onEditUpdate: vi.fn(async () => {}),
            onDeleteUpdate: vi.fn(async () => {}),
        };
        const { rerender } = render(<TaskDetailModal {...props} />);

        await user.click(screen.getAllByRole("button", { name: "Edit" }).at(-1)!);
        await user.clear(screen.getByLabelText("Title"));
        await user.type(screen.getByLabelText("Title"), "Unsaved title");
        fireEvent.change(screen.getByDisplayValue("Original body"), {
            target: { value: "Unsaved body" },
        });
        await user.click(screen.getByRole("button", { name: "high" }));
        fireEvent.change(screen.getByLabelText("Cron job ID"), {
            target: { value: "job-draft" },
        });
        fireEvent.change(screen.getByLabelText("Schedule summary"), {
            target: { value: "Draft schedule" },
        });
        fireEvent.change(screen.getByLabelText("Session target"), {
            target: { value: "session:draft" },
        });

        rerender(
            <TaskDetailModal
                {...props}
                task={makeTask({
                    ...task,
                    title: "Server refreshed title",
                    body: "Server refreshed body",
                    labels: [{ name: "in-progress" }, { name: "priority-low" }],
                    automation: {
                        type: "cron",
                        recurring: true,
                        cronJobId: "job-refreshed",
                        scheduleSummary: "Refreshed schedule",
                        sessionTarget: "session:refreshed",
                    },
                })}
            />
        );

        expect(screen.getByLabelText("Title")).toHaveValue("Unsaved title");
        expect(screen.getByDisplayValue("Unsaved body")).toBeInTheDocument();
        expect(screen.getByLabelText("Cron job ID")).toHaveValue("job-draft");
        expect(screen.getByLabelText("Schedule summary")).toHaveValue("Draft schedule");
        expect(screen.getByLabelText("Session target")).toHaveValue("session:draft");

        await user.click(screen.getByRole("button", { name: "Save Changes" }));

        expect(props.onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                labels: ["in-progress", "priority-high"],
            })
        );
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

    it("labels the icon-only close button", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose });

        await user.click(screen.getByRole("button", { name: "Close task details" }));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("moves, assigns, deletes, adds, edits, and deletes progress updates", async () => {
        const user = userEvent.setup();
        const props = renderModal({
            task: makeTask({ assignees: [{ login: "rajohan" }] }),
        });

        await user.click(screen.getByRole("button", { name: "Move to New" }));
        await user.click(screen.getByRole("button", { name: "Mark Done" }));
        await user.click(screen.getByRole("button", { name: "Assign to Mira" }));
        fireEvent.change(screen.getByPlaceholderText("Markdown supported"), {
            target: { value: "  New progress note  " },
        });
        await user.click(screen.getByRole("button", { name: "Add Update" }));

        const updateCard = screen
            .getByText("Added component coverage.")
            .closest("div")!.parentElement!;
        await user.click(
            within(updateCard).getByRole("button", {
                name: "Edit progress update #31",
            })
        );
        fireEvent.change(
            within(updateCard).getByRole("textbox", {
                name: "Message for progress update #31",
            }),
            {
                target: { value: "  Edited progress  " },
            }
        );
        await user.click(within(updateCard).getByRole("button", { name: "Save" }));
        await user.click(
            within(updateCard).getByRole("button", {
                name: "Delete progress update #31",
            })
        );

        await user.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

        expect(props.onMove).toHaveBeenNthCalledWith(1, "todo");
        expect(props.onMove).toHaveBeenNthCalledWith(2, "done");
        expect(props.onAssign).toHaveBeenCalledWith("mira-2026");
        expect(props.onAddUpdate).toHaveBeenCalledWith("New progress note");
        expect(props.onEditUpdate).toHaveBeenCalledWith(31, "Edited progress");
        expect(props.onDeleteUpdate).toHaveBeenCalledWith(31);
        expect(props.onDelete).toHaveBeenCalledTimes(1);
    });

    it("gives progress update edit controls distinct accessible names", async () => {
        const user = userEvent.setup();
        renderModal();

        const updateCard = screen
            .getByText("Added component coverage.")
            .closest("div")!.parentElement!;

        expect(
            within(updateCard).getByRole("button", {
                name: "Edit progress update #31",
            })
        ).toBeInTheDocument();
        expect(
            within(updateCard).getByRole("button", {
                name: "Delete progress update #31",
            })
        ).toBeInTheDocument();

        await user.click(
            within(updateCard).getByRole("button", {
                name: "Edit progress update #31",
            })
        );

        expect(
            within(updateCard).getByRole("textbox", {
                name: "Message for progress update #31",
            })
        ).toBeInTheDocument();
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
        expect(props.onUpdate).not.toHaveBeenCalled();
    });

    it("uses the new column for tasks without a column label", async () => {
        renderModal({ task: makeTask({ labels: [{ name: "priority-high" }] }) });

        expect(await screen.findByText("TODO")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Move to New" })
        ).not.toBeInTheDocument();
    });

    it("falls back to the first board column for invalid task columns", async () => {
        renderModal({
            task: makeTask({
                labels: [],
                state: undefined as unknown as Task["state"],
            }),
        });

        expect(await screen.findByText("TODO")).toBeInTheDocument();
        expect(screen.queryByText("UNDEFINED")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Move to New" })
        ).not.toBeInTheDocument();
    });

    it("renders closed tasks and scheduled/disabled automation fallbacks", async () => {
        renderModal({
            task: makeTask({
                assignees: [{ name: "external-user" }],
                body: "",
                labels: [{ name: "done" }, { name: "low" }],
                state: "CLOSED",
                automation: {
                    type: "cron",
                    recurring: true,
                    cronJobId: "job-disabled",
                    enabled: false,
                    lastDurationMs: -1,
                    source: "stored",
                },
            }),
            updates: [],
        });

        expect(await screen.findByText("DONE")).toBeInTheDocument();
        expect(screen.getByText("LOW")).toBeInTheDocument();
        expect(screen.getByText(/@external-user/)).toBeInTheDocument();
        expect(screen.getByText("DISABLED")).toBeInTheDocument();
        expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
        expect(screen.getByText("Stored metadata")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "job-disabled" })).toHaveAttribute(
            "href",
            "/jobs?view=openclaw&job=job-disabled"
        );
        expect(screen.getByText("No updates yet.")).toBeInTheDocument();
    });

    it("renders scheduled automation duration fallbacks", async () => {
        const baseProps: React.ComponentProps<typeof TaskDetailModal> = {
            task: makeTask({
                labels: [],
                automation: {
                    type: "cron",
                    recurring: true,
                    cronJobId: "job-scheduled",
                    enabled: true,
                    lastDurationMs: 60_000,
                },
            }),
            updates: [],
            onClose: vi.fn(),
            onMove: vi.fn(),
            onAssign: vi.fn(),
            onDelete: vi.fn(),
            onUpdate: vi.fn(),
            onAddUpdate: vi.fn(),
            onEditUpdate: vi.fn(),
            onDeleteUpdate: vi.fn(),
        };
        const { rerender } = render(<TaskDetailModal {...baseProps} />);

        expect(await screen.findByText("TODO")).toBeInTheDocument();
        expect(await screen.findByText("SCHEDULED")).toBeInTheDocument();
        expect(screen.getByText("1m")).toBeInTheDocument();

        rerender(
            <TaskDetailModal
                {...baseProps}
                task={makeTask({
                    automation: {
                        type: "cron",
                        recurring: true,
                        cronJobId: "job-hour",
                        enabled: true,
                        lastDurationMs: 3_600_000,
                    },
                })}
                updates={[]}
            />
        );
        expect(await screen.findByText("1h")).toBeInTheDocument();
    });

    it("renders whole-hour durations and Raymond-authored updates", async () => {
        render(
            <TaskDetailModal
                task={makeTask({
                    automation: {
                        type: "cron",
                        recurring: true,
                        cronJobId: "job-hour",
                        enabled: true,
                        lastDurationMs: 3_660_000,
                    },
                })}
                onClose={vi.fn()}
                onMove={vi.fn(async () => {})}
                onAssign={vi.fn(async () => {})}
                onDelete={vi.fn(async () => {})}
                onUpdate={vi.fn(async () => makeTask())}
                updates={[
                    {
                        id: 32,
                        taskId: 88,
                        author: "rajohan",
                        messageMd: "Reviewed by Raymond.",
                        createdAt: "2026-05-10T10:00:00.000Z",
                    },
                ]}
                onAddUpdate={vi.fn(async () => {})}
                onEditUpdate={vi.fn(async () => {})}
                onDeleteUpdate={vi.fn(async () => {})}
            />
        );

        expect(await screen.findByText("1h 1m")).toBeInTheDocument();
        expect(screen.getByText("Reviewed by Raymond.")).toBeInTheDocument();
    });

    it("renders completed automation fallbacks and cancels progress edit mode", async () => {
        const user = userEvent.setup();
        const onEditUpdate = vi.fn(async () => {});
        renderModal({
            onEditUpdate,
            task: makeTask({
                automation: {
                    type: "cron",
                    recurring: true,
                    cronJobId: "job-complete",
                    enabled: true,
                    lastDurationMs: 11_000,
                    lastRunStatus: "completed",
                },
            }),
        });

        expect(await screen.findByText("COMPLETED")).toBeInTheDocument();
        expect(screen.getByText("job-complete")).toBeInTheDocument();
        expect(screen.getByText("11s")).toBeInTheDocument();

        const updateCard = screen
            .getByText("Added component coverage.")
            .closest("div")!.parentElement!;
        await user.click(
            within(updateCard).getByRole("button", {
                name: "Edit progress update #31",
            })
        );
        fireEvent.change(
            within(updateCard).getByRole("textbox", {
                name: "Message for progress update #31",
            }),
            {
                target: { value: "Discard this edit" },
            }
        );
        await user.click(within(updateCard).getByRole("button", { name: "Cancel" }));

        expect(onEditUpdate).not.toHaveBeenCalled();
        expect(screen.getByText("Added component coverage.")).toBeInTheDocument();
    });

    it("ignores blank progress edits and saves automation metadata", async () => {
        const user = userEvent.setup();
        const onAddUpdate = vi.fn(async () => {});
        const onEditUpdate = vi.fn(async () => {});
        const onUpdate = vi.fn().mockResolvedValue(makeTask());
        renderModal({ onAddUpdate, onEditUpdate, onUpdate });

        await user.click(screen.getByRole("button", { name: "Add Update" }));
        expect(onAddUpdate).not.toHaveBeenCalled();

        const updateCard = screen
            .getByText("Added component coverage.")
            .closest("div")!.parentElement!;
        await user.click(
            within(updateCard).getByRole("button", {
                name: "Edit progress update #31",
            })
        );
        await user.clear(
            within(updateCard).getByRole("textbox", {
                name: "Message for progress update #31",
            })
        );
        await user.type(
            within(updateCard).getByRole("textbox", {
                name: "Message for progress update #31",
            }),
            " ".repeat(3)
        );
        await user.click(within(updateCard).getByRole("button", { name: "Save" }));
        expect(onEditUpdate).not.toHaveBeenCalled();

        await user.click(screen.getAllByRole("button", { name: "Edit" }).at(-1)!);
        fireEvent.change(screen.getByLabelText("Cron job ID"), {
            target: { value: " job-new " },
        });
        fireEvent.change(screen.getByLabelText("Schedule summary"), {
            target: { value: " Daily " },
        });
        fireEvent.change(screen.getByLabelText("Session target"), {
            target: { value: " session:new " },
        });
        await user.click(screen.getByRole("button", { name: "high" }));
        await user.click(screen.getByRole("button", { name: "Save Changes" }));

        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                automation: expect.objectContaining({
                    cronJobId: "job-new",
                    scheduleSummary: "Daily",
                    sessionTarget: "session:new",
                }),
                labels: ["in-progress", "priority-high"],
            })
        );
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
        fireEvent.change(screen.getByLabelText("Title"), {
            target: { value: "  Refined task title  " },
        });
        fireEvent.change(
            screen.getByDisplayValue(
                "Keep work reviewable and **do not deploy** without approval."
            ),
            { target: { value: "Updated body" } }
        );
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
