import { describe, expect, test } from "bun:test";

import type { TRPCRequestOptions } from "@trpc/client";

import type { IncidentSummary, ReportSummary } from "../../contracts/monitoring.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import {
    incidentListQueryOptions,
    reportListQueryOptions,
    reportOverviewQueryOptions,
    uniqueMonitoringRows,
} from "./monitoringQueries.ts";

const reportId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const incidentId = "019fd984-63e8-7404-a7da-80c6f243794f";
const timestampMs = 1_800_000_000_000;

const report = Object.freeze({
    id: reportId,
    kind: "heartbeat",
    occurredAtMs: timestampMs,
    source: "openclaw",
    sourceJobId: "ops-check",
    status: "warning",
    summary: "One warning remains.",
    title: "Operations heartbeat",
} satisfies ReportSummary);

const incident = Object.freeze({
    fingerprint: "a".repeat(64),
    firstSeenAtMs: timestampMs - 1000,
    generation: 1,
    id: incidentId,
    kind: "filesystem",
    lastSeenAtMs: timestampMs,
    monitorKey: "ops-check",
    occurrenceCount: 2,
    severity: "warning",
    state: "active",
    title: "Disk usage is elevated",
} satisfies IncidentSummary);

interface QueryCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class MonitoringQueryTransport implements DashboardTrpcTransport {
    readonly calls: QueryCall[] = [];
    readonly #outputs: Readonly<Record<string, readonly unknown[]>>;

    constructor(outputs: Readonly<Record<string, readonly unknown[]>>) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        const callsForPath = this.calls.filter((call) => call.path === path).length;
        this.calls.push({ input, path, signal: options?.signal });
        const output = this.#outputs[path]?.[callsForPath];
        return output === undefined
            ? Promise.reject(new TypeError(`Unexpected query: ${path}`))
            : Promise.resolve(output);
    }
}

describe("monitoring browser queries", () => {
    test("isolates the overview to one cancellable newest-report page", async () => {
        const transport = new MonitoringQueryTransport({
            "reports.list": [{ reports: [report] }],
        });
        const queryClient = createDashboardQueryClient();

        try {
            const client = createDashboardTrpcClient(transport);
            const overviewOptions = reportOverviewQueryOptions(client);
            const listOptions = reportListQueryOptions(client, undefined);
            await queryClient.fetchQuery(overviewOptions);

            expect(overviewOptions.queryKey).not.toEqual(listOptions.queryKey);
            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                { input: { limit: 50 }, path: "reports.list" },
            ]);
            expect(transport.calls[0]?.signal).toBeInstanceOf(AbortSignal);
        } finally {
            queryClient.clear();
        }
    });

    test("forwards report filters, continuation cursors, and cancellation signals", async () => {
        const transport = new MonitoringQueryTransport({
            "reports.list": [
                {
                    nextCursor: { id: report.id, occurredAtMs: report.occurredAtMs },
                    reports: [report],
                },
                { reports: [] },
            ],
        });
        const queryClient = createDashboardQueryClient();

        try {
            await queryClient.fetchInfiniteQuery({
                ...reportListQueryOptions(createDashboardTrpcClient(transport), {
                    kinds: ["heartbeat"],
                    sources: ["openclaw"],
                    statuses: ["warning"],
                }),
                pages: 2,
            });

            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                {
                    input: {
                        filters: {
                            kinds: ["heartbeat"],
                            sources: ["openclaw"],
                            statuses: ["warning"],
                        },
                        limit: 50,
                    },
                    path: "reports.list",
                },
                {
                    input: {
                        cursor: {
                            id: report.id,
                            occurredAtMs: report.occurredAtMs,
                        },
                        filters: {
                            kinds: ["heartbeat"],
                            sources: ["openclaw"],
                            statuses: ["warning"],
                        },
                        limit: 50,
                    },
                    path: "reports.list",
                },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("forwards incident filters, continuation cursors, and cancellation signals", async () => {
        const transport = new MonitoringQueryTransport({
            "incidents.list": [
                {
                    incidents: [incident],
                    nextCursor: {
                        id: incident.id,
                        lastSeenAtMs: incident.lastSeenAtMs,
                    },
                },
                { incidents: [] },
            ],
        });
        const queryClient = createDashboardQueryClient();

        try {
            await queryClient.fetchInfiniteQuery({
                ...incidentListQueryOptions(createDashboardTrpcClient(transport), {
                    kinds: ["filesystem"],
                    monitorKeys: ["ops-check"],
                    severities: ["warning"],
                    states: ["active"],
                }),
                pages: 2,
            });

            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                {
                    input: {
                        filters: {
                            kinds: ["filesystem"],
                            monitorKeys: ["ops-check"],
                            severities: ["warning"],
                            states: ["active"],
                        },
                        limit: 50,
                    },
                    path: "incidents.list",
                },
                {
                    input: {
                        cursor: {
                            id: incident.id,
                            lastSeenAtMs: incident.lastSeenAtMs,
                        },
                        filters: {
                            kinds: ["filesystem"],
                            monitorKeys: ["ops-check"],
                            severities: ["warning"],
                            states: ["active"],
                        },
                        limit: 50,
                    },
                    path: "incidents.list",
                },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("deduplicates overlapping pages without changing newest-page order", () => {
        expect(
            uniqueMonitoringRows([report, report, { ...report, id: incidentId }])
        ).toEqual([report, { ...report, id: incidentId }]);
    });
});
