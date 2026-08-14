import { afterEach, describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";

import type {
    AgentConfiguration,
    AgentStatusProjection,
} from "../../contracts/agentModel.ts";
import { agentRealtimeTopic } from "../../contracts/agentRealtime.ts";
import type { ListAgentStatusesResult } from "../../contracts/agents.ts";
import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { gatewayRealtimeTopics } from "../../contracts/gatewayRealtime.ts";
import { agentStatusRefreshIntervalMs } from "../agents/agentCollections.ts";
import { agentRealtimeRefreshDelayMs } from "../agents/useAgentRealtimeInvalidation.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { DashboardCollectionsProvider } from "../data/dashboardCollectionsContext.tsx";
import { captureExpectedConsoleErrors } from "../test/expectedConsoleError.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OverviewAgentsSection } from "./OverviewAgentsSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const configuration = Object.freeze({
    agents: [
        {
            description: "Primary Dashboard operator",
            displayName: "Mira",
            id: "main",
            role: "primary",
        },
        {
            description: "Focused research specialist",
            displayName: "Researcher",
            id: "researcher",
            role: "specialist",
        },
    ],
} as const satisfies AgentConfiguration);
const initialStatuses = Object.freeze({
    statuses: [
        {
            agentId: "main",
            currentTask: "Initial Dashboard task",
            freshness: "fresh",
            gatewayAvailability: "active",
            hasActiveRun: true,
            lastActivityAtMs: timestampMs,
            lastSeenAtMs: timestampMs,
            observedAtMs: timestampMs,
            sessionKey: "agent:main:main",
            startedAtMs: timestampMs - 1000,
            state: "working",
        },
        {
            agentId: "researcher",
            freshness: "unavailable",
            gatewayAvailability: "disconnected",
            lastActivityAtMs: timestampMs - 2000,
            state: "idle",
        },
    ],
} as const satisfies ListAgentStatusesResult);
const updatedMainStatus = Object.freeze({
    agentId: "main",
    currentTask: "Realtime Dashboard task",
    freshness: "stale",
    gatewayAvailability: "stale",
    hasActiveRun: true,
    lastActivityAtMs: timestampMs + 1000,
    lastSeenAtMs: timestampMs,
    observedAtMs: timestampMs,
    sessionKey: "agent:main:main",
    startedAtMs: timestampMs + 1000,
    state: "working",
} as const satisfies AgentStatusProjection);
const updatedStatuses = Object.freeze({
    statuses: [updatedMainStatus, initialStatuses.statuses[1]],
} as const satisfies ListAgentStatusesResult);

type ConfigurationOutput = AgentConfiguration | Error | Promise<AgentConfiguration>;
type StatusOutput = Error | ListAgentStatusesResult | Promise<ListAgentStatusesResult>;

class AgentsOverviewTransport implements DashboardTrpcTransport {
    readonly calls: Array<{ readonly input: unknown; readonly path: string }> = [];
    readonly #configurationOutputs: readonly ConfigurationOutput[];
    readonly #statusOutputs: readonly StatusOutput[];

    constructor(
        configurationOutputs: readonly ConfigurationOutput[],
        statusOutputs: readonly StatusOutput[]
    ) {
        this.#configurationOutputs = configurationOutputs;
        this.#statusOutputs = statusOutputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const index = this.calls.filter((call) => call.path === path).length;
        this.calls.push({ input, path });
        let outputs: readonly ConfigurationOutput[] | readonly StatusOutput[] | undefined;
        if (path === "agents.getConfiguration") {
            outputs = this.#configurationOutputs;
        } else if (path === "agents.listStatuses") {
            outputs = this.#statusOutputs;
        }
        if (outputs === undefined) {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const output = outputs[Math.min(index, outputs.length - 1)];
        if (output === undefined) {
            return Promise.reject(new TypeError(`Missing agent output: ${path}`));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

interface SectionHarness {
    readonly collections: DashboardBrowserCollections;
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly transport: AgentsOverviewTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(async () => {
    for (const { collections, queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        await collections.cleanup();
        queryClient.clear();
    }
});

function renderSection(
    configurationOutputs: readonly ConfigurationOutput[],
    statusOutputs: readonly StatusOutput[]
): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    });
    const transport = new AgentsOverviewTransport(configurationOutputs, statusOutputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: OverviewAgentsSection,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const agentsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/agents",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, agentsRoute]),
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <DashboardCollectionsProvider collections={collections}>
                        <RouterProvider router={router} />
                    </DashboardCollectionsProvider>
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );
    const harness = { collections, queryClient, realtimeClient, transport, view };
    harnesses.push(harness);
    return harness;
}

async function emitAgentChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: "main",
                entityType: "agent",
                occurredAtMs: updatedMainStatus.lastActivityAtMs,
                operation: "updated",
                payload: { id: "main" },
                topic: agentRealtimeTopic,
            },
            kind: "change",
        },
        id: "81",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, agentRealtimeRefreshDelayMs + 20)
        );
    });
}

