import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";

import type { AgentStatusProjection } from "../../contracts/agentModel.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
import { liveHistoryArchiveQueryKey } from "../api/liveHistory.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import { resetAuthenticatedBrowserCache } from "../auth/authQueries.ts";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { captureExpectedConsoleErrors } from "../test/expectedConsoleError.ts";
import { installIntersectionObserverHarness } from "../test/intersectionObserverTest.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import {
    agentConfigurationQueryKey,
    agentQueryKey,
    agentStatusesQueryKey,
    refreshAgentQueries,
} from "./agentQueries.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const authenticatedStatus: AuthStatus = {
    session: {
        authenticatedAtMs: timestampMs,
        authMethod: "password",
        createdAtMs: timestampMs,
        expiresAtMs: timestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: timestampMs,
        userAgent: "Agent browser test",
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
};
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

class AgentTransport implements DashboardTrpcTransport {
    configurationQueryCount = 0;
    configurationQueryResponse: Promise<unknown> | undefined;
    mainStatus: AgentStatusProjection = {
        agentId: "main",
        currentTask: "Implement agents route",
        freshness: "fresh",
        gatewayAvailability: "active",
        hasActiveRun: true,
        lastActivityAtMs: timestampMs,
        lastSeenAtMs: timestampMs,
        observedAtMs: timestampMs,
        providerModel: "openai/gpt-5.6-sol",
        sessionKey: "agent:main:main",
        startedAtMs: timestampMs,
        state: "working",
    };
    historyQueryCount = 0;
    statusQueryCount = 0;
    statusQueryResponse: Promise<unknown> | undefined;

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, _input?: unknown): Promise<unknown> {
        switch (path) {
            case "auth.status": {
                return Promise.resolve(authenticatedStatus);
            }
            case "agents.getConfiguration": {
                this.configurationQueryCount += 1;
                if (this.configurationQueryResponse !== undefined) {
                    return this.configurationQueryResponse;
                }
                return Promise.resolve({
                    agents: [
                        {
                            description: "Researches verified sources.",
                            displayName: "Researcher",
                            id: "researcher",
                            role: "specialist",
                        },
                        {
                            description: "Owns the operator conversation.",
                            displayName: "Mira",
                            id: "main",
                            role: "primary",
                        },
                    ],
                });
            }
            case "agents.listStatuses": {
                this.statusQueryCount += 1;
                if (this.statusQueryResponse !== undefined) {
                    return this.statusQueryResponse;
                }
                return Promise.resolve({
                    statuses: [
                        this.mainStatus,
                        {
                            agentId: "researcher",
                            freshness: "unavailable",
                            gatewayAvailability: "disconnected",
                            lastActivityAtMs: timestampMs - 60_000,
                            state: "idle",
                        },
                    ],
                });
            }
            case "agents.listTaskHistory": {
                this.historyQueryCount += 1;
                return Promise.resolve({
                    runs: [
                        {
                            agentId: "main",
                            id: "019fdc00-0000-7000-8000-000000000001",
                            lastActivityAtMs: timestampMs,
                            startedAtMs: timestampMs,
                            status: "active",
                            task: "Implement agents route",
                        },
                    ],
                });
            }
            case "notifications.list": {
                return Promise.resolve({
                    notifications: [],
                    readCount: 0,
                    unreadCount: 0,
                });
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
    }
}

class PaginatedAgentTransport extends AgentTransport {
    override query(path: string, input?: unknown): Promise<unknown> {
        if (path !== "agents.listTaskHistory") return super.query(path, input);
        const hasCursor =
            typeof input === "object" &&
            input !== null &&
            "cursor" in input &&
            input.cursor !== undefined;
        if (hasCursor) {
            return Promise.resolve({
                runs: [
                    {
                        agentId: "main",
                        completedAtMs: timestampMs,
                        id: "019fdb00-0000-7000-8000-000000000001",
                        lastActivityAtMs: timestampMs,
                        startedAtMs: timestampMs - 1000,
                        status: "completed",
                        task: "Older agent task",
                    },
                ],
            });
        }
        return Promise.resolve({
            nextCursor: {
                id: "019fdc00-0000-7000-8000-000000000002",
                startedAtMs: timestampMs,
            },
            runs: [
                {
                    agentId: "main",
                    id: "019fdc00-0000-7000-8000-000000000002",
                    lastActivityAtMs: timestampMs,
                    startedAtMs: timestampMs,
                    status: "active",
                    task: "Newest agent task",
                },
            ],
        });
    }
}

class PartialAgentHistoryTransport extends AgentTransport {
    readonly historyFailure = new TypeError("redacted archive failure");

    override query(path: string, input?: unknown): Promise<unknown> {
        if (path !== "agents.listTaskHistory") return super.query(path, input);
        this.historyQueryCount += 1;
        if (this.historyQueryCount === 1) {
            return Promise.reject(this.historyFailure);
        }
        return Promise.resolve({
            runs: [
                {
                    agentId: "main",
                    id: "019fdc00-0000-7000-8000-000000000003",
                    lastActivityAtMs: timestampMs,
                    startedAtMs: timestampMs,
                    status: "active",
                    task: "Live-head agent task",
                },
            ],
        });
    }
}

const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

async function expectAgentShellReady(): Promise<void> {
    expect(await screen.findByRole("heading", { name: "Mira" })).toBeTruthy();
    expect(
        await screen.findByRole("button", { name: "Notifications, none unread" })
    ).toBeTruthy();
}

afterEach(async () => {
    for (const view of mountedViews.splice(0)) view.unmount();
    await Promise.all(
        collectionRegistries.splice(0).map((collections) => collections.cleanup())
    );
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

function renderAgentRoute(
    transport: AgentTransport,
    queryClient: ReturnType<typeof createDashboardQueryClient>
): void {
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
                    createMemoryHistory({ initialEntries: ["/agents"] })
                )}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        )
    );
}

