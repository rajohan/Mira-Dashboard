import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    IncidentRecord,
    IncidentSummary,
    ReportDetail,
    ReportSummary,
} from "../../contracts/monitoring.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import { createDashboardBrowserCollections } from "../data/dashboardCollections.ts";
import type { DashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const reportId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
const secondReportId = "019fd975-54a2-74dd-a64b-d4186f8d8828";
const incidentId = "019fd984-63e8-7404-a7da-80c6f243794f";
const secondIncidentId = "019fd985-63e8-7404-a7da-80c6f243794f";
const timestampMs = 1_800_000_000_000;

function report(
    id: string,
    title: string,
    occurredAtMs: number,
    bodyMarkdown = "# Operations\n\nAll monitored systems responded."
): ReportDetail {
    return {
        bodyMarkdown,
        id,
        kind: "heartbeat",
        metadata: { owner: "mira" },
        occurredAtMs,
        source: "openclaw",
        sourceJobId: "ops-check",
        status: "warning",
        summary: "One warning remains.",
        title,
    };
}

function incident(id: string, title: string, lastSeenAtMs: number): IncidentRecord {
    return {
        details: { path: "/srv/dashboard" },
        fingerprint: id === incidentId ? "a".repeat(64) : "b".repeat(64),
        firstSeenAtMs: lastSeenAtMs - 1000,
        generation: 1,
        id,
        kind: "filesystem",
        lastSeenAtMs,
        monitorKey: "ops-check",
        occurrenceCount: 2,
        severity: "warning",
        state: "active",
        title,
    };
}

function reportSummary({
    bodyMarkdown: _bodyMarkdown,
    metadata: _metadata,
    ...summary
}: ReportDetail): ReportSummary {
    return summary;
}

function incidentSummary({
    details: _details,
    ...summary
}: IncidentRecord): IncidentSummary {
    return summary;
}

function authenticatedStatus(): AuthStatus {
    const now = Date.now();
    return {
        session: {
            authenticatedAtMs: now,
            authMethod: "password",
            createdAtMs: now,
            expiresAtMs: now + 86_400_000,
            id: "a".repeat(32),
            isCurrent: true,
            lastSeenAtMs: now,
            userAgent: "Monitoring browser test",
        },
        state: "authenticated",
        user: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            username: "operator",
        },
    };
}

function requestedId(input: unknown): string | undefined {
    return typeof input === "object" &&
        input !== null &&
        "id" in input &&
        typeof input.id === "string"
        ? input.id
        : undefined;
}

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
}

class MonitoringTrpcError extends Error {
    readonly data: { readonly code: "NOT_FOUND" | "PRECONDITION_FAILED" };

    constructor(code: "NOT_FOUND" | "PRECONDITION_FAILED") {
        super("Synthetic monitoring route failure");
        this.data = { code };
    }
}

class MonitoringRouteTransport implements DashboardTrpcTransport {
    authStatus: AuthStatus = authenticatedStatus();
    readonly calls: TransportCall[] = [];
    deleteFailureCode: "NOT_FOUND" | "PRECONDITION_FAILED" | undefined;
    failReportListAfterDelete = false;
    incidentListFailuresRemaining = 0;
    reportListFailuresRemaining = 0;
    reportPages: readonly (readonly ReportSummary[])[] | undefined;
    reports = [
        report(reportId, "Primary heartbeat", timestampMs),
        report(secondReportId, "Secondary heartbeat", timestampMs - 1000),
    ];
    reportListIds = [reportId, secondReportId];
    incidents = [
        incident(incidentId, "Primary disk warning", timestampMs),
        incident(secondIncidentId, "Secondary disk warning", timestampMs - 1000),
    ];
    incidentListIds = [incidentId, secondIncidentId];

