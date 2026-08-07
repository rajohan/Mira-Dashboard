import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";

import type { AgentStatus } from "../../contracts/agentModel.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
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
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";

const { render, screen } = await import("@testing-library/react");
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
    mainStatus: AgentStatus = {
        agentId: "main",
        currentTask: "Implement agents route",
        lastActivityAtMs: timestampMs,
        startedAtMs: timestampMs,
        state: "working",
    };

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, _input?: unknown): Promise<unknown> {
        switch (path) {
            case "auth.status": {
                return Promise.resolve(authenticatedStatus);
            }
            case "agents.getConfiguration": {
                return Promise.resolve({
                    agents: [
                        {
                            description: "Owns the operator conversation.",
                            displayName: "Mira",
                            id: "main",
                            role: "primary",
                        },
                        {
                            description: "Researches verified sources.",
                            displayName: "Researcher",
                            id: "researcher",
                            role: "specialist",
                        },
                    ],
                });
            }
            case "agents.listStatuses": {
                return Promise.resolve({
                    statuses: [this.mainStatus],
                });
            }
            case "agents.listTaskHistory": {
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

const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

afterEach(async () => {
    for (const view of mountedViews.splice(0)) view.unmount();
    await Promise.all(
        collectionRegistries.splice(0).map((collections) => collections.cleanup())
    );
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard agents route", () => {
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
        expect(await screen.findByRole("heading", { name: "Mira" })).toBeTruthy();
        expect(screen.getAllByText("Implement agents route")).toHaveLength(2);
        expect(screen.getByText("unavailable")).toBeTruthy();
        expect(screen.getByRole("table", { name: "Agent task history" })).toBeTruthy();
        expect(screen.getByRole("link", { name: /Agents/u })).toBeTruthy();

        transport.mainStatus = {
            agentId: "main",
            lastActivityAtMs: timestampMs + 1000,
            state: "idle",
        };
        await act(async () => {
            await collections.agents.statuses.utils.refetch();
        });
        expect(screen.getByText("idle")).toBeTruthy();
    });

    test("loads an older keyset page without replacing the newest history", async () => {
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
        const user = userEvent.setup();

        expect(await screen.findByText("Newest agent task")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Load older tasks" }));
        expect(await screen.findByText("Older agent task")).toBeTruthy();
        expect(screen.getByText("Newest agent task")).toBeTruthy();
    });
});