describe("Dashboard agents route", () => {
    test("renders the live history head when the archive fails", async () => {
        const transport = new PartialAgentHistoryTransport();
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(
            liveHistoryArchiveQueryKey([...agentQueryKey, "history"]),
            { retry: false }
        );
        renderAgentRoute(transport, queryClient);
        await expectAgentShellReady();
        expect(await screen.findByText("Live-head agent task")).toBeTruthy();
        expect(screen.getByRole("alert")).toBeTruthy();
    });

    test("invalidates mutable archived agent runs", async () => {
        const queryClient = createDashboardQueryClient();
        const archiveKey = liveHistoryArchiveQueryKey([...agentQueryKey, "history"]);
        queryClient.setQueryData(archiveKey, { pages: [] });

        await refreshAgentQueries(queryClient);

        expect(queryClient.getQueryState(archiveKey)?.isInvalidated).toBeTrue();
    });

    test("recovers an initial configuration failure through explicit retry", async () => {
        const transport = new AgentTransport();
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(agentConfigurationQueryKey, { retry: false });
        const configurationRequest = Promise.withResolvers<unknown>();
        const configurationFailure = new TypeError(
            "redacted initial configuration failure"
        );
        transport.configurationQueryResponse = configurationRequest.promise;
        renderAgentRoute(transport, queryClient);

        const consoleErrors = captureExpectedConsoleErrors([configurationFailure]);
        try {
            await act(async () => {
                configurationRequest.reject(configurationFailure);
                await configurationRequest.promise.catch(() => {});
            });
            expect(await screen.findByRole("alert")).toBeTruthy();
            expect(screen.queryByText(/redacted initial configuration/u)).toBeNull();
            expect(screen.queryByRole("heading", { name: "Mira" })).toBeNull();

            transport.configurationQueryResponse = undefined;
            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "Try again" }));
            await expectAgentShellReady();
            consoleErrors.expectObserved();
        } finally {
            consoleErrors.restore();
        }
    });

    test("recovers an initial status failure through explicit retry", async () => {
        const transport = new AgentTransport();
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(agentStatusesQueryKey, { retry: false });
        const statusRequest = Promise.withResolvers<unknown>();
        const statusFailure = new TypeError("redacted initial status failure");
        transport.statusQueryResponse = statusRequest.promise;
        renderAgentRoute(transport, queryClient);

        const consoleErrors = captureExpectedConsoleErrors([statusFailure]);
        try {
            await act(async () => {
                statusRequest.reject(statusFailure);
                await statusRequest.promise.catch(() => {});
            });
            expect(await screen.findByRole("alert")).toBeTruthy();
            expect(screen.queryByText(/redacted initial status/u)).toBeNull();
            expect(screen.queryByRole("heading", { name: "Mira" })).toBeNull();

            transport.statusQueryResponse = undefined;
            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "Try again" }));
            await expectAgentShellReady();
            consoleErrors.expectObserved();
        } finally {
            consoleErrors.restore();
        }
    });

    test("renders reviewed roles, live status, and durable history", async () => {
        const transport = new AgentTransport();
        const queryClient = createDashboardQueryClient();
        queryClients.push(queryClient);
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/agents"] })
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

        expect(
            await screen.findByRole("heading", { level: 1, name: "Agents" })
        ).toBeTruthy();
        await expectAgentShellReady();
        expect(screen.getAllByText("Implement agents route")).toHaveLength(2);
        const activeAgentBadge = screen.getByLabelText("Agent activity: active");
        expect(activeAgentBadge.querySelector("svg")?.classList).toContain(
            "animate-spin"
        );
        const activeGatewayBadge = screen.getByLabelText(
            "Gateway session availability: active"
        );
        expect(activeGatewayBadge.querySelector("svg")?.classList).toContain(
            "animate-spin"
        );
        expect(
            screen.getByLabelText("Gateway session availability: disconnected")
        ).toBeTruthy();
        expect(screen.getByText("agent:main:main")).toBeTruthy();
        expect(screen.getByText("openai/gpt-5.6-sol")).toBeTruthy();
        expect(screen.queryByText(/not online status or health/u)).toBeNull();
        expect(
            screen.queryByText(/Updates automatically from agent and Gateway events/u)
        ).toBeNull();
        expect(screen.queryByText("No recorded task activity")).toBeNull();
        expect(screen.getByText(/^Last active /u)).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "Current status" })).toBeNull();
        expect(
            screen
                .getAllByRole("heading", { level: 3 })
                .map((heading) => heading.textContent)
        ).toEqual(["Mira", "Researcher"]);
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        expect(
            screen.getByRole("table", { name: "Agent task history" }).className
        ).toContain("grid-cols-2");
        expect(screen.getByRole("link", { name: /Agents/u })).toBeTruthy();

        transport.mainStatus = {
            agentId: "main",
            freshness: "stale",
            gatewayAvailability: "stale",
            hasActiveRun: true,
            lastActivityAtMs: timestampMs + 1000,
            lastSeenAtMs: timestampMs,
            observedAtMs: timestampMs,
            sessionKey: "agent:main:main",
            state: "idle",
        };
        await act(async () => {
            await collections.agents.statuses.utils.refetch();
        });
        expect(screen.getAllByLabelText("Agent activity: idle")).toHaveLength(2);
        expect(screen.getByLabelText("Gateway session availability: stale")).toBeTruthy();
        expect(
            screen
                .getAllByRole("heading", { level: 3 })
                .map((heading) => heading.textContent)
        ).toEqual(["Mira", "Researcher"]);
    });

    test("loads an older keyset page without replacing the newest history", async () => {
        const observer = installIntersectionObserverHarness();
        const queryClient = createDashboardQueryClient();
        queryClients.push(queryClient);
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/agents"] })
        );
        const trpcClient = createDashboardTrpcClient(new PaginatedAgentTransport());
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
        await expectAgentShellReady();
        expect(await screen.findByText("Newest agent task")).toBeTruthy();
        expect(
            screen.getByRole("columnheader", { name: "Started" }).querySelector("button")
        ).toBeNull();
        act(() => observer.intersectLatest());
        expect(await screen.findByText("Older agent task")).toBeTruthy();
        expect(screen.getByText("Newest agent task")).toBeTruthy();
        observer.restore();
    });

    test("recreates agent collections after the authenticated cache is reset", async () => {
        const transport = new AgentTransport();
        const queryClient = createDashboardQueryClient();
        queryClients.push(queryClient);
        const trpcClient = createDashboardTrpcClient(transport);
        const collections = createDashboardBrowserCollections(queryClient, trpcClient);
        collectionRegistries.push(collections);
        const firstView = render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={createDashboardRouter(
                    createMemoryHistory({ initialEntries: ["/agents"] })
                )}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        );
        mountedViews.push(firstView);

        await expectAgentShellReady();
        expect(transport.configurationQueryCount).toBe(1);
        expect(transport.statusQueryCount).toBe(1);
        firstView.unmount();
        mountedViews.splice(mountedViews.indexOf(firstView), 1);

        await act(async () => {
            await resetAuthenticatedBrowserCache(
                queryClient,
                collections,
                authenticatedStatus
            );
        });
        mountedViews.push(
            render(
                <DashboardBrowserApplication
                    collections={collections}
                    queryClient={queryClient}
                    realtimeClient={noOpDashboardRealtimeClient}
                    router={createDashboardRouter(
                        createMemoryHistory({ initialEntries: ["/agents"] })
                    )}
                    trpcClient={trpcClient}
                    webAuthnClient={unexpectedWebAuthnClient}
                />
            )
        );

        await expectAgentShellReady();
        await waitFor(() => {
            expect(transport.configurationQueryCount).toBe(2);
            expect(transport.statusQueryCount).toBe(2);
        });
        expect(screen.getAllByText("Implement agents route")).toHaveLength(2);
    });

    test("reports an automatic refresh failure and retains explicit recovery", async () => {
        const transport = new AgentTransport();
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(agentStatusesQueryKey, { retry: false });
        queryClients.push(queryClient);
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/agents"] })
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
        const user = userEvent.setup();
        const statusRefresh = Promise.withResolvers<unknown>();
        const statusFailure = new TypeError("redacted status failure");

        await expectAgentShellReady();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        transport.statusQueryResponse = statusRefresh.promise;
        let backgroundRefresh: Promise<unknown> | undefined;
        act(() => {
            backgroundRefresh = collections.agents.statuses.utils.refetch();
        });

        const consoleErrors = captureExpectedConsoleErrors([statusFailure]);
        try {
            await act(async () => {
                statusRefresh.reject(statusFailure);
                await statusRefresh.promise.catch(() => {});
                await backgroundRefresh?.catch(() => {});
            });
            expect(await screen.findByRole("alert")).toBeTruthy();
            expect(screen.getAllByText("Implement agents route")).toHaveLength(2);
            expect(screen.queryByText(/redacted status failure/u)).toBeNull();
            expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
            transport.statusQueryResponse = undefined;
            const historyQueriesBeforeRetry = transport.historyQueryCount;
            await user.click(screen.getByRole("button", { name: "Try again" }));
            await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
            await waitFor(() =>
                expect(transport.historyQueryCount).toBe(historyQueriesBeforeRetry + 2)
            );
            expect(screen.getAllByText("Implement agents route")).toHaveLength(2);
            consoleErrors.expectObserved();
        } finally {
            consoleErrors.restore();
        }
    });
});
