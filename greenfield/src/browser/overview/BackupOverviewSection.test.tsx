import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    BackupRequestOperationResult,
    KopiaBackupStatus,
    WalgBackupStatus,
} from "../../contracts/backups.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { parseJobsRouteSearch } from "../jobs/jobRouteSearch.ts";
import {
    BackupOverviewSection,
    BackupOverviewSectionView,
} from "./BackupOverviewSection.tsx";

const { fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");

const nowMs = 1_800_000_000_000;
const sourceRevision = "a".repeat(64);
const kopiaAttentionRunId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";
const walgAttentionRunId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b5";
const kopia = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 1,
        healthy: true,
        observedAtMs: nowMs,
        providerIdle: true,
        sourceRevision,
        sources: [
            {
                health: "current",
                id: "primary",
                latestCompletedAtMs: nowMs,
                snapshotCount: 1,
            },
        ],
        type: "kopia",
    },
    state: "fresh",
} as const satisfies KopiaBackupStatus);
const walg = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 1,
        healthy: true,
        latestCompletedAtMs: nowMs,
        observedAtMs: nowMs,
        providerIdle: true,
        sourceRevision,
        type: "walg",
    },
    state: "fresh",
} as const satisfies WalgBackupStatus);
const kopiaNeedsAttention = Object.freeze({
    ...kopia,
    activity: {
        finishedAtMs: nowMs,
        jobRunId: kopiaAttentionRunId,
        jobsUrl: `/jobs?runId=${kopiaAttentionRunId}`,
        queuedAtMs: nowMs - 2000,
        startedAtMs: nowMs - 1000,
        state: "needs-attention",
    },
} as const satisfies KopiaBackupStatus);
const walgNeedsAttention = Object.freeze({
    ...walg,
    activity: {
        finishedAtMs: nowMs,
        jobRunId: walgAttentionRunId,
        jobsUrl: `/jobs?runId=${walgAttentionRunId}`,
        queuedAtMs: nowMs - 2000,
        startedAtMs: nowMs - 1000,
        state: "needs-attention",
    },
} as const satisfies WalgBackupStatus);
const failedBusyWalg = Object.freeze({
    ...walg,
    activity: {
        finishedAtMs: nowMs,
        jobRunId: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
        jobsUrl: "/jobs?runId=019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
        queuedAtMs: nowMs,
        state: "failed",
    },
    payload: {
        ...walg.payload,
        providerIdle: false,
    },
} as const satisfies WalgBackupStatus);