    mutation(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path });
        if (path !== "reports.delete") {
            return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
        }
        if (this.deleteFailureCode !== undefined) {
            return Promise.reject(new MonitoringTrpcError(this.deleteFailureCode));
        }
        const id = requestedId(input);
        if (id === undefined) return Promise.reject(new TypeError("Missing report id"));
        this.reports = this.reports.filter((candidate) => candidate.id !== id);
        this.reportListIds = this.reportListIds.filter(
            (candidateId) => candidateId !== id
        );
        if (this.failReportListAfterDelete) this.reportListFailuresRemaining = 1;
        return Promise.resolve({ deletedAtMs: Date.now(), id });
    }

    query(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "query", path });
        switch (path) {
            case "auth.status": {
                return Promise.resolve(this.authStatus);
            }
            case "notifications.list": {
                return Promise.resolve(emptyNotificationListResult);
            }
            case "reports.list": {
                if (this.reportListFailuresRemaining > 0) {
                    this.reportListFailuresRemaining -= 1;
                    return Promise.reject(new TypeError("Report list unavailable"));
                }
                if (this.reportPages !== undefined) {
                    const hasCursor =
                        typeof input === "object" && input !== null && "cursor" in input;
                    const reports = this.reportPages[hasCursor ? 1 : 0] ?? [];
                    const last = reports.at(-1);
                    return Promise.resolve({
                        ...(!hasCursor &&
                        this.reportPages.length > 1 &&
                        last !== undefined
                            ? {
                                  nextCursor: {
                                      id: last.id,
                                      occurredAtMs: last.occurredAtMs,
                                  },
                              }
                            : {}),
                        reports,
                    });
                }
                return Promise.resolve({
                    reports: this.reportListIds.flatMap((id) => {
                        const detail = this.reports.find(
                            (candidate) => candidate.id === id
                        );
                        return detail === undefined ? [] : [reportSummary(detail)];
                    }),
                });
            }
            case "reports.get": {
                const id = requestedId(input);
                const detail = this.reports.find((candidate) => candidate.id === id);
                return detail === undefined
                    ? Promise.reject(new MonitoringTrpcError("NOT_FOUND"))
                    : Promise.resolve(detail);
            }
            case "incidents.list": {
                if (this.incidentListFailuresRemaining > 0) {
                    this.incidentListFailuresRemaining -= 1;
                    return Promise.reject(new TypeError("Incident list unavailable"));
                }
                return Promise.resolve({
                    incidents: this.incidentListIds.flatMap((id) => {
                        const detail = this.incidents.find(
                            (candidate) => candidate.id === id
                        );
                        return detail === undefined ? [] : [incidentSummary(detail)];
                    }),
                });
            }
            case "incidents.get": {
                const id = requestedId(input);
                const detail = this.incidents.find((candidate) => candidate.id === id);
                return detail === undefined
                    ? Promise.reject(new MonitoringTrpcError("NOT_FOUND"))
                    : Promise.resolve(detail);
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
    }
}

const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});
const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

