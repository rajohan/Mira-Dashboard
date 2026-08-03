import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import type { TaskUpdate } from "../../../../contracts/tasks";
import { requestUrl } from "../../../../test/support/fetch";
import { TaskDetailModal } from "../../components/features/tasks/TaskDetailModal";
import { Badge } from "../../components/ui/Badge";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { Dropdown } from "../../components/ui/Dropdown";
import { SearchInput } from "../../components/ui/SearchInput";
import { uninstallAuthSessionRotationSync } from "../../lib/authBoundary";
import { resetUserActivityForTests } from "../../lib/userActivity";
import { Tasks } from "../../pages/Tasks";
import { authActions } from "../../stores/authStore";
import { getSessionTypeVariant } from "../../utils/sessionUtilities";
import { getColumnId, getPriority, isTaskMatchSearch } from "../../utils/taskUtilities";
import { createFrontendBehaviorHarness } from "../support/frontendBehaviorHarness";
describe("Dashboard task UI", () => {
    const { createApi, renderWithQueryClient, task } = createFrontendBehaviorHarness();
    beforeEach(() => {
        authActions.clearSession();
        resetUserActivityForTests();
    });
    afterEach(() => {
        uninstallAuthSessionRotationSync();
        authActions.clearSession();
        resetUserActivityForTests();
    });
    it("drives task detail modal editing, assignment, movement, and progress updates", async () => {
        const user = userEvent.setup();
        const onClose = jest.fn();
        const onMove = jest.fn(async () => {});
        const onAssign = jest.fn(async () => {});
        const onDelete = jest.fn();
        const onUpdate = jest.fn(() =>
            Promise.try(() =>
                task({
                    number: 7,
                    title: "Edited detail task",
                })
            )
        );
        const onAddUpdate = jest.fn(async () => {});
        const onEditUpdate = jest.fn(async () => {});
        const onDeleteUpdate = jest.fn();
        const detailTask = task({
            number: 7,
            title: "Detail task",
            body: "**Investigate** behavior",
            labels: [
                {
                    name: "priority-high",
                },
                {
                    name: "in-progress",
                },
            ],
            assignees: [
                {
                    login: "mira-2026",
                    name: "Mira",
                },
            ],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "cron-7",
                scheduleSummary: "Every hour",
                sessionTarget: "agent:main:main",
                enabled: false,
                lastRunStatus: "success",
                lastRunAtMs: Date.UTC(2026, 5, 23, 8),
                nextRunAtMs: Date.UTC(2026, 5, 23, 9),
                lastDurationMs: 125_000,
                model: "codex",
                thinking: "high",
                source: "cron",
            },
        });
        render(
            createElement(TaskDetailModal, {
                task: detailTask,
                onClose,
                onMove,
                onAssign,
                onDelete,
                onUpdate,
                updates: [
                    {
                        id: 11,
                        taskId: 7,
                        author: "mira-2026",
                        messageMd: "First **progress** update",
                        createdAt: "2026-06-23T08:00:00.000Z",
                    },
                ],
                onAddUpdate,
                onEditUpdate,
                onDeleteUpdate,
            })
        );
        expect(screen.getByText("#7: Detail task")).toBeInTheDocument();
        expect(screen.getByText("Backed by OpenClaw cron")).toBeInTheDocument();
        expect(screen.getByText("2m 5s")).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "Add Update",
            })
        ).toBeDisabled();
        await user.click(
            screen.getByRole("button", {
                name: "Mark Done",
            })
        );
        expect(onMove).toHaveBeenCalledWith("done");
        await user.click(
            screen.getByRole("button", {
                name: "Assign to Raymond",
            })
        );
        expect(onAssign).toHaveBeenCalledWith("rajohan");
        await user.click(
            screen.getByRole("button", {
                name: "Edit",
            })
        );
        await user.clear(screen.getByLabelText("Title"));
        await user.type(screen.getByLabelText("Title"), "Edited detail task");
        await user.clear(screen.getByLabelText("Cron job ID"));
        await user.type(screen.getByLabelText("Cron job ID"), "cron-edited");
        await user.click(
            screen.getByRole("button", {
                name: "Save Changes",
            })
        );
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Edited detail task",
                automation: expect.objectContaining({
                    cronJobId: "cron-edited",
                }),
            })
        );
        await user.type(screen.getByLabelText("Add progress update"), "More progress");
        const addUpdateButton = screen.getByRole("button", {
            name: "Add Update",
        });
        expect(addUpdateButton).toBeEnabled();
        await user.click(addUpdateButton);
        expect(onAddUpdate).toHaveBeenCalledWith("More progress");
        await user.click(
            screen.getByRole("button", {
                name: "Edit progress update #11",
            })
        );
        await user.clear(screen.getByLabelText("Message for progress update #11"));
        const saveUpdateButton = screen.getByRole("button", {
            name: "Save",
        });
        expect(saveUpdateButton).toBeDisabled();
        await user.type(
            screen.getByLabelText("Message for progress update #11"),
            "Edited progress"
        );
        expect(saveUpdateButton).toBeEnabled();
        await user.click(saveUpdateButton);
        expect(onEditUpdate).toHaveBeenCalledWith(11, "Edited progress");
        await user.click(
            screen.getByRole("button", {
                name: "Delete progress update #11",
            })
        );
        expect(onDeleteUpdate).toHaveBeenCalledWith(11);
        await user.click(
            screen.getByRole("button", {
                name: "Delete",
            })
        );
        expect(onDelete).toHaveBeenCalled();
        await user.click(
            screen.getByRole("button", {
                name: "Close task details",
            })
        );
        expect(onClose).toHaveBeenCalled();
    }, 10_000);
    it("restores the task assignment button when its callback fails", async () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
        const assignError = new Error("assign failed");
        const assignDeferred = Promise.withResolvers<void>();
        const onAssign = jest.fn(() => assignDeferred.promise);
        try {
            render(
                createElement(TaskDetailModal, {
                    task: task({
                        number: 8,
                        title: "Action failure task",
                        labels: [
                            {
                                name: "priority-medium",
                            },
                            {
                                name: "todo",
                            },
                        ],
                        assignees: [
                            {
                                login: "mira-2026",
                                name: "Mira",
                            },
                        ],
                    }),
                    onClose: jest.fn(),
                    onMove: jest.fn(async () => {}),
                    onAssign,
                    onDelete: jest.fn(),
                    onUpdate: jest.fn(() =>
                        Promise.try(() =>
                            task({
                                number: 8,
                                title: "Action failure task",
                            })
                        )
                    ),
                    updates: [],
                    onAddUpdate: jest.fn(async () => {}),
                    onEditUpdate: jest.fn(async () => {}),
                    onDeleteUpdate: jest.fn(),
                })
            );
            const assignButton = screen.getByRole("button", {
                name: "Assign to Raymond",
            });
            act(() => {
                fireEvent.click(assignButton);
            });
            expect(assignButton).toBeDisabled();
            await act(async () => {
                assignDeferred.reject(assignError);
                try {
                    await assignDeferred.promise;
                } catch {
                    // Expected rejection path for the loading-state regression.
                }
            });
            await waitFor(() => expect(assignButton).toBeEnabled());
            expect(consoleError).toHaveBeenCalledWith(
                "Failed to assign task:",
                assignError
            );
        } finally {
            consoleError.mockRestore();
        }
    }, 10_000);
    it("renders shared UI controls with accessible confirm, search, and badge behavior", async () => {
        const user = userEvent.setup();
        const onConfirm = jest.fn();
        const onCancel = jest.fn();
        const onSearch = jest.fn();
        render(
            createElement(
                "div",
                undefined,
                createElement(ConfirmModal, {
                    isOpen: true,
                    title: "Delete task",
                    message: "This cannot be undone.",
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm,
                    onCancel,
                }),
                createElement(SearchInput, {
                    value: "cache",
                    label: "Search tasks",
                    onChange: onSearch,
                }),
                <Badge className="mt-1" variant="cron">
                    CRON
                </Badge>
            )
        );
        expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Delete",
            })
        );
        expect(onConfirm).toHaveBeenCalled();
        await user.click(
            screen.getByRole("button", {
                name: "Cancel",
            })
        );
        expect(onCancel).toHaveBeenCalled();
        await user.click(
            screen.getByRole("button", {
                name: "Clear search tasks",
            })
        );
        expect(onSearch).toHaveBeenCalledWith("");
        expect(screen.getByText("CRON")).toHaveClass("mt-1");
        expect(getSessionTypeVariant("subagent")).toBe("subagent");
        expect(getSessionTypeVariant()).toBe("default");
    });
    it("renders dropdown menu actions and disabled items", async () => {
        const user = userEvent.setup();
        const onDropdownAction = jest.fn();
        render(
            createElement(Dropdown, {
                label: "Actions",
                items: [
                    {
                        label: "Run now",
                        onClick: onDropdownAction,
                    },
                    {
                        label: "Disabled action",
                        disabled: true,
                        onClick: onDropdownAction,
                    },
                ],
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "Actions",
            })
        );
        const disabled = screen.getByRole("menuitem", {
            name: "Disabled action",
        });
        expect(disabled).toHaveAttribute("aria-disabled", "true");
        await user.click(
            screen.getByRole("menuitem", {
                name: "Run now",
            })
        );
        expect(onDropdownAction).toHaveBeenCalledTimes(1);
    });
    it("renders the task board from the API and creates a task through the real hooks", async () => {
        const tasks = [
            task({
                number: 1,
                title: "Ship Bun test reset",
                labels: [
                    {
                        name: "priority-high",
                    },
                    {
                        name: "in-progress",
                    },
                ],
            }),
        ];
        const fetchMock = createApi(tasks);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();
        renderWithQueryClient(createElement(Tasks));
        expect(await screen.findByText("Ship Bun test reset")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /new task/i,
            })
        );
        await user.type(screen.getByLabelText("Title"), "Write useful tests");
        await user.type(
            screen.getByLabelText("Description (optional)"),
            "Cover behavior"
        );
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", {
                name: "Raymond",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /^Create Task$/i,
            })
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks",
                expect.objectContaining({
                    method: "POST",
                })
            )
        );
        expect(await screen.findByText("Write useful tests")).toBeInTheDocument();
    });
    it("keeps task cards inside scrollable columns at every breakpoint", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: createApi([
                task({
                    number: 1,
                    title: "Stay inside the task column",
                    labels: [
                        {
                            name: "in-progress",
                        },
                    ],
                }),
            ]),
            writable: true,
        });
        const { container } = renderWithQueryClient(createElement(Tasks));
        await screen.findByText("Stay inside the task column");
        const taskColumn = container.querySelector('[data-column="in-progress"]');
        expect(taskColumn).toHaveClass(
            "max-h-100",
            "overflow-y-auto",
            "lg:max-h-none",
            "lg:min-h-0",
            "lg:overscroll-y-contain"
        );
        expect(taskColumn).not.toHaveClass("overscroll-contain");
        expect(taskColumn?.parentElement).toHaveClass("lg:min-h-0");
        expect(taskColumn?.parentElement?.parentElement).toHaveClass(
            "min-h-0",
            "lg:overflow-y-hidden"
        );
    });
    it("keeps the task-card assignee aligned to the card edge for short titles", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: createApi([
                task({
                    number: 1,
                    title: "Short",
                    labels: [
                        {
                            name: "in-progress",
                        },
                    ],
                }),
            ]),
            writable: true,
        });
        renderWithQueryClient(createElement(Tasks));
        const taskButton = await screen.findByRole("button", {
            name: "Open task #1: Short",
        });
        expect(taskButton).toHaveClass("peer", "absolute", "inset-0");
        expect(taskButton).not.toHaveClass("focus:ring-2", "focus:ring-accent-400");
        const cardContent = taskButton.nextElementSibling;
        expect(cardContent).toHaveClass(
            "pointer-events-none",
            "relative",
            "z-10",
            "min-w-0",
            "pl-3"
        );
        expect(cardContent).not.toHaveClass("ml-3");
        const cardFooter = cardContent?.lastElementChild;
        expect(cardFooter).toHaveClass(
            "flex",
            "items-center",
            "justify-between",
            "gap-2"
        );
        expect(cardFooter?.lastElementChild).toHaveClass("flex", "items-center", "gap-1");
        const cardFocusRing = cardContent?.nextElementSibling;
        expect(cardFocusRing).toHaveAttribute("aria-hidden", "true");
        expect(cardFocusRing).toHaveClass(
            "pointer-events-none",
            "absolute",
            "inset-0",
            "rounded-lg",
            "peer-focus-visible:ring-2",
            "peer-focus-visible:ring-accent-400"
        );
    });
    it("keeps progress update delete confirmation disabled while deletion is pending", async () => {
        const tasks = [
            task({
                number: 1,
                title: "Confirm progress delete",
                labels: [
                    {
                        name: "priority-high",
                    },
                    {
                        name: "in-progress",
                    },
                ],
            }),
        ];
        const updates: Record<number, TaskUpdate[]> = {
            1: [
                {
                    id: 11,
                    taskId: 1,
                    author: "mira-2026",
                    messageMd: "Pending delete update",
                    createdAt: "2026-06-23T08:00:00.000Z",
                },
            ],
        };
        const deleteDeferred = Promise.withResolvers<Response>();
        let deleteCalls = 0;
        const baseFetch = createApi(tasks, updates);
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/tasks/1/updates/11" && method === "DELETE") {
                    deleteCalls += 1;
                    return deleteDeferred.promise;
                }
                return baseFetch(input, init);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();
        renderWithQueryClient(createElement(Tasks));
        await user.click(
            await screen.findByRole("button", {
                name: "Open task #1: Confirm progress delete",
            })
        );
        expect(await screen.findByText("Pending delete update")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Delete progress update #11",
            })
        );
        const dialog = screen.getByRole("dialog", {
            name: "Delete progress update",
        });
        const confirmButton = within(dialog).getByRole("button", {
            name: "Delete",
        });
        act(() => {
            fireEvent.click(confirmButton);
        });
        await waitFor(() => {
            expect(deleteCalls).toBe(1);
            expect(
                within(dialog).getByRole("button", {
                    name: "Deleting...",
                })
            ).toBeDisabled();
        });
        updates[1] = [];
        await act(async () => {
            deleteDeferred.resolve(
                Response.json({
                    isOk: true,
                })
            );
            await deleteDeferred.promise;
        });
        await waitFor(() => {
            expect(
                screen.queryByRole("dialog", {
                    name: "Delete progress update",
                })
            ).not.toBeInTheDocument();
        });
        expect(deleteCalls).toBe(1);
    });
    it("filters the task board by assignee and search text", async () => {
        const tasks = [
            task({
                number: 10,
                title: "Mira backend follow-up",
                assignees: [
                    {
                        login: "mira-2026",
                        name: "Mira",
                    },
                ],
                labels: [
                    {
                        name: "priority-high",
                    },
                ],
            }),
            task({
                number: 11,
                title: "Raymond review queue",
                assignees: [
                    {
                        login: "rajohan",
                        name: "Raymond",
                    },
                ],
                labels: [
                    {
                        name: "blocked",
                    },
                ],
            }),
            task({
                number: 12,
                title: "Recurring cron check",
                assignees: [
                    {
                        login: "mira-2026",
                        name: "Mira",
                    },
                ],
                labels: [
                    {
                        name: "priority-medium",
                    },
                ],
                automation: {
                    type: "cron",
                    recurring: true,
                    cronJobId: "cron-check",
                },
            }),
        ];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: createApi(tasks),
            writable: true,
        });
        const user = userEvent.setup();
        renderWithQueryClient(createElement(Tasks));
        expect(await screen.findByText("Mira backend follow-up")).toBeInTheDocument();
        expect(screen.getByText("Raymond review queue")).toBeInTheDocument();
        expect(screen.getByText("Recurring cron check")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Recurring",
            })
        );
        expect(screen.queryByText("Mira backend follow-up")).not.toBeInTheDocument();
        expect(screen.queryByText("Raymond review queue")).not.toBeInTheDocument();
        expect(screen.getByText("Recurring cron check")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Manual",
            })
        );
        expect(screen.getByText("Mira backend follow-up")).toBeInTheDocument();
        expect(screen.getByText("Raymond review queue")).toBeInTheDocument();
        expect(screen.queryByText("Recurring cron check")).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Mira",
            })
        );
        expect(screen.getByText("Mira backend follow-up")).toBeInTheDocument();
        expect(screen.queryByText("Raymond review queue")).not.toBeInTheDocument();
        expect(screen.queryByText("Recurring cron check")).not.toBeInTheDocument();
        await user.type(screen.getByPlaceholderText("Search tasks..."), "nothing");
        expect(
            screen.getByText("No tasks match the current filters.")
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Clear filters",
            })
        );
        expect(await screen.findByText("Mira backend follow-up")).toBeInTheDocument();
        expect(screen.getByText("Raymond review queue")).toBeInTheDocument();
        expect(screen.getByText("Recurring cron check")).toBeInTheDocument();
    });
    it("keeps task board ordering aligned with triage priority", async () => {
        const tasks = [
            task({
                number: 20,
                title: "Low priority newer",
                labels: [
                    {
                        name: "priority-low",
                    },
                    {
                        name: "in-progress",
                    },
                ],
                updatedAt: "2026-06-23T12:00:00.000Z",
            }),
            task({
                number: 21,
                title: "High priority older",
                labels: [
                    {
                        name: "priority-high",
                    },
                    {
                        name: "in-progress",
                    },
                ],
                updatedAt: "2026-06-23T08:00:00.000Z",
            }),
            task({
                number: 22,
                title: "Medium priority middle",
                labels: [
                    {
                        name: "priority-medium",
                    },
                    {
                        name: "in-progress",
                    },
                ],
                updatedAt: "2026-06-23T10:00:00.000Z",
            }),
            task({
                number: 23,
                title: "Done newer low",
                labels: [
                    {
                        name: "priority-low",
                    },
                    {
                        name: "done",
                    },
                ],
                state: "CLOSED",
                updatedAt: "2026-06-24T08:00:00.000Z",
            }),
            task({
                number: 24,
                title: "Done older high",
                labels: [
                    {
                        name: "priority-high",
                    },
                    {
                        name: "done",
                    },
                ],
                state: "CLOSED",
                updatedAt: "2026-06-22T08:00:00.000Z",
            }),
        ];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: createApi(tasks),
            writable: true,
        });
        renderWithQueryClient(createElement(Tasks));
        await screen.findByText("High priority older");
        const taskOpenLabels = screen
            .getAllByRole("button", {
                name: /Open task #/u,
            })
            .map((button) => button.getAttribute("aria-label"));
        expect(taskOpenLabels).toEqual([
            "Open task #21: High priority older",
            "Open task #22: Medium priority middle",
            "Open task #20: Low priority newer",
            "Open task #23: Done newer low",
            "Open task #24: Done older high",
        ]);
    });
    it("renders empty and retry states for the task board", async () => {
        const user = userEvent.setup();
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                Response.json(
                    {
                        error: {
                            code: "service_unavailable",
                            message: "Tasks unavailable",
                            requestId: "tasks-unavailable",
                        },
                    },
                    {
                        status: 503,
                    }
                )
            )
            .mockResolvedValueOnce(Response.json([]));
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        renderWithQueryClient(createElement(Tasks));
        expect(await screen.findByText("Tasks unavailable")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Retry",
            })
        );
        expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
        expect(
            screen.getByText("Create a task when there is new work to track.")
        ).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("keeps loaded tasks visible when a refresh fails", async () => {
        const user = userEvent.setup();
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                Response.json([
                    task({
                        number: 1,
                        title: "Keep the cached task visible",
                    }),
                ])
            )
            .mockResolvedValueOnce(
                Response.json(
                    {
                        error: {
                            code: "service_unavailable",
                            message: "Tasks temporarily unavailable",
                            requestId: "tasks-refresh-unavailable",
                        },
                    },
                    {
                        status: 503,
                    }
                )
            );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        renderWithQueryClient(createElement(Tasks));
        expect(
            await screen.findByText("Keep the cached task visible")
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Refresh",
            })
        );
        expect(
            await screen.findByText(
                "Task refresh failed. Showing the last loaded tasks. Tasks temporarily unavailable"
            )
        ).toBeInTheDocument();
        expect(screen.getByText("Keep the cached task visible")).toBeInTheDocument();
    });
    it("keeps task classification and search aligned with dashboard behavior", () => {
        const unlabelled = task({
            number: 2,
            title: "Default priority",
        });
        const lowPriority = task({
            number: 4,
            title: "Triage database cleanup",
            labels: [
                {
                    name: "priority-low",
                },
            ],
        });
        const completed = task({
            number: 5,
            title: "Merged dashboard PR",
            labels: [],
            state: "CLOSED",
        });
        const blocked = task({
            number: 3,
            title: "Waiting on deploy",
            labels: [
                {
                    name: "blocked",
                },
            ],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "daily-check",
                scheduleSummary: "Every 1h",
            },
        });
        expect(getPriority(unlabelled.labels)).toBe("medium");
        expect(getPriority(lowPriority.labels)).toBe("low");
        expect(getColumnId(blocked)).toBe("blocked");
        expect(isTaskMatchSearch(unlabelled, "medium")).toBe(true);
        expect(isTaskMatchSearch(unlabelled, "new")).toBe(true);
        expect(isTaskMatchSearch(lowPriority, "priority-low")).toBe(true);
        expect(isTaskMatchSearch(completed, "done")).toBe(true);
        expect(isTaskMatchSearch(blocked, "daily-check")).toBe(true);
        expect(isTaskMatchSearch(blocked, "#3")).toBe(true);
        expect(isTaskMatchSearch(blocked, "not-present")).toBe(false);
    });
});