const authenticatedStatus = Object.freeze({
    session: {
        authenticatedAtMs: nowMs,
        authMethod: "password",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: nowMs,
        userAgent: "Backup overview browser test",
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
} satisfies AuthStatus);

interface BackupTransportCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

const queuedResults = Object.freeze({
    "backups.clearKopiaAttention": Object.freeze({
        jobRunId: "019fe000-0000-7000-8000-000000000001",
        operation: "clear-attention",
        queued: true,
        type: "kopia",
    }),
    "backups.clearWalgAttention": Object.freeze({
        jobRunId: "019fe000-0000-7000-8000-000000000002",
        operation: "clear-attention",
        queued: true,
        type: "walg",
    }),
    "backups.runWalg": Object.freeze({
        jobRunId: "019fe000-0000-7000-8000-000000000004",
        operation: "run",
        queued: true,
        type: "walg",
    }),
} as const satisfies Readonly<Record<string, BackupRequestOperationResult>>);

class BackupTransport implements DashboardTrpcTransport {
    readonly mutationCalls: BackupTransportCall[] = [];
    readonly #kopiaStatus: KopiaBackupStatus;
    readonly #walgStatus: WalgBackupStatus;

    constructor(kopiaStatus: KopiaBackupStatus, walgStatus: WalgBackupStatus) {
        this.#kopiaStatus = kopiaStatus;
        this.#walgStatus = walgStatus;
    }

    mutation(
        path: string,
        input?: unknown,
        options?: { readonly signal?: AbortSignal }
    ): Promise<unknown> {
        this.mutationCalls.push({ input, path, signal: options?.signal });
        const result = queuedResults[path as keyof typeof queuedResults];
        return result === undefined
            ? Promise.reject(new TypeError(`Unexpected mutation: ${path}`))
            : Promise.resolve(result);
    }

    query(path: string): Promise<unknown> {
        if (path === "backups.getKopiaStatus") return Promise.resolve(this.#kopiaStatus);
        if (path === "backups.getWalgStatus") return Promise.resolve(this.#walgStatus);
        return Promise.reject(new TypeError(`Unexpected query: ${path}`));
    }
}

interface ConnectedHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly transport: BackupTransport;
    readonly view: ReturnType<typeof render>;
}

const connectedHarnesses: ConnectedHarness[] = [];

function createBackupOverviewRouter(component: () => ReactElement) {
    const rootRoute = createRootRoute();
    const overviewRoute = createRoute({
        component,
        getParentRoute: () => rootRoute,
        path: "/overview",
    });
    const jobsRoute = createRoute({
        component: () => null,
        getParentRoute: () => rootRoute,
        path: "/jobs",
        validateSearch: parseJobsRouteSearch,
    });
    return createRouter({
        history: createMemoryHistory({ initialEntries: ["/overview"] }),
        routeTree: rootRoute.addChildren([overviewRoute, jobsRoute]),
    });
}

function renderBackupOverviewView(element: ReactElement) {
    const router = createBackupOverviewRouter(() => element);
    return render(<RouterProvider router={router} />);
}

afterEach(() => {
    for (const { queryClient, view } of connectedHarnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
    globalThis.sessionStorage.clear();
});

function renderConnectedSection(
    kopiaStatus: KopiaBackupStatus,
    walgStatus: WalgBackupStatus
): ConnectedHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(authStatusQueryKey, authenticatedStatus);
    const transport = new BackupTransport(kopiaStatus, walgStatus);
    const client = createDashboardTrpcClient(transport);
    const router = createBackupOverviewRouter(BackupOverviewSection);
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <RouterProvider router={router} />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    const harness = { queryClient, transport, view };
    connectedHarnesses.push(harness);
    return harness;
}

describe("BackupOverviewSectionView", () => {
    test("keeps one healthy provider visible when the other query fails", async () => {
        renderBackupOverviewView(
            <BackupOverviewSectionView
                error="Kopia status failed."
                kopia={undefined}
                walg={walg}
            />
        );

        expect(await screen.findByText("Kopia status failed.")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Kopia" })).toBeTruthy();
        const walgCard = screen.getByLabelText("WAL-G backup");
        expect(within(walgCard).getByText("Fresh")).toBeTruthy();
        expect(
            within(walgCard).getByRole("button", { name: "Run backup" })
        ).toBeEnabled();
    });

    test("gates stale controls while preserving last-known-good data", async () => {
        renderBackupOverviewView(
            <BackupOverviewSectionView
                kopia={{
                    ...kopia,
                    staleSinceMs: nowMs,
                    state: "last-known-good",
                }}
                walg={walg}
            />
        );

        const kopiaCard = await screen.findByLabelText("Kopia backup");
        expect(within(kopiaCard).getByText("Last known good")).toBeTruthy();
        expect(within(kopiaCard).getByText("1", { selector: "strong" })).toBeTruthy();
        expect(
            within(kopiaCard).getByRole("button", { name: "Run backup" })
        ).toBeDisabled();
    });

    test("keeps a terminal provider failure visible while the provider is busy", async () => {
        renderBackupOverviewView(
            <BackupOverviewSectionView kopia={kopia} walg={failedBusyWalg} />
        );

        const walgCard = await screen.findByLabelText("WAL-G backup");
        expect(within(walgCard).getByText("Failed")).toBeTruthy();
        expect(within(walgCard).queryByText("Busy")).toBeNull();
    });

    test("exposes attention recovery while independently gating a busy provider", async () => {
        const runId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";
        const onClearKopiaAttention = mock(() => {});
        renderBackupOverviewView(
            <BackupOverviewSectionView
                kopia={{
                    ...kopia,
                    activity: {
                        finishedAtMs: nowMs,
                        jobRunId: runId,
                        jobsUrl: `/jobs?runId=${runId}`,
                        queuedAtMs: nowMs - 2000,
                        startedAtMs: nowMs - 1000,
                        state: "needs-attention",
                    },
                }}
                onClearKopiaAttention={onClearKopiaAttention}
                walg={{
                    ...walg,
                    payload: { ...walg.payload, providerIdle: false },
                }}
            />
        );

        const kopiaCard = await screen.findByLabelText("Kopia backup");
        expect(within(kopiaCard).getByText("Needs attention")).toBeTruthy();
        const clearAttention = within(kopiaCard).getByRole("button", {
            name: "Clear attention",
        });
        fireEvent.click(clearAttention);
        expect(onClearKopiaAttention).toHaveBeenCalledTimes(1);
        expect(
            within(kopiaCard).getByRole("link", { name: "View job" }).getAttribute("href")
        ).toBe(`/jobs?runId=${runId}`);

        const walgCard = screen.getByLabelText("WAL-G backup");
        expect(within(walgCard).getByText("Busy")).toBeTruthy();
        expect(
            within(walgCard).getByRole("button", { name: "Run backup" })
        ).toBeDisabled();
    });

    test("keeps unavailable and missing providers actionable without enabling backup controls", async () => {
        const onRetryWalg = mock(() => {});
        renderBackupOverviewView(
            <BackupOverviewSectionView
                controlsDisabled
                kopia={{
                    activity: { state: "idle" },
                    checkedAtMs: nowMs,
                    state: "unavailable",
                    type: "kopia",
                }}
                onRetryWalg={onRetryWalg}
                walg={undefined}
            />
        );

        const kopiaCard = await screen.findByLabelText("Kopia backup");
        expect(within(kopiaCard).getByText("Unavailable")).toBeTruthy();
        expect(
            within(kopiaCard).getByText(
                "No trustworthy provider status is currently available."
            )
        ).toBeTruthy();
        expect(
            within(kopiaCard).getByText("Backup controls are disabled for this session.")
        ).toBeTruthy();
        expect(
            within(kopiaCard).getByRole("button", { name: "Run backup" })
        ).toBeDisabled();

        const walgCard = screen.getByLabelText("WAL-G backup");
        const retry = within(walgCard).getByRole("button", { name: "Retry" });
        fireEvent.click(retry);
        expect(onRetryWalg).toHaveBeenCalledTimes(1);
    });

    test("shows per-provider loading while preserving available status", async () => {
        renderBackupOverviewView(
            <BackupOverviewSectionView kopia={kopia} loading walg={undefined} />
        );

        expect(await screen.findByLabelText("Kopia backup")).toBeTruthy();
        expect(
            screen.getByRole("status", { name: "Loading WAL-G backup status…" })
        ).toBeTruthy();
    });
});

describe("BackupOverviewSection", () => {
    test("queues a validated source-fenced WAL-G run and clears its recovery key", async () => {
        const { transport } = renderConnectedSection(kopia, walg);
        const walgCard = await screen.findByLabelText("WAL-G backup");

        fireEvent.click(within(walgCard).getByRole("button", { name: "Run backup" }));

        await waitFor(() => expect(transport.mutationCalls).toHaveLength(1));
        expect(transport.mutationCalls[0]).toMatchObject({
            input: {
                confirmation: "run-walg-backup",
                idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                sourceRevision,
            },
            path: "backups.runWalg",
        });
        expect(transport.mutationCalls[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(transport.mutationCalls[0]?.signal?.aborted).toBeFalse();
        expect(
            await screen.findByText("WAL-G run queued. Runtime success is not assumed.")
        ).toBeTruthy();
        expect(globalThis.sessionStorage.length).toBe(0);
    });

    test.each([
        [
            "Kopia",
            "Kopia backup",
            "backups.clearKopiaAttention",
            "clear-kopia-backup-attention",
            kopiaAttentionRunId,
        ],
        [
            "WAL-G",
            "WAL-G backup",
            "backups.clearWalgAttention",
            "clear-walg-backup-attention",
            walgAttentionRunId,
        ],
    ] as const)(
        "clears %s attention only for the exact provider run and source revision",
        async (label, cardLabel, path, confirmation, attentionRunId) => {
            const { transport } = renderConnectedSection(
                kopiaNeedsAttention,
                walgNeedsAttention
            );
            const card = await screen.findByLabelText(cardLabel);

            fireEvent.click(
                within(card).getByRole("button", { name: "Clear attention" })
            );
            await waitFor(() => expect(transport.mutationCalls).toHaveLength(1));

            expect(transport.mutationCalls[0]).toMatchObject({
                input: {
                    attentionRunId,
                    confirmation,
                    idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
                    sourceRevision,
                },
                path,
            });
            expect(transport.mutationCalls[0]?.signal).toBeInstanceOf(AbortSignal);
            expect(transport.mutationCalls[0]?.signal?.aborted).toBeFalse();
            expect(
                await screen.findByText(
                    `${label} attention clearance queued. Runtime success is not assumed.`
                )
            ).toBeTruthy();
            expect(globalThis.sessionStorage.length).toBe(0);
        }
    );
});