function renderMonitoringRoute(path: string, transport: MonitoringRouteTransport) {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: {
            ...queryClient.getDefaultOptions().queries,
            retry: false,
        },
    });
    queryClients.push(queryClient);
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    collectionRegistries.push(collections);
    mountedViews.push(
        render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={createDashboardRouter(
                    createMemoryHistory({ initialEntries: [path] })
                )}
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

describe("monitoring browser routes", () => {
    test("auto-updates reports without routine refresh and retains initial retry", async () => {
        const transport = new MonitoringRouteTransport();
        transport.reportListFailuresRemaining = 1;
        renderMonitoringRoute("/reports", transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", { level: 1, name: "Reports" })
        ).toBeTruthy();
        expect(
            screen.getByText(/Updates automatically from report events/u)
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "Browse incidents" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        expect(await screen.findByText("Reports unavailable")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Primary heartbeat")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    });

    test("auto-updates incidents without routine refresh and retains initial retry", async () => {
        const transport = new MonitoringRouteTransport();
        transport.incidentListFailuresRemaining = 1;
        renderMonitoringRoute("/incidents", transport);
        const user = userEvent.setup();

        expect(
            await screen.findByRole("heading", { level: 1, name: "Incidents" })
        ).toBeTruthy();
        expect(
            screen.getByText(/Updates automatically from incident events/u)
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "Browse reports" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        expect(await screen.findByText("Incidents unavailable")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Primary disk warning")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    });

    test("loads an exact report deep link independently and keeps Markdown raw HTML inert", async () => {
        const transport = new MonitoringRouteTransport();
        transport.reportListIds = [reportId];
        transport.reportListFailuresRemaining = 1;
        transport.reports[1] = report(
            secondReportId,
            "Direct report",
            timestampMs - 1000,
            "# Direct report\n\n<script>window.rawHtmlExecuted = true</script>"
        );
        renderMonitoringRoute(`/reports?reportId=${secondReportId}`, transport);

        expect(
            await screen.findByRole("heading", { level: 2, name: "Direct report" })
        ).toBeTruthy();
        expect(await screen.findByText("Reports unavailable")).toBeTruthy();
        expect(document.querySelector("script")).toBeNull();
        expect(transport.calls.find(({ path }) => path === "reports.get")?.input).toEqual(
            { id: secondReportId }
        );
    });

    test("drops an invalid report search value without issuing a detail query", async () => {
        const transport = new MonitoringRouteTransport();
        renderMonitoringRoute("/reports?reportId=not-a-uuid", transport);

        expect(await screen.findByText("No report selected")).toBeTruthy();
        expect(await screen.findByText("Primary heartbeat")).toBeTruthy();
        expect(transport.calls.some(({ path }) => path === "reports.get")).toBeFalse();
    });

    test("applies report text filters as one query transition", async () => {
        const transport = new MonitoringRouteTransport();
        renderMonitoringRoute("/reports", transport);
        const user = userEvent.setup();

        await screen.findByText("Primary heartbeat");
        await user.type(screen.getByLabelText("Kind"), "heartbeat");
        await user.type(screen.getByLabelText("Source"), "openclaw");
        expect(
            transport.calls.filter(({ path }) => path === "reports.list")
        ).toHaveLength(1);

        await user.click(screen.getByRole("button", { name: "Apply" }));
        await waitFor(() =>
            expect(
                transport.calls.filter(({ path }) => path === "reports.list")
            ).toHaveLength(2)
        );
        expect(
            transport.calls.findLast(({ path }) => path === "reports.list")?.input
        ).toEqual({
            filters: {
                kinds: ["heartbeat"],
                sources: ["openclaw"],
            },
            limit: 50,
        });
    });

    test("loads an overlapping report page without rendering duplicate identities", async () => {
        const transport = new MonitoringRouteTransport();
        const first = reportSummary(transport.reports[0]!);
        const second = reportSummary(transport.reports[1]!);
        transport.reportPages = [[first], [first, second]];
        renderMonitoringRoute("/reports", transport);
        const user = userEvent.setup();

        await screen.findByText("Primary heartbeat");
        await user.click(screen.getByRole("button", { name: "Load older reports" }));
        expect(await screen.findByText("Secondary heartbeat")).toBeTruthy();
        expect(screen.getAllByText("Primary heartbeat")).toHaveLength(1);
        expect(
            transport.calls.filter(({ path }) => path === "reports.list")
        ).toHaveLength(2);
    });

    test("removes a deleted report from cached lists when the refresh fails", async () => {
        const transport = new MonitoringRouteTransport();
        transport.failReportListAfterDelete = true;
        const queryClient = renderMonitoringRoute(
            `/reports?reportId=${reportId}`,
            transport
        );
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 2, name: "Primary heartbeat" });
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete report" }));
        await waitFor(() => {
            expect(queryClient.isFetching()).toBe(0);
            expect(queryClient.isMutating()).toBe(0);
        });
        expect(screen.queryByText("Primary heartbeat")).toBeNull();
        expect(screen.getByText("Secondary heartbeat")).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toContain(
            "The request could not be completed"
        );
    });

    test("presents a bounded-delete precondition and clears it for the next report", async () => {
        const transport = new MonitoringRouteTransport();
        transport.deleteFailureCode = "PRECONDITION_FAILED";
        renderMonitoringRoute(`/reports?reportId=${reportId}`, transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 2, name: "Primary heartbeat" });
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete report" }));
        expect(
            await screen.findByText(/too many linked notifications to delete safely/u)
        ).toBeTruthy();

        await user.click(screen.getByRole("button", { name: /Secondary heartbeat/u }));
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Secondary heartbeat",
            })
        ).toBeTruthy();
        expect(
            screen.queryByText(/too many linked notifications to delete safely/u)
        ).toBeNull();
    });

    test("presents a missing report without leaking a server message", async () => {
        const transport = new MonitoringRouteTransport();
        transport.deleteFailureCode = "NOT_FOUND";
        renderMonitoringRoute(`/reports?reportId=${reportId}`, transport);
        const user = userEvent.setup();

        await screen.findByRole("heading", { level: 2, name: "Primary heartbeat" });
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete report" }));
        expect(await screen.findByText(/This report no longer exists/u)).toBeTruthy();
    });

    test("renders the hidden incident table and an exact detail outside its first page", async () => {
        const transport = new MonitoringRouteTransport();
        transport.incidentListIds = [incidentId];
        renderMonitoringRoute(`/incidents?incidentId=${secondIncidentId}`, transport);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Secondary disk warning",
            })
        ).toBeTruthy();
        expect(screen.getByRole("table", { name: "Incidents" })).toBeTruthy();
        const navigation = screen.getByRole("navigation", {
            name: "Main navigation",
        });
        expect(within(navigation).queryByRole("link", { name: "Incidents" })).toBeNull();
        expect(screen.getByText("Incidents", { selector: "header p" })).toBeTruthy();
        expect(
            transport.calls.find(({ path }) => path === "incidents.get")?.input
        ).toEqual({ id: secondIncidentId });

        const user = userEvent.setup();
        await user.click(
            screen.getByRole("button", {
                name: "Primary disk warning; ops-check; generation 1",
            })
        );
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Primary disk warning",
            })
        ).toBeTruthy();
    });

    test("loads an exact incident deep link independently of list availability", async () => {
        const transport = new MonitoringRouteTransport();
        transport.incidentListFailuresRemaining = 1;
        renderMonitoringRoute(`/incidents?incidentId=${secondIncidentId}`, transport);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Secondary disk warning",
            })
        ).toBeTruthy();
        expect(await screen.findByText("Incidents unavailable")).toBeTruthy();
        expect(
            transport.calls.find(({ path }) => path === "incidents.get")?.input
        ).toEqual({ id: secondIncidentId });
    });

    test("drops an invalid incident search value without issuing a detail query", async () => {
        const transport = new MonitoringRouteTransport();
        renderMonitoringRoute("/incidents?incidentId=not-a-uuid", transport);

        expect(await screen.findByText("No incident selected")).toBeTruthy();
        expect(await screen.findByText("Primary disk warning")).toBeTruthy();
        expect(transport.calls.some(({ path }) => path === "incidents.get")).toBeFalse();
    });

    test("keeps monitoring procedures behind the authenticated route boundary", async () => {
        const transport = new MonitoringRouteTransport();
        transport.authStatus = { state: "anonymous" };
        renderMonitoringRoute("/reports", transport);

        expect(
            await screen.findByRole("heading", { level: 1, name: "Sign in" })
        ).toBeTruthy();
        expect(
            transport.calls.some(
                ({ path }) => path === "reports.list" || path === "reports.get"
            )
        ).toBeFalse();
    });
});
