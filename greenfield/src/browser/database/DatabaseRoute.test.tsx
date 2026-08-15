import { afterEach, describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import * as v from "valibot";

import {
    databaseOverviewSchema,
    type DatabaseOverview,
} from "../../contracts/database.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import {
    databaseOverviewQueryKey,
    databaseOverviewQueryOptions,
    databaseOverviewRefreshIntervalMs,
} from "./databaseQueries.ts";
import { DatabaseRouteContent } from "./DatabaseRoute.tsx";

const { cleanup, render, screen, within } = await import("@testing-library/react");

const freshOverview = {
    checkedAtMs: 2000,
    postgresql: { state: "unavailable" },
    sqlite: {
        connection: {
            busyPolicy: "non-blocking",
            checksEnforced: true,
            foreignKeysEnabled: true,
            journalMode: "wal",
            synchronousMode: "full",
            trustedSchemaEnabled: false,
            walAutoCheckpointPages: 1000,
        },
        fileName: "mira-dashboard.db",
        lifecycle: {
            backupInventory: {
                reason: "inventory-unavailable",
                state: "unavailable",
            },
            maintenance: {
                reason: "maintenance-unavailable",
                state: "unavailable",
            },
            restoreVerification: {
                reason: "verification-unavailable",
                state: "unavailable",
            },
        },
        migrations: { applied: 12, available: 12, current: true },
        observedAtMs: 2000,
        state: "fresh",
        storage: {
            databaseBytes: 67_108_864,
            freeBytes: 4_194_304,
            freePages: 1024,
            freePercent: 6.25,
            pageCount: 16_384,
            pageSizeBytes: 4096,
            permissions: {
                dataDirectory: "0700",
                database: "0600",
                secure: true,
                shm: "0600",
                wal: "0600",
            },
            requiresVacuumReview: false,
            shmBytes: 32_768,
            storageBytes: 71_335_936,
            walBytes: 4_194_304,
        },
    },
} as const satisfies DatabaseOverview;

const freshPostgresqlOverview = {
    checkedAtMs: 4000,
    postgresql: {
        databases: [
            {
                blocksHit: 984,
                blocksRead: 16,
                cacheHitRatio: 98.4,
                committedTransactions: 1234,
                connections: 7,
                detailsState: "available",
                name: "mira_app",
                pool: {
                    activeClients: 5,
                    activeServers: 3,
                    averageQueryMs: 14,
                    averageTransactionMs: 21.5,
                    idleServers: 2,
                    totalQueries: 4500,
                    usedServers: 1,
                    waitingClients: 1,
                },
                rolledBackTransactions: 12,
                sizeBytes: 6 * 1024 * 1024 * 1024,
            },
            {
                blocksHit: 961,
                blocksRead: 39,
                cacheHitRatio: 96.1,
                committedTransactions: 800,
                connections: 3,
                detailsState: "available",
                name: "search_index",
                rolledBackTransactions: 2,
                sizeBytes: 2 * 1024 * 1024 * 1024,
            },
        ],
        observedAtMs: 3500,
        pgbouncer: {
            averageQueryMs: 14,
            averageTransactionMs: 21.5,
            clientConnections: 10,
            maxWaitSeconds: 0.25,
            serverConnections: 6,
            waitingClients: 1,
        },
        state: "fresh",
        statements: [
            {
                calls: 640,
                meanExecutionMs: 508.25,
                rank: 1,
                rows: 1280,
                sharedBlocksHit: 9100,
                sharedBlocksRead: 42,
                totalExecutionMs: 5280,
            },
        ],
        summary: {
            activeConnections: 4,
            averageCacheHitRatio: 97.25,
            idleConnections: 6,
            maintenance: {
                assessedPhysicalBytes: 6 * 1024 * 1024 * 1024,
                assessmentComplete: true,
                estimatedReclaimableBytes: 5 * 1024 * 1024 * 1024,
                estimatedReclaimablePercent: (5 / 6) * 100,
                highDeadTupleTableCount: 1,
                requiresBloatReview: true,
                slowStatementCount: 1,
                status: "review",
                unassessedPhysicalBytes: 0,
                unassessedTableCount: 0,
            },
            pgStatStatementsEnabled: true,
            totalConnections: 10,
            totalDatabaseSizeBytes: 8 * 1024 * 1024 * 1024,
            unavailableDatabaseCount: 0,
        },
        tableHealth: [
            {
                assessment: "assessed",
                database: "mira_app",
                deadTuplePercent: 25,
                deadTuples: 2000,
                estimatedReclaimableBytes: 5 * 1024 * 1024 * 1024,
                lastAutoanalyzeAtMs: 3200,
                lastAutovacuumAtMs: 3000,
                liveTuples: 8000,
                physicalBytes: 6 * 1024 * 1024 * 1024,
                schema: "public",
                table: "events",
            },
        ],
        torrentCounts: {
            bitmagnet: { count: 125_000, state: "available" },
            comet: { state: "unavailable" },
        },
    },
    sqlite: freshOverview.sqlite,
} as const satisfies DatabaseOverview;

