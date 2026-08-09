import { afterEach, describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import type { TaskSummary } from "../../contracts/taskModel.ts";
import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import type { ListTasksResult } from "../../contracts/tasks.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { taskRealtimeRefreshDelayMs } from "../tasks/useTaskRealtimeInvalidation.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OverviewTasksSection } from "./OverviewTasksSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const initialTask = Object.freeze({
    assignee: "mira-2026",
    createdAtMs: timestampMs - 20_000,
    id: "019fe300-0000-7000-8000-000000000031",
    labels: ["rewrite"],
    priority: "high",
    status: "in-progress",
    title: "Initial active task",
    updatedAtMs: timestampMs,
    version: 3,
} as const satisfies TaskSummary);
const updatedTask = Object.freeze({
    ...initialTask,
    id: "019fe300-0000-7000-8000-000000000032",
    title: "Realtime active task",
    updatedAtMs: timestampMs + 1000,
} as const satisfies TaskSummary);

function taskPage(tasks: readonly TaskSummary[], hasMore = false): ListTasksResult {
    const last = tasks.at(-1);
    return {
        ...(hasMore && last !== undefined
            ? { nextCursor: { id: last.id, updatedAtMs: last.updatedAtMs } }
            : {}),
        tasks: [...tasks],
    };
}

type TaskOutput = Error | ListTasksResult | Promise<ListTasksResult>;

class TasksOverviewTransport implements DashboardTrpcTransport {
    readonly calls: Array<{ readonly input: unknown; readonly path: string }> = [];
    readonly #outputs: readonly TaskOutput[];

    constructor(outputs: readonly TaskOutput[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const index = this.calls.length;
        this.calls.push({ input, path });
        if (path !== "tasks.list") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const output = this.#outputs[Math.min(index, this.#outputs.length - 1)];
        if (output === undefined) {
            return Promise.reject(new TypeError("Missing tasks output"));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

interface SectionHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly transport: TasksOverviewTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(() => {
    for (const { queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
});

function renderSection(outputs: readonly TaskOutput[]): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    });
    const transport = new TasksOverviewTransport(outputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: OverviewTasksSection,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const tasksRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/tasks",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, tasksRoute]),
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <RouterProvider router={router} />
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );
    const harness = { queryClient, realtimeClient, transport, view };
    harnesses.push(harness);
    return harness;
}

async function emitTaskChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: updatedTask.id,
                entityType: "task",
                occurredAtMs: updatedTask.updatedAtMs,
                operation: "updated",
                payload: { id: updatedTask.id },
                topic: taskRealtimeTopic,
            },
            kind: "change",
        },
        id: "51",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, taskRealtimeRefreshDelayMs + 20)
        );
    });
}

describe("OverviewTasksSection", () => {
    test("loads the exact unfinished window and refreshes it after a task event", async () => {
        const firstPage = Promise.withResolvers<ListTasksResult>();
        const harness = renderSection([
            firstPage.promise,
            taskPage([updatedTask, initialTask], true),
        ]);

        expect(await screen.findByLabelText("Loading unfinished tasks…")).toBeTruthy();
        firstPage.resolve(taskPage([initialTask]));
        expect(await screen.findByText("Initial active task")).toBeTruthy();
        expect(harness.transport.calls[0]).toEqual({
            input: {
                filters: { statuses: ["blocked", "in-progress", "todo"] },
                limit: 100,
            },
            path: "tasks.list",
        });
        expect(harness.realtimeClient.input?.topics).toContain(taskRealtimeTopic);

        await emitTaskChange(harness.realtimeClient);
        expect(await screen.findByText("Realtime active task")).toBeTruthy();
        expect(harness.transport.calls).toHaveLength(2);
    });

    test("retains validated tasks when a background refresh fails", async () => {
        const rawFailure = new TypeError("private task transport detail");
        const harness = renderSection([taskPage([initialTask]), rawFailure]);
        expect(await screen.findByText("Initial active task")).toBeTruthy();

        await emitTaskChange(harness.realtimeClient);
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(screen.getByText("Initial active task")).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();
    });

    test("recovers an initial safe error through explicit retry", async () => {
        const rawFailure = new TypeError("private initial task failure");
        renderSection([rawFailure, taskPage([initialTask])]);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Unfinished tasks unavailable",
            })
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.getByText("Initial active task")).toBeTruthy());
    });
});
