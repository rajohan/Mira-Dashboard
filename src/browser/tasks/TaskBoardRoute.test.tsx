import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act as reactAct } from "react";
import * as v from "valibot";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    GetOpenClawCronResult,
    ListOpenClawCronResult,
} from "../../contracts/openClawCron.ts";
import type {
    TaskDetail,
    TaskProgressUpdate,
    TaskSummary,
} from "../../contracts/taskModel.ts";
import {
    addTaskProgressInputSchema,
    createTaskInputSchema,
    deleteTaskInputSchema,
} from "../../contracts/tasks.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { formatDashboardDateTimeToMinute } from "../lib/formatDateTime.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { TaskBoard } from "./TaskBoard.tsx";
import { taskQueryKey } from "./taskQueries.ts";

const originalActEnvironment: unknown = Reflect.get(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT"
);

beforeAll(() => Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false));
afterAll(() =>
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment)
);

async function act(callback: () => Promise<void> | void): Promise<void> {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    try {
        await reactAct(callback);
    } finally {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    }
}

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const operatorUserId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const authenticatedStatus: AuthStatus = Object.freeze({
    session: {
        authenticatedAtMs: timestampMs,
        authMethod: "password" as const,
        createdAtMs: timestampMs,
        expiresAtMs: timestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: timestampMs,
        userAgent: "Task browser test",
    },
    state: "authenticated",
    user: {
        email: "operator@example.com",
        id: operatorUserId,
        username: "operator",
    },
});
const initialTask: TaskDetail = Object.freeze({
    assignee: "mira-2026",
    bodyMarkdown: "Ship the rewritten task board.",
    createdAtMs: timestampMs,
    id: "019fd984-63e8-7404-a7da-80c6f243794f",
    labels: ["phase-three", "tasks"],
    number: 232,
    priority: "high",
    status: "in-progress",
    title: "Build task domain",
    updatedAtMs: timestampMs,
    version: 1,
});

function cronDetail(id: string, enabled = true): GetOpenClawCronResult {
    return {
        freshness: { kind: "fresh", observedAtMs: timestampMs },
        job: {
            agentIdTruncated: false,
            createdAtMs: timestampMs - 86_400_000,
            deliveryMode: "unspecified",
            descriptionTruncated: false,
            enabled,
            id,
            name: "Nightly report job",
            nameTruncated: false,
            payload: {
                kind: "agent-turn",
                message: "Generate the nightly report",
                model: "openai/gpt-5.6-sol",
                thinking: "high",
                truncated: false,
            },
            schedule: { everyMs: 86_400_000, kind: "every", truncated: false },
            sessionTarget: "isolated",
            source: "openclaw",
            state: {
                lastRunAtMs: timestampMs - 60_000,
                lastRunStatus: "ok",
                nextRunAtMs: timestampMs + 86_400_000,
            },
            synchronization: { state: "confirmed" },
            updatedAtMs: timestampMs,
            wakeMode: "now",
        },
    };
}

function cronInventoryPage(
    jobs: readonly GetOpenClawCronResult["job"][],
    offset: number,
    total: number
): ListOpenClawCronResult {
    const nextOffset = offset + jobs.length;
    const hasMore = nextOffset < total;
    return {
        freshness: { kind: "fresh", observedAtMs: timestampMs },
        hasMore,
        jobs: [...jobs],
        limit: 100,
        ...(hasMore ? { nextOffset } : {}),
        offset,
        snapshotRevision: `sha256:${"A".repeat(43)}`,
        total,
    };
}
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
}

class TaskTransport implements DashboardTrpcTransport {
    readonly calls: TransportCall[] = [];
    readonly cronDetails = new Map<string, GetOpenClawCronResult>();
    readonly labelSuggestions = ["archived-label", "phase-three", "tasks"];
    cronInventoryPages: ListOpenClawCronResult[] = [];
    taskListQueryResponse: Promise<unknown> | undefined;
    tasks: TaskDetail[] = [initialTask];
    updates: TaskProgressUpdate[] = [];

