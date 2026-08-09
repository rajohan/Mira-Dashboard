import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    CacheEntry,
    CacheEntryStatus,
    CacheStatusResult,
    RefreshCacheEntryInput,
} from "../../contracts/cache.ts";
import type { JobRunSummary } from "../../contracts/jobModel.ts";
import type { SystemMetrics } from "../../contracts/system.ts";
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
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = Date.now();
const hostRunId = "019fe000-0000-7000-8000-000000000001";
const refreshRunId = "019fe000-0000-7000-8000-000000000002";

const authenticatedStatus: AuthStatus = {
    session: {
        authenticatedAtMs: timestampMs,
        authMethod: "password",
        createdAtMs: timestampMs,
        expiresAtMs: timestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: timestampMs,
        userAgent: "Overview route test",
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
};

const systemMetrics = Object.freeze({
    cpu: {
        loadAverage: [2, 1, 0.5],
        loadPercent: 50,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 40 * 1024 ** 3,
        totalBytes: 100 * 1024 ** 3,
        usedBytes: 60 * 1024 ** 3,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 2 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        usedBytes: 6 * 1024 ** 3,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 12_300_000,
        state: "ready",
        uploadBitsPerSecond: 1_250_000,
    },
    sampledAtMs: timestampMs,
    uptimeSeconds: 183_600,
} as const satisfies SystemMetrics);

const hostEntry = Object.freeze({
    consecutiveFailures: 1,
    expiresAtMs: timestampMs + 60_000,
    failureCode: "provider/system-host-unavailable",
    failureMessage: "The latest host projection attempt failed safely.",
    freshness: "fresh",
    key: "system.host",
    lastAttemptAtMs: timestampMs,
    lastAttemptDurationMs: 250,
    lastAttemptNumber: 2,
    lastAttemptRunId: hostRunId,
    lastAttemptStatus: "failed",
    lastSuccessAtMs: timestampMs - 1000,
    manualRunAvailable: true,
    metadata: { internalMarker: "never-render-this-metadata" },
    payload: {
        architecture: "x64",
        disk: {
            freeBytes: 40 * 1024 ** 3,
            path: "/",
            totalBytes: 100 * 1024 ** 3,
        },
        hostname: "mira-vps",
        memory: {
            freeBytes: 2 * 1024 ** 3,
            totalBytes: 8 * 1024 ** 3,
        },
        platform: "linux",
        release: "6.8.0",
        uptimeSeconds: 183_600,
    },
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAtMs: timestampMs,
} as const satisfies CacheEntry);

const hostStatus = Object.freeze(
    (({ payload: _payload, ...status }) => status)(hostEntry)
) satisfies CacheEntryStatus;

const missingStatus = Object.freeze({
    consecutiveFailures: 1,
    failureCode: "provider/unavailable",
    failureMessage: "Provider unavailable.",
    freshness: "missing",
    key: "weather.spydeberg",
    lastAttemptAtMs: timestampMs - 500,
    lastAttemptDurationMs: 100,
    lastAttemptNumber: 1,
    lastAttemptRunId: "019fe000-0000-7000-8000-000000000003",
    lastAttemptStatus: "failed",
    manualRunAvailable: false,
    updatedAtMs: timestampMs - 500,
} as const satisfies CacheEntryStatus);

const cacheStatus = Object.freeze({
    entries: [hostStatus, missingStatus],
    generatedAtMs: timestampMs,
    totalCount: 129,
    truncated: true,
} as const satisfies CacheStatusResult);

const queuedRefresh = Object.freeze({
    actionKey: "cache.refresh.system-host",
    attemptCount: 0,
    attemptLimit: 3,
    availableAtMs: timestampMs,
    cancellationPolicy: "cooperative",
    displayName: "Refresh system host cache",
    eventCount: 1,
    id: refreshRunId,
    priority: 0,
    queuedAtMs: timestampMs,
    resourceClass: "light",
    resourceKeys: ["cache.system.host"],
    retrySafe: true,
    scheduledJobId: "cache.system-host",
    scheduledJobVersion: 1,
    state: "queued",
    stateVersion: 1,
    timeoutMs: 60_000,
    triggerType: "manual",
    updatedAtMs: timestampMs,
} as const satisfies JobRunSummary);

const failedRefresh = Object.freeze({
    ...queuedRefresh,
    attemptCount: 1,
    eventCount: 4,
    finishedAtMs: timestampMs + 1000,
    firstStartedAtMs: timestampMs + 100,
    lastAttemptStartedAtMs: timestampMs + 100,
    state: "failed",
    stateVersion: 3,
    terminalCode: "provider.failed",
    terminalMessage: "The provider attempt failed safely.",
    updatedAtMs: timestampMs + 1000,
} as const satisfies JobRunSummary);

const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

interface TransportCall {
    readonly input: unknown;
    readonly path: string;
}

interface OverviewTransportOptions {
    readonly cacheEntryOutputs?: readonly (CacheEntry | Error)[];
    readonly cacheStatusOutputs?: readonly (CacheStatusResult | Error)[];
    readonly refreshOutputs?: readonly (JobRunSummary | Error)[];
    readonly systemMetricsOutputs?: readonly (SystemMetrics | Error)[];
}

function transportOutput(
    outputs: readonly unknown[],
    index: number,
    path: string
): Promise<unknown> {
    const output = outputs[Math.min(index, outputs.length - 1)];
    if (output === undefined) {
        return Promise.reject(new TypeError(`Unexpected transport output: ${path}`));
    }
    return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
}

class OverviewTransport implements DashboardTrpcTransport {
    readonly #cacheEntryOutputs: readonly (CacheEntry | Error)[];
    readonly #cacheStatusOutputs: readonly (CacheStatusResult | Error)[];
    readonly #refreshOutputs: readonly (JobRunSummary | Error)[];
    readonly #systemMetricsOutputs: readonly (SystemMetrics | Error)[];
    readonly mutationCalls: TransportCall[] = [];
    readonly queryCalls: TransportCall[] = [];

    constructor(options: OverviewTransportOptions = {}) {
        this.#cacheEntryOutputs = options.cacheEntryOutputs ?? [hostEntry];
        this.#cacheStatusOutputs = options.cacheStatusOutputs ?? [cacheStatus];
        this.#refreshOutputs = options.refreshOutputs ?? [queuedRefresh];
        this.#systemMetricsOutputs = options.systemMetricsOutputs ?? [systemMetrics];
    }

    mutation(path: string, input?: unknown): Promise<unknown> {
        const callIndex = this.mutationCalls.filter((call) => call.path === path).length;
        this.mutationCalls.push({ input, path });
        if (path === "cache.refreshEntry") {
            return transportOutput(this.#refreshOutputs, callIndex, path);
        }
        if (path === "auth.touch") {
            return Promise.resolve({ lastSeenAtMs: timestampMs });
        }
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const callIndex = this.queryCalls.filter((call) => call.path === path).length;
        this.queryCalls.push({ input, path });
        switch (path) {
            case "auth.status": {
                return Promise.resolve(authenticatedStatus);
            }
            case "cache.getEntry": {
                return transportOutput(this.#cacheEntryOutputs, callIndex, path);
            }
            case "cache.getStatus": {
                return transportOutput(this.#cacheStatusOutputs, callIndex, path);
            }
            case "notifications.list": {
                return Promise.resolve(emptyNotificationListResult);
            }
            case "system.metrics": {
                return transportOutput(this.#systemMetricsOutputs, callIndex, path);
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
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

function renderOverview(transport: OverviewTransport) {
    const queryClient = createDashboardQueryClient();
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
                    createMemoryHistory({ initialEntries: ["/"] })
                )}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        )
    );
    return { queryClient, user: userEvent.setup() };
}

describe("Dashboard operational overview foundation", () => {
    test("loads bounded status before exact payload and queues refresh as a job", async () => {
        const transport = new OverviewTransport();
        const { user } = renderOverview(transport);

        expect(
            await screen.findByRole("heading", { level: 1, name: "Mira Dashboard" })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", { level: 2, name: "System metrics" })
        ).toBeTruthy();
        const cpuHeading = screen.getByRole("heading", { level: 3, name: "CPU" });
        const cpuCard = cpuHeading.closest("section");
        expect(cpuCard).toBeTruthy();
        expect(within(cpuCard as HTMLElement).getByText("50%")).toBeTruthy();
        expect(screen.getByText("12.3 Mbit/s")).toBeTruthy();
        expect(screen.queryByText("mira-vps")).toBeNull();
        expect(await screen.findByText("Showing 2 of 129")).toBeTruthy();
        expect(
            transport.queryCalls.filter(({ path }) => path === "cache.getEntry")
        ).toHaveLength(0);
        expect(screen.getAllByText("fresh").length).toBeGreaterThan(0);
        expect(screen.getAllByText("failed").length).toBeGreaterThan(0);

        await user.click(screen.getByRole("button", { name: "system.host" }));
        expect(
            await screen.findByRole("heading", { level: 3, name: "mira-vps" })
        ).toBeTruthy();
        expect(screen.getByText("75% used · 2.0 GiB free")).toBeTruthy();
        expect(screen.queryByText("never-render-this-metadata")).toBeNull();
        await waitFor(() =>
            expect(
                transport.queryCalls.filter(({ path }) => path === "cache.getEntry")
            ).toHaveLength(1)
        );

        await user.click(screen.getByRole("button", { name: "Queue refresh" }));
        await waitFor(() =>
            expect(
                transport.mutationCalls.filter(
                    ({ path }) => path === "cache.refreshEntry"
                )
            ).toHaveLength(1)
        );
        const refreshInput = transport.mutationCalls.find(
            ({ path }) => path === "cache.refreshEntry"
        )?.input as RefreshCacheEntryInput;
        expect(refreshInput.key).toBe("system.host");
        expect(refreshInput.idempotencyKey).toMatch(/^[0-9a-f]{32}$/u);
        expect(
            await screen.findByText(
                "Refresh queued. Cache data changes only after the worker commits the provider attempt."
            )
        ).toBeTruthy();
        const queuedRunLink = screen.getByRole("link", { name: "Open refresh run" });
        expect(queuedRunLink.getAttribute("href")).toContain(refreshRunId);
    });

    test("marks a recent last-known-good metric sample without hiding cache data", async () => {
        const transport = new OverviewTransport({
            systemMetricsOutputs: [{ ...systemMetrics, freshness: "stale" }],
        });
        renderOverview(transport);

        expect(
            await screen.findByText(
                "The latest collection failed. Showing a last-known-good sample no more than 30 seconds old."
            )
        ).toBeTruthy();
        expect(screen.getByText("stale")).toBeTruthy();
        expect(await screen.findByText("Showing 2 of 129")).toBeTruthy();
    });

    test("does not present an empty truncated snapshot as a complete inventory", async () => {
        const transport = new OverviewTransport({
            cacheStatusOutputs: [
                {
                    entries: [],
                    generatedAtMs: timestampMs,
                    totalCount: 1,
                    truncated: true,
                },
            ],
        });
        renderOverview(transport);

        expect(await screen.findByText("Showing 0 of 1")).toBeTruthy();
        expect(
            screen.getByRole("heading", {
                level: 3,
                name: "Cache snapshot incomplete",
            })
        ).toBeTruthy();
        expect(screen.queryByText("No cache attempts yet")).toBeNull();
        expect(screen.queryByText("Select a cache entry")).toBeNull();
    });

    test("reuses an ambiguous refresh key and presents a terminal replay accurately", async () => {
        const rawFailure = new TypeError("never render this refresh transport detail");
        const transport = new OverviewTransport({
            refreshOutputs: [rawFailure, failedRefresh],
        });
        const { user } = renderOverview(transport);

        await screen.findByText("Showing 2 of 129");
        await user.click(screen.getByRole("button", { name: "system.host" }));
        await screen.findByRole("heading", { level: 3, name: "mira-vps" });
        await user.click(screen.getByRole("button", { name: "Queue refresh" }));
        expect(
            await screen.findByText(
                "The cache request could not be completed. Try again."
            )
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await user.click(screen.getByRole("button", { name: "Retry refresh request" }));
        expect(
            await screen.findByText(
                "Refresh run failed. Open the run for reviewed details."
            )
        ).toBeTruthy();
        expect(screen.queryByText(/Refresh queued/u)).toBeNull();
        const refreshInputs = transport.mutationCalls
            .filter(({ path }) => path === "cache.refreshEntry")
            .map(({ input }) => input as RefreshCacheEntryInput);
        expect(refreshInputs).toHaveLength(2);
        expect(refreshInputs[1]?.idempotencyKey).toBe(refreshInputs[0]?.idempotencyKey);
        expect(
            screen.getByRole("link", { name: "Open refresh run" }).getAttribute("href")
        ).toContain(refreshRunId);
    });

    test("clears accepted refresh feedback after the exact cache attempt advances", async () => {
        const completedEntry = {
            ...hostEntry,
            lastAttemptRunId: refreshRunId,
        } satisfies CacheEntry;
        const transport = new OverviewTransport({
            cacheEntryOutputs: [hostEntry, completedEntry],
        });
        const { user } = renderOverview(transport);

        await screen.findByText("Showing 2 of 129");
        await user.click(screen.getByRole("button", { name: "system.host" }));
        await screen.findByRole("heading", { level: 3, name: "mira-vps" });
        await user.click(screen.getByRole("button", { name: "Queue refresh" }));
        await waitFor(() =>
            expect(
                transport.queryCalls.filter(({ path }) => path === "cache.getEntry")
            ).toHaveLength(2)
        );
        await waitFor(() =>
            expect(screen.queryByRole("link", { name: "Open refresh run" })).toBeNull()
        );
        expect(
            screen.queryByText(
                "Refresh queued. Cache data changes only after the worker commits the provider attempt."
            )
        ).toBeNull();
    });
});
