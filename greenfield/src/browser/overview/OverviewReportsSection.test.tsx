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
import type { ReportSummary } from "../../contracts/monitoring.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import type { ListReportsResult } from "../../contracts/reports.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { monitoringRealtimeRefreshDelayMs } from "../monitoring/useMonitoringRealtimeInvalidation.ts";
import { ControlledDashboardRealtimeClient } from "../test/realtime.ts";
import { OverviewReportsSection } from "./OverviewReportsSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const initialReport = Object.freeze({
    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
    kind: "heartbeat",
    occurredAtMs: 1_800_000_000_000,
    source: "monitor",
    status: "ok",
    title: "Initial report",
} as const satisfies ReportSummary);

const updatedReport = Object.freeze({
    id: "019fd984-63e8-7404-a7da-80c6f243794f",
    kind: "daily-brief",
    occurredAtMs: 1_800_000_100_000,
    source: "monitor",
    status: "warning",
    title: "Realtime report",
} as const satisfies ReportSummary);

function reportPage(
    reports: readonly ReportSummary[],
    hasMore = false
): ListReportsResult {
    const last = reports.at(-1);
    return {
        ...(hasMore && last !== undefined
            ? { nextCursor: { id: last.id, occurredAtMs: last.occurredAtMs } }
            : {}),
        reports: [...reports],
    };
}

type ReportOutput = Error | ListReportsResult | Promise<ListReportsResult>;

class ReportsOverviewTransport implements DashboardTrpcTransport {
    readonly calls: Array<{ readonly input: unknown; readonly path: string }> = [];
    readonly #outputs: readonly ReportOutput[];

    constructor(outputs: readonly ReportOutput[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const index = this.calls.length;
        this.calls.push({ input, path });
        if (path !== "reports.list") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const output = this.#outputs[Math.min(index, this.#outputs.length - 1)];
        if (output === undefined) {
            return Promise.reject(new TypeError("Missing reports output"));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

interface SectionHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly realtimeClient: ControlledDashboardRealtimeClient;
    readonly transport: ReportsOverviewTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(() => {
    for (const { queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
});

function renderSection(outputs: readonly ReportOutput[]): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    const transport = new ReportsOverviewTransport(outputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const realtimeClient = new ControlledDashboardRealtimeClient();
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component: OverviewReportsSection,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const reportsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/reports",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([overviewRoute, reportsRoute]),
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

async function emitReportChange(
    realtimeClient: ControlledDashboardRealtimeClient,
    report: ReportSummary
): Promise<void> {
    const output: RealtimeStreamOutput = {
        data: {
            event: {
                entityId: report.id,
                entityType: "report",
                occurredAtMs: report.occurredAtMs,
                operation: "created",
                payload: { id: report.id },
                topic: monitoringRealtimeTopics.reports,
            },
            kind: "change",
        },
        id: "18",
    };
    await act(async () => {
        realtimeClient.emit(output);
        await new Promise((resolve) =>
            setTimeout(resolve, monitoringRealtimeRefreshDelayMs + 20)
        );
    });
}

describe("OverviewReportsSection", () => {
    test("loads one newest-50 window and refreshes it after a report event", async () => {
        const firstPage = Promise.withResolvers<ListReportsResult>();
        const harness = renderSection([
            firstPage.promise,
            reportPage([updatedReport, initialReport], true),
        ]);

        expect(await screen.findByLabelText("Loading reports overview…")).toBeTruthy();
        firstPage.resolve(reportPage([initialReport]));
        expect(
            await screen.findByRole("heading", { level: 3, name: "Initial report" })
        ).toBeTruthy();
        expect(harness.transport.calls[0]).toEqual({
            input: { limit: 50 },
            path: "reports.list",
        });
        expect(harness.realtimeClient.input).toEqual({
            lastEventId: "0",
            topics: [monitoringRealtimeTopics.reports],
        });

        await emitReportChange(harness.realtimeClient, updatedReport);
        expect(
            await screen.findByRole("heading", { level: 3, name: "Realtime report" })
        ).toBeTruthy();
        expect(harness.transport.calls).toHaveLength(2);
    });

    test("retains validated summaries when a realtime refresh fails", async () => {
        const rawFailure = new TypeError("private report transport detail");
        const harness = renderSection([reportPage([initialReport]), rawFailure]);
        expect(
            await screen.findByRole("heading", { level: 3, name: "Initial report" })
        ).toBeTruthy();

        await emitReportChange(harness.realtimeClient, updatedReport);
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", { level: 3, name: "Initial report" })
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();
    });

    test("recovers an initial safe error through the explicit retry", async () => {
        const rawFailure = new TypeError("private initial report failure");
        renderSection([rawFailure, reportPage([initialReport])]);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Reports overview unavailable",
            })
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() =>
            expect(
                screen.getByRole("heading", { level: 3, name: "Initial report" })
            ).toBeTruthy()
        );
    });
});