async function emitGatewaySessionChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: "current",
                entityType: "gateway-sessions",
                occurredAtMs: updatedMainStatus.lastActivityAtMs,
                operation: "snapshot-required",
                payload: { kind: "snapshot-required" },
                topic: gatewayRealtimeTopics.sessions,
            },
            kind: "change",
        },
        id: "82",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, agentRealtimeRefreshDelayMs + 20)
        );
    });
}

async function emitGatewayConnectionChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: "current",
                entityType: "gateway-connection",
                occurredAtMs: updatedMainStatus.lastActivityAtMs,
                operation: "snapshot-required",
                payload: { kind: "snapshot-required" },
                topic: gatewayRealtimeTopics.connection,
            },
            kind: "change",
        },
        id: "83",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, agentRealtimeRefreshDelayMs + 20)
        );
    });
}

describe("OverviewAgentsSection", () => {
    test("repairs a lost targeted session marker through bounded foreground polling", async () => {
        jest.useFakeTimers();
        try {
            const harness = renderSection(
                [configuration],
                [initialStatuses, updatedStatuses]
            );
            await act(async () => {
                await Promise.resolve();
            });
            expect(screen.getByText("Initial Dashboard task")).toBeTruthy();
            expect(harness.realtimeClient.input).not.toBeNull();
            expect(
                harness.transport.calls.filter(
                    ({ path }) => path === "agents.listStatuses"
                )
            ).toHaveLength(1);

            await act(async () => {
                jest.advanceTimersByTime(agentStatusRefreshIntervalMs);
                await Promise.resolve();
            });
            jest.useRealTimers();

            expect(await screen.findByText("Realtime Dashboard task")).toBeTruthy();
            expect(
                harness.transport.calls.filter(
                    ({ path }) => path === "agents.listStatuses"
                )
            ).toHaveLength(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test("loads complete projections and refreshes current tasks after realtime", async () => {
        const firstStatuses = Promise.withResolvers<ListAgentStatusesResult>();
        const harness = renderSection(
            [configuration, configuration],
            [firstStatuses.promise, updatedStatuses]
        );

        expect(await screen.findByLabelText("Loading agent activity…")).toBeTruthy();
        firstStatuses.resolve(initialStatuses);
        expect(await screen.findByText("Initial Dashboard task")).toBeTruthy();
        expect(harness.transport.calls).toEqual(
            expect.arrayContaining([
                { input: {}, path: "agents.getConfiguration" },
                { input: {}, path: "agents.listStatuses" },
            ])
        );
        expect(harness.realtimeClient.input).toEqual({
            lastEventId: "0",
            topics: [
                agentRealtimeTopic,
                gatewayRealtimeTopics.connection,
                gatewayRealtimeTopics.sessions,
            ],
        });

        await emitAgentChange(harness.realtimeClient);
        expect(await screen.findByText("Realtime Dashboard task")).toBeTruthy();
        expect(
            harness.transport.calls.filter(({ path }) => path === "agents.listStatuses")
        ).toHaveLength(2);

        await emitGatewaySessionChange(harness.realtimeClient);
        expect(
            harness.transport.calls.filter(({ path }) => path === "agents.listStatuses")
        ).toHaveLength(3);

        await emitGatewayConnectionChange(harness.realtimeClient);
        expect(
            harness.transport.calls.filter(({ path }) => path === "agents.listStatuses")
        ).toHaveLength(4);
    });

    test("retains complete agent data when a background refresh fails", async () => {
        const rawFailure = new TypeError("private agent status detail");
        const consoleErrors = captureExpectedConsoleErrors([rawFailure]);
        try {
            const harness = renderSection(
                [configuration, configuration],
                [initialStatuses, rawFailure]
            );
            expect(await screen.findByText("Initial Dashboard task")).toBeTruthy();

            await emitAgentChange(harness.realtimeClient);
            expect(
                await screen.findByText("The request could not be completed. Try again.")
            ).toBeTruthy();
            expect(screen.getByText("Initial Dashboard task")).toBeTruthy();
            expect(screen.queryByText(rawFailure.message)).toBeNull();
            consoleErrors.expectObserved();
        } finally {
            consoleErrors.restore();
        }
    });

    test("recovers an initial safe configuration error through retry", async () => {
        const rawFailure = new TypeError("private agent configuration detail");
        const consoleErrors = captureExpectedConsoleErrors([rawFailure]);
        try {
            renderSection(
                [rawFailure, configuration],
                [initialStatuses, initialStatuses]
            );

            expect(
                await screen.findByRole("heading", {
                    level: 2,
                    name: "Agent activity unavailable",
                })
            ).toBeTruthy();
            expect(screen.queryByText(rawFailure.message)).toBeNull();

            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "Try again" }));
            await waitFor(() =>
                expect(screen.getByText("Initial Dashboard task")).toBeTruthy()
            );
            consoleErrors.expectObserved();
        } finally {
            consoleErrors.restore();
        }
    });
});