const lifecycleOverview = {
    ...freshOverview,
    checkedAtMs: 172_800_000,
    sqlite: {
        ...freshOverview.sqlite,
        lifecycle: {
            backupInventory: {
                backups: [
                    {
                        bytes: 8_388_608,
                        createdAtMs: 172_000_000,
                        kind: "scheduled",
                        restoreVerifiedAtMs: 172_000_000,
                        verificationLevel: "restore-copy-verified",
                    },
                ],
                observedAtMs: 172_800_000,
                state: "available",
                totalBytes: 8_388_608,
            },
            maintenance: {
                enabled: true,
                latestSuccessfulAtMs: 172_100_000,
                nextRunAtMs: 180_000_000,
                observedAtMs: 172_800_000,
                runs: [
                    {
                        finishedAtMs: 172_100_000,
                        queuedAtMs: 172_000_000,
                        startedAtMs: 172_050_000,
                        state: "succeeded",
                    },
                ],
                schedule: { timeOfDay: "02:40", timeZone: "Europe/Oslo" },
                state: "available",
            },
            restoreVerification: {
                backupBytes: 8_388_608,
                backupCreatedAtMs: 172_000_000,
                observedAtMs: 172_800_000,
                state: "verified",
                verifiedAtMs: 172_000_000,
            },
        },
        observedAtMs: 172_800_000,
    },
} as const satisfies DatabaseOverview;

afterEach(cleanup);

function renderRoute(
    response: Promise<DatabaseOverview> | (() => Promise<DatabaseOverview>),
    configure?: (queryClient: QueryClient) => void,
    source: "postgresql" | "sqlite" = "sqlite"
) {
    const query = jest.fn(() => (typeof response === "function" ? response() : response));
    const client = {
        mutation: () => Promise.reject(new Error("Unexpected mutation")),
        query,
    } as unknown as DashboardTrpcClient;
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    configure?.(queryClient);
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <DatabaseRouteContent onSelect={() => {}} source={source} />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    return { query, queryClient, view };
}

