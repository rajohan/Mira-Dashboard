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
import type { ListIncidentsResult } from "../../contracts/incidents.ts";
import type { IncidentSummary } from "../../contracts/monitoring.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { monitoringRealtimeRefreshDelayMs } from "../monitoring/useMonitoringRealtimeInvalidation.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OverviewIncidentsSection } from "./OverviewIncidentsSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const initialIncident = Object.freeze({
    fingerprint: "a".repeat(64),
    firstSeenAtMs: timestampMs - 1000,
    generation: 1,
    id: "019fe300-0000-7000-8000-000000000051",
    kind: "filesystem",
    lastSeenAtMs: timestampMs,
    monitorKey: "ops-check",
    occurrenceCount: 2,
    severity: "warning",
    state: "active",
    title: "Initial active incident",
} as const satisfies IncidentSummary);
const updatedIncident = Object.freeze({
    ...initialIncident,
    fingerprint: "b".repeat(64),
    id: "019fe300-0000-7000-8000-000000000052",
    lastSeenAtMs: timestampMs + 1000,
    occurrenceCount: 1,
    severity: "error",
    title: "Realtime active incident",
} as const satisfies IncidentSummary);

function incidentPage(
    incidents: readonly IncidentSummary[],
    hasMore = false
): ListIncidentsResult {
    const last = incidents.at(-1);
    return {
        incidents: [...incidents],
        ...(hasMore && last !== undefined
            ? { nextCursor: { id: last.id, lastSeenAtMs: last.lastSeenAtMs } }
            : {}),
    };
}

type IncidentOutput = Error | ListIncidentsResult | Promise<ListIncidentsResult>;

class IncidentsOverviewTransport implements DashboardTrpcTransport {
    readonly calls: Array<{ readonly input: unknown; readonly path: string }> = [];
    readonly #outputs: readonly IncidentOutput[];

    constructor(outputs: readonly IncidentOutput[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const index = this.calls.length;
        this.calls.push({ input, path });
        if (path !== "incidents.list") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const output = this.#outputs[Math.min(index, this.#outputs.length - 1)];
        if (output === undefined) {
            return Promise.reject(new TypeError("Missing incidents output"));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

interface SectionHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly transport: IncidentsOverviewTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(() => {
    for (const { queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
});

function renderSection(outputs: readonly IncidentOutput[]): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    });
    const transport = new IncidentsOverviewTransport(outputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: OverviewIncidentsSection,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const incidentsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/incidents",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, incidentsRoute]),
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

async function emitIncidentChange(
    realtimeClient: ControlledDashboardRealtimeClient
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: updatedIncident.id,
                entityType: "incident",
                occurredAtMs: updatedIncident.lastSeenAtMs,
                operation: "updated",
                payload: { id: updatedIncident.id },
                topic: monitoringRealtimeTopics.incidents,
            },
            kind: "change",
        },
        id: "71",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, monitoringRealtimeRefreshDelayMs + 20)
        );
    });
}

describe("OverviewIncidentsSection", () => {
    test("loads the exact active window and refreshes after incident realtime", async () => {
        const firstPage = Promise.withResolvers<ListIncidentsResult>();
        const harness = renderSection([
            firstPage.promise,
            incidentPage([updatedIncident, initialIncident], true),
        ]);

        expect(await screen.findByLabelText("Loading active incidents…")).toBeTruthy();
        firstPage.resolve(incidentPage([initialIncident]));
        expect(await screen.findByText("Initial active incident")).toBeTruthy();
        expect(harness.transport.calls[0]).toEqual({
            input: { filters: { states: ["active"] }, limit: 12 },
            path: "incidents.list",
        });
        expect(harness.realtimeClient.input).toEqual({
            lastEventId: "0",
            topics: [monitoringRealtimeTopics.incidents],
        });

        await emitIncidentChange(harness.realtimeClient);
        expect(await screen.findByText("Realtime active incident")).toBeTruthy();
        expect(harness.transport.calls).toHaveLength(2);
    });

    test("retains validated generations when a realtime refresh fails", async () => {
        const rawFailure = new TypeError("private incident transport detail");
        const harness = renderSection([incidentPage([initialIncident]), rawFailure]);
        expect(await screen.findByText("Initial active incident")).toBeTruthy();

        await emitIncidentChange(harness.realtimeClient);
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(screen.getByText("Initial active incident")).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();
    });

    test("recovers an initial safe error through explicit retry", async () => {
        const rawFailure = new TypeError("private initial incident failure");
        renderSection([rawFailure, incidentPage([initialIncident])]);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Active incidents unavailable",
            })
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() =>
            expect(screen.getByText("Initial active incident")).toBeTruthy()
        );
    });
});
