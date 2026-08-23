import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type { DatabaseOverview } from "../../../contracts/database.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const observedAtMs = 1_800_000_000_000;

const freshOverview = {
    checkedAtMs: observedAtMs + 1000,
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
                backups: [
                    {
                        bytes: 8_388_608,
                        createdAtMs: observedAtMs - 3_600_000,
                        kind: "scheduled",
                        restoreVerifiedAtMs: observedAtMs - 3_500_000,
                        verificationLevel: "restore-copy-verified",
                    },
                ],
                observedAtMs,
                state: "available",
                totalBytes: 8_388_608,
            },
            maintenance: {
                enabled: true,
                latestSuccessfulAtMs: observedAtMs - 3_600_000,
                nextRunAtMs: observedAtMs + 21_600_000,
                observedAtMs,
                runs: [
                    {
                        finishedAtMs: observedAtMs - 3_600_000,
                        queuedAtMs: observedAtMs - 3_700_000,
                        runId: "019fc968-1a9b-7765-8f1b-d5b863b0e7c0",
                        startedAtMs: observedAtMs - 3_650_000,
                        state: "succeeded",
                    },
                ],
                schedule: { timeOfDay: "02:40", timeZone: "Europe/Oslo" },
                state: "available",
            },
            restoreVerification: {
                backupBytes: 8_388_608,
                backupCreatedAtMs: observedAtMs - 3_600_000,
                observedAtMs,
                state: "verified",
                verifiedAtMs: observedAtMs - 3_500_000,
            },
        },
        migrations: { applied: 12, available: 12, current: true },
        observedAtMs,
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

const maintenanceOverview = {
    checkedAtMs: observedAtMs + 1000,
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
        observedAtMs,
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
                lastAutoanalyzeAtMs: observedAtMs - 2000,
                lastAutovacuumAtMs: observedAtMs - 3000,
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

const notifications = {
    notifications: [],
    readCount: 0,
    unreadCount: 0,
} as const;

function databaseFixtures(overview: DashboardStoryFixtureValue): DashboardStoryFixtures {
    return {
        queries: {
            "database.overview": overview,
            "notifications.list": dashboardStoryValue(notifications),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to render the route loading state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { fixtures: databaseFixtures(pending), route: "/database" },
};

export const Fresh: Story = {
    args: {
        fixtures: databaseFixtures(dashboardStoryValue(freshOverview)),
        route: "/database",
    },
};

export const MaintenanceAttention: Story = {
    args: {
        fixtures: databaseFixtures(dashboardStoryValue(maintenanceOverview)),
        route: "/database",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("tab", { name: "PostgreSQL & PgBouncer" })
        );
        await expect(
            await canvas.findByText(/estimated 5\.0 GiB.*reclaimable table space/iu)
        ).toBeVisible();
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: databaseFixtures(
            dashboardStoryValue({
                ...freshOverview,
                checkedAtMs: observedAtMs + 1000,
                sqlite: {
                    ...freshOverview.sqlite,
                    staleSinceMs: observedAtMs + 500,
                    state: "last-known-good",
                },
            } satisfies DatabaseOverview)
        ),
        route: "/database",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: databaseFixtures(
            dashboardStoryResolver((_input, callIndex) =>
                callIndex === 0
                    ? freshOverview
                    : Promise.reject(new TypeError("Safe retained refresh failure"))
            )
        ),
        route: "/database",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("Connection policy")).toBeVisible();
        await expect(canvas.queryByText("Fresh observation")).not.toBeInTheDocument();
        await expect(
            canvas.queryByRole("button", { name: "Retry" })
        ).not.toBeInTheDocument();
    },
};

export const PartialUnavailable: Story = {
    args: {
        fixtures: databaseFixtures(dashboardStoryValue(freshOverview)),
        route: "/database",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("tab", { name: "PostgreSQL & PgBouncer" })
        );
        await expect(
            await canvas.findByRole("heading", {
                name: "PostgreSQL diagnostics unavailable",
            })
        ).toBeVisible();
    },
};

export const Unavailable: Story = {
    args: {
        fixtures: databaseFixtures(
            dashboardStoryValue({
                checkedAtMs: observedAtMs,
                postgresql: { state: "unavailable" },
                sqlite: { state: "unavailable" },
            } satisfies DatabaseOverview)
        ),
        route: "/database",
    },
};
