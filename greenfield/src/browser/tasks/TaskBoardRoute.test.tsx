import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";
import * as v from "valibot";

import type { AuthStatus } from "../../contracts/auth.ts";
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
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";

const { render, screen } = await import("@testing-library/react");
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
    priority: "high",
    status: "in-progress",
    title: "Build task domain",
    updatedAtMs: timestampMs,
    version: 1,
});
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
                    author: { id: operatorUserId, kind: "user" },
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
            case "tasks.get": {
                const id =
                    typeof input === "object" && input !== null && "id" in input
                        ? input.id
                        : undefined;
                return Promise.resolve(this.tasks.find((task) => task.id === id));
            }
            case "tasks.list": {
                const summaries: TaskSummary[] = this.tasks.map(
                    ({ bodyMarkdown: _bodyMarkdown, ...task }) => task
                );
                return Promise.resolve({ tasks: summaries });
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

function renderTaskRoute(transport: TaskTransport) {
    const queryClient = createDashboardQueryClient();
    queryClients.push(queryClient);
    const router = createDashboardRouter(
        createMemoryHistory({ initialEntries: ["/tasks"] })
    );
    render(
        <DashboardBrowserApplication
            queryClient={queryClient}
            realtimeClient={noOpDashboardRealtimeClient}
            router={router}
            trpcClient={createDashboardTrpcClient(transport)}
            webAuthnClient={unexpectedWebAuthnClient}
        />
    );
    return queryClient;
}

afterEach(() => {
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard task route", () => {
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
        expect(screen.getByText("Build task domain")).toBeTruthy();
    });

    test("opens and edits the task creation form", async () => {
        const transport = new TaskTransport();
        renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        await user.click(screen.getByRole("button", { name: "New task" }));
        expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
        await user.type(screen.getByLabelText("Title"), "Draft task");
        expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Draft task");
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
        await user.type(screen.getByLabelText("Labels"), "tasks");
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
                    queryClient.isFetching() === 0 &&
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
        ).toMatchObject({ assignee: "mira-2026" });
        expect(queryClient.isFetching()).toBe(0);
        expect(queryClient.isMutating()).toBe(0);
        expect(screen.getByRole("heading", { level: 2, name: "Progress" })).toBeTruthy();
        expect(screen.getAllByText("Browser-created task")).toHaveLength(2);
    });

    test("adds progress and deletes a task through refreshed versioned state", async () => {
        const transport = new TaskTransport();
        const queryClient = renderTaskRoute(transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Tasks" });
        await user.click(
            screen.getByRole("button", { name: "Open task: Build task domain" })
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
                    queryClient.isFetching() === 0 &&
                    queryClient.isMutating() === 0
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(screen.getByText("Task browser flow verified")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await act(async () => {
            screen.getByRole("button", { name: "Delete task" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (queryClient.isFetching() === 0 && queryClient.isMutating() === 0) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
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