    mutation(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path });
        switch (path) {
            case "tasks.addUpdate": {
                const parsed = v.parse(addTaskProgressInputSchema, input);
                const taskIndex = this.tasks.findIndex(
                    (task) => task.id === parsed.taskId
                );
                const task = this.tasks[taskIndex];
                if (task === undefined) {
                    return Promise.reject(new TypeError("Task is missing"));
                }
                const update: TaskProgressUpdate = {
                    author: {
                        id: operatorUserId,
                        kind: "user",
                        username: "operator",
                    },
                    createdAtMs: timestampMs + 10,
                    id: "019fd986-b3d4-7861-b7ce-e42eb18e7af8",
                    messageMarkdown: parsed.messageMarkdown,
                    taskId: parsed.taskId,
                    updatedAtMs: timestampMs + 10,
                    version: 1,
                };
                this.tasks = this.tasks.with(taskIndex, {
                    ...task,
                    updatedAtMs: timestampMs + 10,
                    version: task.version + 1,
                });
                this.updates = [update, ...this.updates];
                return Promise.resolve(update);
            }
            case "tasks.create": {
                const parsed = v.parse(createTaskInputSchema, input);
                const created: TaskDetail = {
                    ...(parsed.assignee === undefined
                        ? {}
                        : { assignee: parsed.assignee }),
                    ...(parsed.automation === undefined
                        ? {}
                        : { automation: parsed.automation }),
                    ...(parsed.bodyMarkdown === undefined
                        ? {}
                        : { bodyMarkdown: parsed.bodyMarkdown }),
                    createdAtMs: timestampMs + 1,
                    id: "019fd985-a9c4-7586-8706-c11563dd5e5d",
                    labels: parsed.labels ?? [],
                    number: 233,
                    priority: parsed.priority ?? "medium",
                    status: parsed.status ?? "todo",
                    title: parsed.title,
                    updatedAtMs: timestampMs + 1,
                    version: 1,
                };
                this.tasks = [created, ...this.tasks];
                return Promise.resolve(created);
            }
            case "tasks.delete": {
                const parsed = v.parse(deleteTaskInputSchema, input);
                this.tasks = this.tasks.filter((task) => task.id !== parsed.id);
                this.updates = this.updates.filter(
                    (update) => update.taskId !== parsed.id
                );
                return Promise.resolve({
                    deletedAtMs: timestampMs + 20,
                    id: parsed.id,
                });
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
        }
    }

    query(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "query", path });
        switch (path) {
            case "auth.status": {
                return Promise.resolve(authenticatedStatus);
            }
            case "notifications.list": {
                return Promise.resolve(emptyNotificationListResult);
            }
            case "openClawCron.get": {
                const id =
                    typeof input === "object" && input !== null && "id" in input
                        ? input.id
                        : undefined;
                const detail =
                    typeof id === "string" ? this.cronDetails.get(id) : undefined;
                return detail === undefined
                    ? Promise.reject(new TypeError("OpenClaw cron job is missing"))
                    : Promise.resolve(detail);
            }
            case "openClawCron.list": {
                const offset =
                    typeof input === "object" && input !== null && "offset" in input
                        ? input.offset
                        : undefined;
                const page =
                    typeof offset === "number"
                        ? this.cronInventoryPages.find(
                              (candidate) => candidate.offset === offset
                          )
                        : undefined;
                return page === undefined
                    ? Promise.reject(new TypeError("OpenClaw cron inventory is missing"))
                    : Promise.resolve(page);
            }
            case "tasks.get": {
                const id =
                    typeof input === "object" && input !== null && "id" in input
                        ? input.id
                        : undefined;
                return Promise.resolve(this.tasks.find((task) => task.id === id));
            }
            case "tasks.list": {
                if (this.taskListQueryResponse !== undefined) {
                    return this.taskListQueryResponse;
                }
                const summaries: TaskSummary[] = this.tasks.map(
                    ({ bodyMarkdown: _bodyMarkdown, ...task }) => task
                );
                return Promise.resolve({ tasks: summaries });
            }
            case "tasks.listLabels": {
                return Promise.resolve({
                    labels: this.labelSuggestions,
                    truncated: false,
                });
            }
            case "tasks.listUpdates": {
                const taskId =
                    typeof input === "object" && input !== null && "taskId" in input
                        ? input.taskId
                        : undefined;
                return Promise.resolve({
                    updates: this.updates.filter((update) => update.taskId === taskId),
                });
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
    }
}

const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