describe("DatabaseRoute", () => {
    test("uses contract-valid source fixtures", () => {
        expect(v.safeParse(databaseOverviewSchema, freshOverview).success).toBe(true);
        expect(v.safeParse(databaseOverviewSchema, freshPostgresqlOverview).success).toBe(
            true
        );
    });

    test("refreshes mounted observations only in the foreground", () => {
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query: () => Promise.resolve(freshOverview),
        } as unknown as DashboardTrpcClient;
        const options = databaseOverviewQueryOptions(client);

        expect(options.refetchInterval).toBe(databaseOverviewRefreshIntervalMs);
        expect(options.refetchIntervalInBackground).toBeFalse();
        expect(options.refetchOnMount).toBe("always");
        expect(options.staleTime).toBe(databaseOverviewRefreshIntervalMs);
    });

    test("offers both reviewed sources through an accessible picker", () => {
        const onSelect = jest.fn();
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected mutation")),
            query: () => Promise.resolve(freshOverview),
        } as unknown as DashboardTrpcClient;
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={client}>
                    <DatabaseRouteContent onSelect={onSelect} source="sqlite" />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );
        try {
            const sqlite = screen.getByRole("button", { name: "Dashboard SQLite" });
            const postgres = screen.getByRole("button", {
                name: "PostgreSQL & PgBouncer",
            });
            expect(screen.getByRole("group", { name: "Database source" })).toBeVisible();
            expect(sqlite).toHaveAttribute("aria-pressed", "true");
            expect(postgres).toHaveAttribute("aria-pressed", "false");
            postgres.click();
            expect(onSelect).toHaveBeenCalledWith("postgresql");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("shows an explicit loading state before the first bounded observation", () => {
        const pending = Promise.withResolvers<DatabaseOverview>();
        const { queryClient, view } = renderRoute(pending.promise);
        try {
            expect(screen.getByLabelText("Loading database overview…")).toBeVisible();
            expect(screen.queryByText("Connection policy")).toBeNull();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("renders the read-only SQLite lifecycle projection", async () => {
        const { query, queryClient, view } = renderRoute(Promise.resolve(freshOverview));
        try {
            expect(await screen.findByText("Fresh observation")).toBeVisible();
            expect(screen.getByText("12 / 12")).toBeVisible();
            expect(screen.getByText("Current")).toBeVisible();
            expect(screen.getByText("1,000 pages")).toBeVisible();
            expect(screen.getByText("Disabled")).toBeVisible();
            expect(screen.getAllByText("64 MiB")).not.toHaveLength(0);
            expect(screen.getByText("mira-dashboard.db · 64 MiB")).toBeVisible();
            expect(screen.getAllByText("4.0 MiB")).not.toHaveLength(0);
            expect(screen.getByText("Permissions secure")).toBeVisible();
            expect(screen.getByText("0700 / 0600 / 0600 / 0600")).toBeVisible();
            expect(screen.getByText("Backup kinds")).toBeVisible();
            expect(screen.getByText("None")).toBeVisible();
            expect(
                screen.getByText("SQLite backup inventory is unavailable.")
            ).toBeVisible();
            expect(
                screen.getByText("SQLite maintenance status is unavailable.")
            ).toBeVisible();
            expect(query).toHaveBeenCalledWith(
                "database.overview",
                {},
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("renders latest verified backup and maintenance details without paths", async () => {
        const { queryClient, view } = renderRoute(Promise.resolve(lifecycleOverview));
        try {
            expect(await screen.findByText("1 verified · 8.0 MiB")).toBeVisible();
            expect(screen.getByText("scheduled: 1")).toBeVisible();
            expect(screen.getAllByText(/8\.0 MiB$/u)).toHaveLength(2);
            expect(screen.getByText(/succeeded/u)).toBeVisible();
            expect(screen.getByText("02:40 Europe/Oslo · 1 retained runs")).toBeVisible();
            expect(screen.queryByText(/\/state\//u)).toBeNull();
            expect(screen.queryByText(/raw error/iu)).toBeNull();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("marks each retained SQLite lifecycle source with its own stale time", async () => {
        const retainedOverview = {
            ...lifecycleOverview,
            sqlite: {
                ...lifecycleOverview.sqlite,
                lifecycle: {
                    backupInventory: {
                        ...lifecycleOverview.sqlite.lifecycle.backupInventory,
                        staleSinceMs: 172_200_000,
                        state: "last-known-good",
                    },
                    maintenance: {
                        ...lifecycleOverview.sqlite.lifecycle.maintenance,
                        staleSinceMs: 172_300_000,
                        state: "last-known-good",
                    },
                    restoreVerification: {
                        ...lifecycleOverview.sqlite.lifecycle.restoreVerification,
                        staleSinceMs: 172_400_000,
                        state: "last-known-good",
                    },
                },
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(Promise.resolve(retainedOverview));
        try {
            const states = await screen.findByRole("region", {
                name: "SQLite lifecycle observation states",
            });
            expect(within(states).getAllByText("Last-known-good")).toHaveLength(3);
            expect(within(states).getAllByText(/Retained since/u)).toHaveLength(3);
            expect(
                [...states.querySelectorAll("time")].map((time) =>
                    time.getAttribute("dateTime")
                )
            ).toEqual(
                [172_200_000, 172_400_000, 172_300_000].map((timestampMs) =>
                    new Date(timestampMs).toISOString()
                )
            );
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("explains old backups and disabled, missing, old, or failed maintenance", async () => {
        const cases = [
            {
                message: "Scheduled SQLite maintenance is disabled.",
                overview: {
                    ...lifecycleOverview,
                    sqlite: {
                        ...lifecycleOverview.sqlite,
                        lifecycle: {
                            ...lifecycleOverview.sqlite.lifecycle,
                            maintenance: {
                                ...lifecycleOverview.sqlite.lifecycle.maintenance,
                                enabled: false,
                                nextRunAtMs: undefined,
                            },
                        },
                    },
                },
            },
            {
                message: "Scheduled SQLite maintenance has no successful run yet.",
                overview: {
                    ...lifecycleOverview,
                    sqlite: {
                        ...lifecycleOverview.sqlite,
                        lifecycle: {
                            ...lifecycleOverview.sqlite.lifecycle,
                            maintenance: {
                                ...lifecycleOverview.sqlite.lifecycle.maintenance,
                                latestSuccessfulAtMs: undefined,
                                runs: [
                                    {
                                        queuedAtMs: 172_700_000,
                                        state: "queued" as const,
                                    },
                                ],
                            },
                        },
                    },
                },
            },
            {
                message:
                    "The latest verified SQLite maintenance backup is older than the 48-hour policy.",
                overview: {
                    ...lifecycleOverview,
                    sqlite: {
                        ...lifecycleOverview.sqlite,
                        lifecycle: {
                            ...lifecycleOverview.sqlite.lifecycle,
                            backupInventory: {
                                ...lifecycleOverview.sqlite.lifecycle.backupInventory,
                                backups: [
                                    {
                                        bytes: 4096,
                                        createdAtMs: 172_700_000,
                                        kind: "cutover" as const,
                                        verificationLevel: "manifest-verified" as const,
                                    },
                                    {
                                        bytes: 8_388_608,
                                        createdAtMs: 0,
                                        kind: "scheduled" as const,
                                        restoreVerifiedAtMs: 0,
                                        verificationLevel:
                                            "restore-copy-verified" as const,
                                    },
                                ],
                                totalBytes: 8_392_704,
                            },
                            restoreVerification: {
                                backupBytes: 8_388_608,
                                backupCreatedAtMs: 0,
                                observedAtMs: 172_800_000,
                                state: "verified" as const,
                                verifiedAtMs: 0,
                            },
                        },
                    },
                },
            },
            {
                message: "The latest terminal SQLite maintenance run failed.",
                overview: {
                    ...lifecycleOverview,
                    sqlite: {
                        ...lifecycleOverview.sqlite,
                        lifecycle: {
                            ...lifecycleOverview.sqlite.lifecycle,
                            maintenance: {
                                ...lifecycleOverview.sqlite.lifecycle.maintenance,
                                runs: [
                                    {
                                        queuedAtMs: 172_700_000,
                                        startedAtMs: 172_750_000,
                                        state: "running" as const,
                                    },
                                    {
                                        finishedAtMs: 172_100_000,
                                        queuedAtMs: 172_000_000,
                                        startedAtMs: 172_050_000,
                                        state: "failed" as const,
                                    },
                                ],
                            },
                        },
                    },
                },
            },
            {
                message:
                    "The latest successful SQLite maintenance run is older than 48 hours.",
                overview: {
                    ...lifecycleOverview,
                    checkedAtMs: 200_000_000,
                    sqlite: {
                        ...lifecycleOverview.sqlite,
                        lifecycle: {
                            ...lifecycleOverview.sqlite.lifecycle,
                            maintenance: {
                                ...lifecycleOverview.sqlite.lifecycle.maintenance,
                                latestSuccessfulAtMs: 1,
                                runs: [
                                    {
                                        queuedAtMs: 172_700_000,
                                        state: "queued" as const,
                                    },
                                ],
                            },
                        },
                        observedAtMs: 200_000_000,
                    },
                },
            },
        ] as const;
        for (const { message, overview } of cases) {
            const { queryClient, view } = renderRoute(
                Promise.resolve(overview as DatabaseOverview)
            );
            try {
                expect(await screen.findByText(message)).toBeVisible();
            } finally {
                view.unmount();
                queryClient.clear();
                cleanup();
            }
        }
    });

    test("surfaces material reusable space as a planned VACUUM review", async () => {
        const overview = {
            ...freshOverview,
            sqlite: {
                ...freshOverview.sqlite,
                storage: {
                    ...freshOverview.sqlite.storage,
                    freeBytes: 1024 * 1024 * 1024,
                    freePages: 262_144,
                    freePercent: 100,
                    pageCount: 262_144,
                    requiresVacuumReview: true,
                },
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(Promise.resolve(overview));
        try {
            expect(
                await screen.findByText(
                    /review a planned vacuum to compact the database/iu
                )
            ).toBeVisible();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("surfaces insecure SQLite storage modes as operator attention", async () => {
        const overview = {
            ...freshOverview,
            sqlite: {
                ...freshOverview.sqlite,
                storage: {
                    ...freshOverview.sqlite.storage,
                    permissions: {
                        ...freshOverview.sqlite.storage.permissions,
                        database: "0640" as const,
                        secure: false,
                    },
                },
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(Promise.resolve(overview));
        try {
            expect(
                await screen.findByText(
                    /permissions are outside the private storage policy/iu
                )
            ).toBeVisible();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("distinguishes server-retained last-known-good data", async () => {
        const retained = {
            ...freshOverview,
            checkedAtMs: 3000,
            sqlite: {
                ...freshOverview.sqlite,
                staleSinceMs: 2500,
                state: "last-known-good",
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(Promise.resolve(retained));
        try {
            expect(await screen.findByText("Last-known-good")).toBeVisible();
            expect(
                screen.getByText(/latest SQLite diagnostics check failed/iu)
            ).toBeVisible();
            expect(screen.getByText("12 / 12")).toBeVisible();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("keeps PostgreSQL unavailability independent from fresh SQLite data", async () => {
        const { queryClient, view } = renderRoute(
            Promise.resolve(freshOverview),
            undefined,
            "postgresql"
        );
        try {
            expect(
                await screen.findByRole("heading", {
                    name: "PostgreSQL diagnostics unavailable",
                })
            ).toBeVisible();
            expect(screen.queryByText("Connection policy")).toBeNull();
            expect(
                screen.getByRole("button", { name: "PostgreSQL & PgBouncer" })
            ).toHaveAttribute("aria-pressed", "true");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("renders bounded PostgreSQL and PgBouncer aggregates without query identities", async () => {
        const { queryClient, view } = renderRoute(
            Promise.resolve(freshPostgresqlOverview),
            undefined,
            "postgresql"
        );
        try {
            expect(await screen.findByText("Database storage")).toBeVisible();
            expect(screen.getByText("8.0 GiB")).toBeVisible();
            expect(screen.getByText("97.3%")).toBeVisible();
            expect(screen.getAllByText("Review")).toHaveLength(2);
            expect(screen.getByText("5.0 GiB · 83.3%")).toBeVisible();
            expect(screen.getByText("Required")).toBeVisible();
            expect(
                screen.getByText(
                    /estimated 5\.0 GiB \(83\.3%\) reclaimable table space/iu
                )
            ).toBeVisible();
            expect(
                screen.getByText(/standard VACUUM makes space reusable internally/iu)
            ).toBeVisible();
            expect(
                screen.getByText(/1 PostgreSQL table exceeds the dead-tuple/iu)
            ).toBeVisible();
            expect(
                screen.getByText(
                    /1 identity-free PostgreSQL statement aggregate exceeds/iu
                )
            ).toBeVisible();
            expect(screen.getByText("Unassessed physical size")).toBeVisible();
            expect(
                screen.getByRole("heading", { name: "Comet torrents" }).closest("section")
            ).toHaveTextContent("Unavailable");
            expect(
                screen
                    .getByRole("heading", { name: "Bitmagnet torrents" })
                    .closest("section")
            ).toHaveTextContent("125,000");
            expect(screen.getByText("PgBouncer aggregate")).toBeVisible();
            expect(screen.getAllByText("21.5 ms")).toHaveLength(2);
            expect(screen.getByText("0.25 s")).toBeVisible();

            const databases = screen.getByRole("region", {
                name: "PostgreSQL databases",
            });
            expect(databases).toHaveClass(
                "dashboard-data-table-container",
                "overflow-x-auto",
                "@max-[66rem]:overflow-x-hidden"
            );
            expect(within(databases).getByText("mira_app")).toBeVisible();
            expect(within(databases).getByText("1,234")).toBeVisible();
            expect(within(databases).getByText("98.4%")).toBeVisible();
            expect(within(databases).getByText("5 active · 1 waiting")).toBeVisible();
            expect(within(databases).getByText("4,500")).toBeVisible();

            const health = screen.getByRole("region", {
                name: "PostgreSQL table health",
            });
            expect(within(health).getByText("public")).toBeVisible();
            expect(within(health).getByText("events")).toBeVisible();
            expect(within(health).getByText("25%")).toBeVisible();
            expect(within(health).getByText("Assessed")).toBeVisible();
            expect(within(health).getByText("5.0 GiB")).toBeVisible();

            const statements = screen.getByRole("region", {
                name: "PostgreSQL statement metrics",
            });
            expect(within(statements).getByText("5,280 ms")).toBeVisible();
            expect(within(statements).getByText("508.25 ms")).toBeVisible();
            expect(
                within(statements).getByRole("columnheader", { name: "Rank" })
            ).toBeVisible();
            expect(
                within(statements).queryByRole("columnheader", {
                    name: /query|sql|user/iu,
                })
            ).toBeNull();
            expect(within(statements).queryByText(/select\s/iu)).toBeNull();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("renders an unavailable dynamic database and incomplete assessment explicitly", async () => {
        const partiallyUnavailable = {
            ...freshPostgresqlOverview,
            postgresql: {
                ...freshPostgresqlOverview.postgresql,
                databases: freshPostgresqlOverview.postgresql.databases.map((database) =>
                    database.name === "search_index"
                        ? { ...database, detailsState: "unavailable" as const }
                        : database
                ),
                summary: {
                    ...freshPostgresqlOverview.postgresql.summary,
                    maintenance: {
                        ...freshPostgresqlOverview.postgresql.summary.maintenance,
                        assessmentComplete: false,
                        status: "review" as const,
                    },
                    unavailableDatabaseCount: 1,
                },
            },
        } satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(
            Promise.resolve(partiallyUnavailable),
            undefined,
            "postgresql"
        );
        try {
            const databases = await screen.findByRole("region", {
                name: "PostgreSQL databases",
            });
            expect(within(databases).getByText("search_index")).toBeVisible();
            expect(within(databases).getByText("Unavailable")).toBeVisible();

            const maintenance = screen.getByRole("region", {
                name: "Maintenance assessment",
            });
            expect(within(maintenance).getByText("Review")).toBeVisible();
            expect(
                screen.getByText(/1 PostgreSQL database could not be fully assessed/iu)
            ).toBeVisible();
            expect(
                within(maintenance)
                    .getByText("Unavailable database details")
                    .closest("div")
            ).toHaveTextContent("1");
            expect(
                within(maintenance).getByText("Bloat assessment").closest("div")
            ).toHaveTextContent("Incomplete");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("distinguishes server-retained PostgreSQL data", async () => {
        const retained = {
            ...freshPostgresqlOverview,
            checkedAtMs: 4500,
            postgresql: {
                ...freshPostgresqlOverview.postgresql,
                staleSinceMs: 4000,
                state: "last-known-good",
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(
            Promise.resolve(retained),
            undefined,
            "postgresql"
        );
        try {
            expect(await screen.findByText("Last-known-good")).toBeVisible();
            expect(
                screen.getByText(/latest PostgreSQL\/PgBouncer collection failed/iu)
            ).toBeVisible();
            expect(screen.getByText("8.0 GiB")).toBeVisible();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("explains incomplete maintenance and disabled statement assessment", async () => {
        const notAssessed = {
            ...freshPostgresqlOverview,
            postgresql: {
                ...freshPostgresqlOverview.postgresql,
                statements: [],
                summary: {
                    ...freshPostgresqlOverview.postgresql.summary,
                    maintenance: {
                        assessedPhysicalBytes: 0,
                        assessmentComplete: false,
                        estimatedReclaimableBytes: 0,
                        estimatedReclaimablePercent: 0,
                        highDeadTupleTableCount: 0,
                        requiresBloatReview: false,
                        slowStatementCount: 0,
                        status: "not-assessed",
                        unassessedPhysicalBytes: 536_870_912,
                        unassessedTableCount: 1,
                    },
                    pgStatStatementsEnabled: false,
                },
                tableHealth: [
                    {
                        assessment: "unavailable",
                        database: "mira_app",
                        deadTuplePercent: 7.5,
                        deadTuples: 75,
                        liveTuples: 925,
                        physicalBytes: 536_870_912,
                        schema: "public",
                        table: "events",
                    },
                ],
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(
            Promise.resolve(notAssessed),
            undefined,
            "postgresql"
        );
        try {
            expect(
                await screen.findByText(
                    "Statement metrics are unavailable because pg_stat_statements is not enabled."
                )
            ).toBeVisible();
            const maintenance = screen.getByRole("region", {
                name: "Maintenance assessment",
            });
            expect(within(maintenance).getByText("Incomplete")).toBeVisible();
            expect(within(maintenance).getByText("512 MiB")).toBeVisible();
            expect(
                screen.getByText(/1 PostgreSQL table \(512 MiB\) could not be assessed/iu)
            ).toBeVisible();
            expect(
                screen.getByText(/statement maintenance assessment is unavailable/iu)
            ).toBeVisible();
            const health = screen.getByRole("region", {
                name: "PostgreSQL table health",
            });
            expect(within(health).getByText("Not assessed")).toBeVisible();
            expect(within(health).getAllByText("—")).toHaveLength(3);
            expect(
                screen.queryByRole("region", {
                    name: "PostgreSQL statement metrics",
                })
            ).toBeNull();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("renders Comet and Bitmagnet count availability independently", async () => {
        const reversedAvailability = {
            ...freshPostgresqlOverview,
            postgresql: {
                ...freshPostgresqlOverview.postgresql,
                torrentCounts: {
                    bitmagnet: { state: "unavailable" },
                    comet: { count: 42, state: "available" },
                },
            },
        } as const satisfies DatabaseOverview;
        const { queryClient, view } = renderRoute(
            Promise.resolve(reversedAvailability),
            undefined,
            "postgresql"
        );
        try {
            const cometHeading = await screen.findByRole("heading", {
                name: "Comet torrents",
            });
            expect(cometHeading.closest("section")).toHaveTextContent("42");
            expect(
                screen
                    .getByRole("heading", { name: "Bitmagnet torrents" })
                    .closest("section")
            ).toHaveTextContent("Unavailable");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("keeps cached data visible when a background refresh fails", async () => {
        const { queryClient, view } = renderRoute(
            () => Promise.reject(new Error("private database path")),
            (cache) =>
                cache.setQueryData(databaseOverviewQueryKey, freshOverview, {
                    updatedAt: 1,
                })
        );
        try {
            expect(screen.getByText("12 / 12")).toBeVisible();
            expect(
                await screen.findByText(
                    "The latest refresh failed. Showing retained database data."
                )
            ).toBeVisible();
            expect(screen.getByText("Browser cache retained")).toBeVisible();
            expect(screen.queryByText("Fresh observation")).toBeNull();
            expect(screen.queryByText(/private database path/iu)).toBeNull();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("marks browser-retained PostgreSQL data separately from server LKG", async () => {
        const { queryClient, view } = renderRoute(
            () => Promise.reject(new Error("private PostgreSQL failure")),
            (cache) =>
                cache.setQueryData(databaseOverviewQueryKey, freshPostgresqlOverview, {
                    updatedAt: 1,
                }),
            "postgresql"
        );
        try {
            expect(await screen.findByText("Browser cache retained")).toBeVisible();
            expect(screen.queryByText("Fresh observation")).toBeNull();
            expect(screen.getByText("2.0 GiB")).toBeVisible();
            expect(screen.queryByText(/private PostgreSQL failure/iu)).toBeNull();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("shows a safe retryable error without retained data", async () => {
        const { queryClient, view } = renderRoute(() =>
            Promise.reject(new Error("private database path"))
        );
        try {
            expect(
                await screen.findByRole("heading", {
                    name: "Database overview unavailable",
                })
            ).toBeVisible();
            expect(
                screen.getByText("The request could not be completed. Try again.")
            ).toBeVisible();
            expect(screen.queryByText(/private database path/iu)).toBeNull();
        } finally {
            await act(async () => {});
            view.unmount();
            queryClient.clear();
        }
    });
});
