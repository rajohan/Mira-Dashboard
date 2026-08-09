import { describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    ListLogSourcesOutput,
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
} from "../../contracts/logs.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { LogsBrowser } from "./LogsBrowser.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const observedAtMs = 1_800_000_000_000;
const authenticatedStatus = Object.freeze({
    session: {
        authenticatedAtMs: observedAtMs,
        authMethod: "password",
        createdAtMs: observedAtMs,
        expiresAtMs: observedAtMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: observedAtMs,
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
} satisfies AuthStatus);
const sourceCatalog = Object.freeze({
    observedAtMs,
    sources: [
        {
            availability: "missing",
            group: "host",
            id: "host.auth",
            label: "Host authentication",
        },
        {
            availability: "available",
            group: "dashboard",
            id: "dashboard.web.stderr",
            label: "Dashboard web stderr",
            modifiedAtMs: observedAtMs,
            sizeBytes: 2048,
        },
        {
            availability: "available",
            group: "openclaw",
            id: "openclaw.gateway",
            label: "OpenClaw gateway",
            modifiedAtMs: observedAtMs,
            sizeBytes: 4096,
        },
    ],
} satisfies ListLogSourcesOutput);
const maintenanceStatus = Object.freeze({
    observedAtMs,
    policies: [
        {
            id: "docker-managed",
            label: "Managed application and container logs",
            scope: "docker",
            state: "queueable",
        },
        {
            id: "host-alternatives",
            label: "Host alternatives log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-apport",
            label: "Host Apport log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-dpkg",
            label: "Host package log",
            scope: "host",
            state: "unavailable",
        },
        {
            id: "host-rsyslog",
            label: "Host system logs",
            scope: "host",
            state: "unavailable",
        },
    ],
} satisfies LogMaintenanceStatusOutput);

function snapshot(sourceId: string): LogSnapshotOutput {
    return {
        hasEarlier: false,
        lines: [],
        observedAtMs,
        revision: sourceId.startsWith("openclaw") ? "d".repeat(64) : "e".repeat(64),
        scannedBytes: 1024,
        sourceId,
    };
}

function renderBrowser(client: DashboardTrpcClient) {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { refetchOnWindowFocus: false, retry: false },
        },
    });
    queryClient.setQueryData(authStatusQueryKey, authenticatedStatus);
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <LogsBrowser />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    return { queryClient, view };
}

describe("LogsBrowser", () => {
    test("selects an available source and drives search, source, refresh, and maintenance requests", async () => {
        const query = jest.fn((name: string, input: unknown) => {
            switch (name) {
                case "logs.listSources": {
                    return Promise.resolve(sourceCatalog);
                }
                case "logs.maintenanceStatus": {
                    return Promise.resolve(maintenanceStatus);
                }
                case "logs.tail": {
                    const { sourceId } = input as { readonly sourceId: string };
                    return Promise.resolve(snapshot(sourceId));
                }
                case "logs.search": {
                    const { sourceId } = input as {
                        readonly sourceId: string;
                    };
                    return Promise.resolve(snapshot(sourceId));
                }
                default: {
                    return Promise.reject(new Error(`Unexpected query: ${name}`));
                }
            }
        });
        const mutation = jest.fn(() =>
            Promise.resolve({
                jobRunId: "log-maintenance-run",
                policyId: "docker-managed" as const,
                queued: true as const,
            })
        );
        const client = { mutation, query } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(client);

        try {
            expect(
                await screen.findByRole("heading", {
                    name: "Dashboard web stderr",
                })
            ).toBeVisible();
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.tail",
                    { limit: 200, sourceId: "dashboard.web.stderr" },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );

            const user = userEvent.setup();
            await user.type(
                screen.getByRole("searchbox", { name: "Search logs" }),
                "request-42"
            );
            await user.click(screen.getByRole("button", { name: "Search" }));
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.search",
                    {
                        limit: 200,
                        query: "request-42",
                        sourceId: "dashboard.web.stderr",
                    },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            expect(screen.getByText("Query: request-42")).toBeVisible();
            expect(
                screen.getByRole("button", { name: "Clear log search" })
            ).toBeVisible();

            await user.click(screen.getByRole("button", { name: /Log source/u }));
            await user.click(screen.getByRole("option", { name: /OpenClaw gateway/u }));
            await waitFor(() =>
                expect(query).toHaveBeenCalledWith(
                    "logs.tail",
                    { limit: 200, sourceId: "openclaw.gateway" },
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            expect(screen.getByRole("button", { name: /Log source/u })).toHaveTextContent(
                "OpenClaw gateway"
            );
            expect(screen.queryByRole("button", { name: "Clear log search" })).toBeNull();

            await user.click(screen.getByRole("button", { name: "Refresh" }));
            await waitFor(() => {
                expect(
                    query.mock.calls.filter(([name]) => name === "logs.listSources")
                ).toHaveLength(2);
                expect(
                    query.mock.calls.filter(([name]) => name === "logs.maintenanceStatus")
                ).toHaveLength(2);
            });

            await user.click(
                screen.getByRole("button", {
                    name: "Run Managed application and container logs",
                })
            );
            await user.click(screen.getByRole("button", { name: "Add to queue" }));
            await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
            expect(mutation).toHaveBeenCalledWith(
                "logs.requestMaintenance",
                {
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    policyId: "docker-managed",
                },
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
            expect(
                await screen.findByText(
                    /was added to the queue as job log-maintenance-run/u
                )
            ).toBeVisible();
            await waitFor(() =>
                expect(
                    query.mock.calls.filter(([name]) => name === "logs.maintenanceStatus")
                        .length
                ).toBeGreaterThanOrEqual(3)
            );
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("offers an explicit retry when the source catalog request fails", async () => {
        let sourceRequestCount = 0;
        const query = jest.fn((name: string) => {
            if (name === "logs.listSources") {
                sourceRequestCount += 1;
                return sourceRequestCount === 1
                    ? Promise.reject(new Error("private adapter failure"))
                    : Promise.resolve({ observedAtMs, sources: [] });
            }
            if (name === "logs.maintenanceStatus") {
                return Promise.resolve(maintenanceStatus);
            }
            return Promise.reject(new Error(`Unexpected query: ${name}`));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const { queryClient, view } = renderBrowser(client);

        try {
            expect(
                await screen.findByRole("heading", { name: "Log sources unavailable" })
            ).toBeVisible();
            expect(screen.queryByText("private adapter failure")).toBeNull();

            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "Try again" }));

            expect(
                await screen.findByRole("heading", { name: "No log sources" })
            ).toBeVisible();
            expect(sourceRequestCount).toBe(2);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });
});