function renderTaskRoute(
    transport: TaskTransport,
    queryClient = createDashboardQueryClient()
) {
    queryClients.push(queryClient);
    const router = createDashboardRouter(
        createMemoryHistory({ initialEntries: ["/tasks"] })
    );
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    collectionRegistries.push(collections);
    mountedViews.push(
        render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={router}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        )
    );
    return queryClient;
}

afterEach(async () => {
    for (const view of mountedViews.splice(0)) view.unmount();
    await Promise.all(
        collectionRegistries.splice(0).map((collections) => collections.cleanup())
    );
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard task route", () => {
    test("owns the global continuation in only the most populated column", () => {
        const task = (index: number, status: TaskSummary["status"]): TaskSummary => ({
            createdAtMs: timestampMs - index,
            id: `019fd984-63e8-7404-a7da-80c6f24379${index.toString().padStart(2, "0")}`,
            labels: [],
            number: index + 1,
            priority: "medium",
            status,
            title: `Task ${index + 1}`,
            updatedAtMs: timestampMs - index,
            version: 1,
        });
        const view = render(
            <TaskBoard
                cronJobsById={new Map()}
                disabled={false}
                onMoveTask={() => {}}
                onSelectTask={() => {}}
                pagination={{
                    hasMore: true,
                    loading: false,
                    loadingLabel: "Loading more tasks…",
                    onLoadMore: () => {},
                }}
                tasks={[task(0, "todo"), task(1, "in-progress"), task(2, "in-progress")]}
            />
        );

        expect(
            view.container.querySelectorAll("[data-infinite-scroll-trigger]")
        ).toHaveLength(1);
        const activeColumn = screen
            .getByRole("heading", { name: "In progress" })
            .closest("section");
        expect(activeColumn).not.toBeNull();
        expect(
            within(activeColumn!).getByRole("region", {
                name: "In progress tasks scroll area",
            })
        ).toContainElement(
            view.container.querySelector("[data-infinite-scroll-trigger]")
        );
    });

    test("renders the authenticated four-column board", async () => {
        const transport = new TaskTransport();
        renderTaskRoute(transport);

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        for (const column of ["To do", "In progress", "Blocked", "Done"]) {
            expect(screen.getByRole("heading", { level: 2, name: column })).toBeTruthy();
        }
        expect(
            screen.getByRole("button", { name: "Filter tasks by assignee" })
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Filter tasks by automation" })
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
        expect(screen.queryByText("Work management")).toBeNull();
        expect(screen.queryByText(/Updates automatically from task events/u)).toBeNull();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        expect(screen.getByText("Build task domain")).toBeTruthy();
        expect(
            transport.calls.some((call) => call.path === "openClawCron.list")
        ).toBeFalse();
    });

    test("keeps search focused while the filtered task list is loading", async () => {
        const transport = new TaskTransport();
        renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByText("Build task domain");
        const filteredListRequest = Promise.withResolvers<unknown>();
        transport.taskListQueryResponse = filteredListRequest.promise;
        const search = screen.getByRole("searchbox", { name: "Search tasks" });

        await user.type(search, "p");
        await waitFor(() =>
            expect(transport.calls).toContainEqual({
                input: { filters: { search: "p" }, limit: 100 },
                kind: "query",
                path: "tasks.list",
            })
        );
        expect(search).not.toBeDisabled();
        expect(search).toHaveFocus();

        await act(async () => {
            filteredListRequest.resolve({ tasks: [] });
            await filteredListRequest.promise;
        });
        expect(
            await screen.findByRole("heading", { name: "No matching tasks" })
        ).toBeTruthy();
    });

    test("retains explicit retry for an initial list failure", async () => {
        const transport = new TaskTransport();
        const listRequest = Promise.withResolvers<unknown>();
        transport.taskListQueryResponse = listRequest.promise;
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(taskQueryKey, { retry: false });
        renderTaskRoute(transport, queryClient);

        await act(async () => {
            listRequest.reject(new TypeError("private task list failure"));
            await listRequest.promise.catch(() => {});
        });
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.queryByText(/private task list failure/u)).toBeNull();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();

        transport.taskListQueryResponse = undefined;
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Build task domain")).toBeTruthy();
    });

    test("retries a failed background task refresh instead of loading older tasks", async () => {
        const transport = new TaskTransport();
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(taskQueryKey, { retry: false });
        renderTaskRoute(transport, queryClient);

        await screen.findByText("Build task domain");
        const callsBeforeRefresh = transport.calls.filter(
            (call) => call.path === "tasks.list"
        ).length;
        transport.taskListQueryResponse = Promise.reject(
            new TypeError("private background task refresh failure")
        );
        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: taskQueryKey });
        });

        const retry = await screen.findByRole("button", { name: "Try again" });
        expect(screen.queryByText(/private background task refresh failure/u)).toBeNull();
        transport.taskListQueryResponse = undefined;
        await userEvent.setup().click(retry);
        await waitFor(() =>
            expect(
                transport.calls.filter((call) => call.path === "tasks.list").length
            ).toBeGreaterThan(callsBeforeRefresh + 1)
        );
        expect(screen.getByText("Build task domain")).toBeTruthy();
    });

    test("opens and edits the task creation form", async () => {
        const transport = new TaskTransport();
        renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        await user.click(screen.getByRole("button", { name: "New task" }));
        expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
        expect(screen.getByLabelText("Title")).toHaveAttribute(
            "placeholder",
            "Task title"
        );
        expect(screen.getByLabelText("Description (optional)")).toHaveAttribute(
            "placeholder",
            "Task description"
        );
        await user.click(screen.getByRole("checkbox", { name: "Attach automation" }));
        expect(screen.getByLabelText("Cron job id")).toHaveAttribute(
            "placeholder",
            "morning-report"
        );
        expect(screen.getByLabelText("Schedule summary")).toHaveAttribute(
            "placeholder",
            "Every weekday at 08:00"
        );
        expect(screen.getByLabelText("Model")).toHaveAttribute(
            "placeholder",
            "openai/gpt-5.6"
        );
        expect(screen.getByLabelText("Thinking")).toHaveAttribute("placeholder", "high");
        expect(screen.getByLabelText("Session target")).toHaveAttribute(
            "placeholder",
            "agent:main:main"
        );
        await user.type(screen.getByLabelText("Title"), "Draft task");
        expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Draft task");
    });

    test("suggests persisted labels outside the current task page", async () => {
        const transport = new TaskTransport();
        renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByText("Build task domain");
        await waitFor(() =>
            expect(transport.calls).toContainEqual({
                input: {},
                kind: "query",
                path: "tasks.listLabels",
            })
        );
        await user.click(screen.getByRole("button", { name: "New task" }));
        const dialog = await screen.findByRole("dialog", { name: "New task" });
        await user.click(
            within(dialog).getByRole("button", {
                name: /Additional details \(optional\)/u,
            })
        );
        const suggestionsButton = within(dialog).getByRole("button", {
            name: "Show existing labels",
        });
        await waitFor(() => expect(suggestionsButton).not.toBeDisabled());
        await user.click(suggestionsButton);

        expect(
            await screen.findByRole("option", { name: "archived-label" })
        ).toBeTruthy();
    });

    test("links an automated task to its exact OpenClaw cron selection", async () => {
        const transport = new TaskTransport();
        const retainedCron = cronDetail("nightly-report", false);
        transport.cronInventoryPages = [
            cronInventoryPage([cronDetail("unrelated-job").job], 0, 2),
            cronInventoryPage([retainedCron.job], 1, 2),
        ];
        transport.cronDetails.set("nightly-report", {
            ...retainedCron,
            freshness: {
                kind: "last-known-good",
                observedAtMs: timestampMs - 10_000,
                staleSinceMs: timestampMs - 5000,
            },
        });
        transport.tasks = [
            {
                ...initialTask,
                automation: {
                    cronJobId: "nightly-report",
                    kind: "openclaw-cron",
                    recurring: true,
                    scheduleSummary: "Nightly report",
                },
            },
        ];
        renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        expect(await screen.findByText("Disabled")).toBeTruthy();
        expect(screen.getByText("Recurring")).toBeTruthy();
        await waitFor(() =>
            expect(
                transport.calls
                    .filter((call) => call.path === "openClawCron.list")
                    .map((call) => call.input)
            ).toEqual([
                expect.objectContaining({ offset: 0 }),
                expect.objectContaining({ offset: 1 }),
            ])
        );
        await user.click(
            screen.getByRole("button", {
                name: "Open task #232: Build task domain",
            })
        );
        const dialog = await screen.findByRole("dialog", {
            name: "#232: Build task domain",
        });
        const detail = within(dialog);
        const link = await detail.findByRole<HTMLAnchorElement>("link", {
            name: "Open OpenClaw cron job nightly-report",
        });
        const destination = new URL(link.href);
        expect(destination.pathname).toBe("/jobs");
        expect(Object.fromEntries(destination.searchParams)).toEqual({
            cronJobId: "nightly-report",
            source: "openclaw",
        });
        expect(await detail.findByText("Disabled")).toBeTruthy();
        expect(detail.getByText("Recurring")).toBeTruthy();
        expect(detail.getByText("Nightly report job")).toBeTruthy();
        expect(detail.getByText("Every 1 day")).toBeTruthy();
        expect(detail.getByText("openai/gpt-5.6-sol · high")).toBeTruthy();
        expect(
            detail.getByText(
                "The latest refresh failed, so the last available OpenClaw status is shown."
            )
        ).toBeTruthy();
    });

    test("renders the legacy-shaped board and creates a contract-valid task", async () => {
        const transport = new TaskTransport();
        const queryClient = renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        for (const column of ["To do", "In progress", "Blocked", "Done"]) {
            expect(screen.getByRole("heading", { level: 2, name: column })).toBeTruthy();
        }
        expect(screen.getByText("Build task domain")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "New task" }));
        await user.type(screen.getByLabelText("Title"), "Browser-created task");
        await user.click(
            screen.getByRole("button", { name: /Additional details \(optional\)/u })
        );
        expect(screen.getByText("Press Enter to add a label.")).toBeTruthy();
        await user.type(screen.getByLabelText("Labels"), "tasks{Enter}");
        await act(async () => {
            screen.getByRole("button", { name: "Create task" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                const created = transport.calls.some(
                    (call) => call.kind === "mutation" && call.path === "tasks.create"
                );
                if (
                    created &&
                    screen.queryByRole("heading", {
                        level: 2,
                        name: "Progress",
                    }) !== null &&
                    queryClient.isFetching({ queryKey: taskQueryKey }) === 0 &&
                    queryClient.isMutating() === 0
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(
            transport.calls.some(
                (call) => call.kind === "mutation" && call.path === "tasks.create"
            )
        ).toBeTrue();
        expect(
            transport.calls.find(
                (call) => call.kind === "mutation" && call.path === "tasks.create"
            )?.input
        ).toMatchObject({ assignee: "mira-2026", labels: ["tasks"] });
        expect(queryClient.isFetching({ queryKey: taskQueryKey })).toBe(0);
        expect(queryClient.isMutating()).toBe(0);
        expect(screen.getByRole("heading", { level: 2, name: "Progress" })).toBeTruthy();
        expect(
            screen.getByRole("dialog", { name: "#233: Browser-created task" })
        ).toBeTruthy();
        expect(screen.getByText("Browser-created task")).toBeTruthy();
    });

    test("adds progress and deletes a task through refreshed versioned state", async () => {
        const transport = new TaskTransport();
        const queryClient = renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        await user.click(
            screen.getByRole("button", {
                name: "Open task #232: Build task domain",
            })
        );
        expect(
            await screen.findByRole("heading", { level: 2, name: "Progress" })
        ).toBeTruthy();
        await user.type(
            screen.getByLabelText("New progress update"),
            "Task browser flow verified"
        );
        await act(async () => {
            screen.getByRole("button", { name: "Add update" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (
                    screen.queryByText("Task browser flow verified") !== null &&
                    queryClient.isFetching({ queryKey: taskQueryKey }) === 0 &&
                    queryClient.isMutating() === 0
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(screen.getByText("Task browser flow verified")).toBeTruthy();
        expect(
            screen.getByTitle(`Audit identity: user:${operatorUserId}`)
        ).toHaveTextContent(
            `@operator · ${formatDashboardDateTimeToMinute(timestampMs + 10)}`
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await act(async () => {
            screen.getByRole("button", { name: "Delete task" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (
                    queryClient.isFetching({ queryKey: taskQueryKey }) === 0 &&
                    queryClient.isMutating() === 0
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
        expect(screen.queryByRole("dialog", { name: "Build task domain" })).toBeNull();
        expect(screen.queryByText("Build task domain")).toBeNull();
        expect(
            transport.calls.find(
                (call) => call.kind === "mutation" && call.path === "tasks.delete"
            )?.input
        ).toEqual({ expectedVersion: 2, id: initialTask.id });
    });
});
