import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type { AgentConfiguration } from "../../../contracts/agentModel.ts";
import type { ListAgentStatusesResult } from "../../../contracts/agents.ts";
import type { KopiaBackupStatus, WalgBackupStatus } from "../../../contracts/backups.ts";
import type { CacheEntry, CacheStatusResult } from "../../../contracts/cache.ts";
import type { DatabaseOverview } from "../../../contracts/database.ts";
import type { DockerOverview } from "../../../contracts/docker.ts";
import type { JobRunSummary } from "../../../contracts/jobModel.ts";
import type { ListJobRunsResult } from "../../../contracts/jobs.ts";
import type {
    ListLogSourcesOutput,
    LogMaintenanceStatusOutput,
} from "../../../contracts/logs.ts";
import type { ListNotificationsResult } from "../../../contracts/notifications.ts";
import type { GetServiceActionsStatusResult } from "../../../contracts/serviceActions.ts";
import type { SystemMetrics } from "../../../contracts/system.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import {
    observedStorySystemApplicationMetrics,
    unavailableStorySystemApplicationMetrics,
} from "../../storySupport/systemMetricsStoryFixture.ts";

const observedAtMs = 1_800_000_000_000;
const sourceRevision = "a".repeat(64);
const hostRunId = "019fe000-0000-7000-8000-000000000001";
const refreshRunId = "019fe000-0000-7000-8000-000000000002";

const systemMetrics = {
    application: observedStorySystemApplicationMetrics(observedAtMs),
    cpu: { loadAverage: [2, 1, 0.5], loadPercent: 50, logicalCoreCount: 4 },
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
    sampledAtMs: observedAtMs,
    uptimeSeconds: 183_600,
} as const satisfies SystemMetrics;

const hostEntry = {
    consecutiveFailures: 0,
    expiresAtMs: observedAtMs + 60_000,
    freshness: "fresh",
    key: "system.host",
    lastAttemptAtMs: observedAtMs,
    lastAttemptDurationMs: 250,
    lastAttemptNumber: 2,
    lastAttemptRunId: hostRunId,
    lastAttemptStatus: "succeeded",
    lastSuccessAtMs: observedAtMs,
    manualRunAvailable: true,
    metadata: {},
    payload: {
        architecture: "arm64",
        disk: {
            freeBytes: 40 * 1024 ** 3,
            path: "/",
            totalBytes: 100 * 1024 ** 3,
        },
        hostname: "dashboard-host",
        memory: { freeBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
        platform: "linux",
        release: "6.8.0",
        uptimeSeconds: 183_600,
    },
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAtMs: observedAtMs,
} as const satisfies CacheEntry;

const weatherEntry = {
    ...hostEntry,
    key: "weather.spydeberg",
    payload: {
        apparentTemperatureC: 13,
        condition: "cloudy",
        forecast: [
            {
                condition: "rain",
                date: "2026-08-13",
                maximumTemperatureC: 18,
                minimumTemperatureC: 11,
            },
            {
                condition: "cloudy",
                date: "2026-08-14",
                maximumTemperatureC: 19,
                minimumTemperatureC: 10,
            },
            {
                condition: "clear",
                date: "2026-08-15",
                maximumTemperatureC: 21,
                minimumTemperatureC: 12,
            },
        ],
        humidityPercent: 68,
        location: "Spydeberg",
        observedAtMs,
        temperatureC: 15,
        timezone: "Europe/Oslo",
        windKilometresPerHour: 9,
    },
    schemaId: "weather.spydeberg.v1",
    source: "weather.open-meteo",
} as const satisfies CacheEntry;

const quotaEntry = {
    ...hostEntry,
    key: "quotas.summary",
    payload: {
        observedAtMs,
        providers: [
            {
                id: "elevenlabs",
                label: "ElevenLabs",
                remainingPercent: 72,
                resetsAtMs: observedAtMs + 24 * 60 * 60_000,
                status: "available",
            },
            {
                id: "openai",
                label: "OpenAI / Codex",
                status: "available",
                usedPercent: 34,
                windows: [
                    {
                        resetsAtMs: observedAtMs + 60_000,
                        usedPercent: 0,
                        windowDurationMinutes: 300,
                    },
                    {
                        resetsAtMs: observedAtMs + 4 * 24 * 60 * 60_000,
                        usedPercent: 34,
                        windowDurationMinutes: 10_080,
                    },
                ],
            },
            {
                balance: 4.26,
                id: "openrouter",
                label: "OpenRouter",
                limit: 1,
                periodUsage: 0.1344,
                remaining: 0.866,
                status: "available",
                usedPercent: 13.4,
                unit: "currency-usd",
            },
            {
                id: "synthetic",
                label: "Synthetic.new",
                remainingPercent: 64,
                status: "available",
                usedPercent: 36,
                windows: [
                    {
                        regenerationPercent: 5,
                        resetsAtMs: observedAtMs + 2 * 60_000,
                        usedPercent: 36,
                        windowDurationMinutes: 300,
                    },
                    {
                        regenerationPercent: 2,
                        resetsAtMs: observedAtMs + 7 * 24 * 60 * 60_000,
                        usedPercent: 28,
                        windowDurationMinutes: 10_080,
                    },
                ],
            },
        ],
    },
    schemaId: "quotas.summary.v2",
    source: "quota.providers",
} as const satisfies CacheEntry;

const gitEntry = {
    ...hostEntry,
    key: "git.workspace",
    payload: {
        observedAtMs,
        repositories: [
            {
                branch: "main",
                changedFileCount: 0,
                detached: false,
                headSha: "a".repeat(40),
                id: "dashboard",
                stagedFileCount: 0,
                state: "available",
                untrackedFileCount: 0,
            },
            {
                branch: "main",
                changedFileCount: 1,
                detached: false,
                headSha: "b".repeat(40),
                id: "docker",
                stagedFileCount: 0,
                state: "available",
                untrackedFileCount: 1,
            },
            {
                branch: "main",
                changedFileCount: 0,
                detached: false,
                headSha: "c".repeat(40),
                id: "openclaw",
                stagedFileCount: 0,
                state: "available",
                untrackedFileCount: 0,
            },
        ],
    },
    schemaId: "git.workspace.v1",
    source: "git.managed-workspace",
} as const satisfies CacheEntry;

const cacheEntries = [gitEntry, quotaEntry, hostEntry, weatherEntry] as const;
const cacheStatus = {
    entries: cacheEntries.map(({ payload: _payload, ...entry }) => entry),
    generatedAtMs: observedAtMs,
    totalCount: cacheEntries.length,
    truncated: false,
} satisfies CacheStatusResult;

const kopiaStatus = {
    activity: { state: "idle" },
    checkedAtMs: observedAtMs,
    payload: {
        backupCount: 8,
        healthy: true,
        observedAtMs,
        providerIdle: true,
        sourceRevision,
        sources: [
            {
                health: "current",
                id: "primary",
                latestCompletedAtMs: observedAtMs - 60_000,
                snapshotCount: 8,
            },
        ],
        type: "kopia",
    },
    state: "fresh",
} as const satisfies KopiaBackupStatus;

const walgStatus = {
    activity: { state: "idle" },
    checkedAtMs: observedAtMs,
    payload: {
        backupCount: 12,
        healthy: true,
        latestCompletedAtMs: observedAtMs - 60_000,
        observedAtMs,
        providerIdle: true,
        sourceRevision,
        type: "walg",
    },
    state: "fresh",
} as const satisfies WalgBackupStatus;

const dockerOverview = {
    checkedAtMs: observedAtMs,
    containers: [
        {
            createdAtMs: observedAtMs - 60_000,
            health: "healthy",
            id: "1".repeat(64),
            image: "example/dashboard:1.0.0",
            imageId: `sha256:${"2".repeat(64)}`,
            mounts: [],
            name: "dashboard-web",
            networks: [],
            ports: [],
            project: "dashboard",
            restartCount: 0,
            service: "web",
            startedAtMs: observedAtMs - 50_000,
            state: "running",
        },
    ],
    images: [
        {
            createdAtMs: observedAtMs - 60_000,
            id: `sha256:${"2".repeat(64)}`,
            references: ["example/dashboard:1.0.0"],
            sizeBytes: 512 * 1024 ** 2,
            usedByContainerIds: ["1".repeat(64)],
        },
    ],
    observedAtMs,
    sourceRevision,
    state: "fresh",
    updaterEvents: [],
    updaterServices: [],
    volumes: [
        {
            createdAtMs: observedAtMs - 60_000,
            driver: "local",
            name: "dashboard-data",
            scope: "local",
            sizeBytes: 2 * 1024 ** 3,
            usedByContainerIds: ["1".repeat(64)],
        },
    ],
} as const satisfies DockerOverview;

const databaseOverview = {
    checkedAtMs: observedAtMs,
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
                sizeBytes: 6 * 1024 ** 3,
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
                sizeBytes: 2 * 1024 ** 3,
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
                assessedPhysicalBytes: 6 * 1024 ** 3,
                assessmentComplete: true,
                estimatedReclaimableBytes: 5 * 1024 ** 3,
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
            totalDatabaseSizeBytes: 8 * 1024 ** 3,
            unavailableDatabaseCount: 0,
        },
        tableHealth: [
            {
                assessment: "assessed",
                database: "mira_app",
                deadTuplePercent: 25,
                deadTuples: 2000,
                estimatedReclaimableBytes: 5 * 1024 ** 3,
                lastAutoanalyzeAtMs: observedAtMs - 1000,
                lastAutovacuumAtMs: observedAtMs - 2000,
                liveTuples: 8000,
                physicalBytes: 6 * 1024 ** 3,
                schema: "public",
                table: "events",
            },
        ],
        torrentCounts: {
            bitmagnet: { count: 125_000, state: "available" },
            comet: { state: "unavailable" },
        },
    },
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
            backupInventory: { reason: "inventory-unavailable", state: "unavailable" },
            maintenance: { reason: "maintenance-unavailable", state: "unavailable" },
            restoreVerification: {
                reason: "verification-unavailable",
                state: "unavailable",
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

const logSources = {
    observedAtMs,
    sources: [
        {
            availability: "available",
            group: "dashboard",
            id: "dashboard.web",
            label: "Dashboard web",
            modifiedAtMs: observedAtMs,
            sizeBytes: 2048,
        },
        {
            availability: "available",
            group: "openclaw",
            id: "openclaw.gateway",
            label: "OpenClaw Gateway",
            modifiedAtMs: observedAtMs,
            sizeBytes: 4096,
        },
    ],
} as const satisfies ListLogSourcesOutput;

const logMaintenance = {
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
            state: "queueable",
        },
        {
            id: "host-apport",
            label: "Host Apport log",
            scope: "host",
            state: "queueable",
        },
        {
            id: "host-dpkg",
            label: "Host package log",
            scope: "host",
            state: "queueable",
        },
        {
            id: "host-rsyslog",
            label: "Host system logs",
            scope: "host",
            state: "queueable",
        },
    ],
} as const satisfies LogMaintenanceStatusOutput;

const queueSummary = {
    activeResourceClasses: ["light"],
    control: { claimingPaused: false, updatedAtMs: observedAtMs, version: 1 },
    oldestQueuedAtMs: observedAtMs - 60_000,
    stateCounts: {
        cancelled: 0,
        failed: 1,
        queued: 2,
        running: 1,
        succeeded: 12,
        "timed-out": 0,
    },
    workers: [],
} satisfies ListJobRunsResult["summary"];
const jobs = { runs: [], summary: queueSummary } satisfies ListJobRunsResult;

const serviceActions = {
    actions: [
        { availability: "unavailable", id: "dashboard-restart" },
        { availability: "unavailable", id: "dashboard-stack-restart" },
        { availability: "unavailable", id: "openclaw-cleanup" },
        { availability: "unavailable", id: "openclaw-restart" },
        { availability: "unavailable", id: "openclaw-update" },
        { availability: "unavailable", id: "system-cleanup" },
        { availability: "unavailable", id: "system-restart" },
        { availability: "unavailable", id: "system-update" },
        { availability: "unavailable", id: "worker-restart" },
    ],
    observedAtMs,
} as const satisfies GetServiceActionsStatusResult;

const agentConfiguration = {
    agents: [
        {
            description: "Coordinates Dashboard work.",
            displayName: "Mira",
            id: "main",
            role: "primary",
        },
    ],
} as const satisfies AgentConfiguration;

const notifications = {
    notifications: [
        {
            id: "019fe300-0000-7000-8000-000000000041",
            incidentGeneration: 1,
            incidentId: "019fe300-0000-7000-8000-000000000051",
            kind: "heartbeat",
            message: "One reviewed notification is still unread.",
            occurredAtMs: observedAtMs,
            severity: "warning",
            source: "monitor",
            title: "Overview notification",
        },
    ],
    readCount: 8,
    unreadCount: 1,
} as const satisfies ListNotificationsResult;

const queuedRefresh = {
    actionKey: "cache.refresh.system-host",
    attemptCount: 0,
    attemptLimit: 3,
    availableAtMs: observedAtMs,
    cancellationPolicy: "cooperative",
    displayName: "Refresh system host cache",
    eventCount: 1,
    id: refreshRunId,
    priority: 0,
    queuedAtMs: observedAtMs,
    resourceClass: "light",
    resourceKeys: ["cache.system.host"],
    retrySafe: true,
    scheduledJobId: "cache.system-host",
    scheduledJobVersion: 1,
    state: "queued",
    stateVersion: 1,
    timeoutMs: 60_000,
    triggerType: "manual",
    updatedAtMs: observedAtMs,
} as const satisfies JobRunSummary;

const attentionLogMaintenance = {
    ...logMaintenance,
    policies: logMaintenance.policies.map((policy) =>
        policy.id === "docker-managed"
            ? {
                  ...policy,
                  lastRun: {
                      run: {
                          ...queuedRefresh,
                          actionKey: "maintenance.rotate-logs",
                          attemptCount: 1,
                          availableAtMs: observedAtMs - 3000,
                          displayName: "Rotate managed logs",
                          eventCount: 4,
                          finishedAtMs: observedAtMs,
                          firstStartedAtMs: observedAtMs - 2000,
                          id: "019fe000-0000-7000-8000-000000000007",
                          lastAttemptStartedAtMs: observedAtMs - 2000,
                          queuedAtMs: observedAtMs - 3000,
                          resourceKeys: ["maintenance.logs"],
                          state: "failed",
                          stateVersion: 3,
                          terminalCode: "maintenance.failed",
                          terminalMessage: "Maintenance needs operator attention.",
                          updatedAtMs: observedAtMs,
                      },
                  },
              }
            : policy
    ),
} satisfies LogMaintenanceStatusOutput;

function overviewFixtures(
    overrides: {
        readonly mutations?: DashboardStoryFixtures["mutations"];
        readonly queries?: Readonly<Record<string, DashboardStoryFixtureValue>>;
    } = {}
): DashboardStoryFixtures {
    const entries = new Map<string, CacheEntry>(
        cacheEntries.map((entry) => [entry.key, entry])
    );
    return {
        mutations: overrides.mutations,
        queries: {
            "agents.getConfiguration": dashboardStoryValue(agentConfiguration),
            "agents.listStatuses": dashboardStoryValue({
                statuses: [
                    {
                        agentId: "main",
                        currentTask: "Finish the Greenfield rewrite",
                        freshness: "fresh",
                        gatewayAvailability: "active",
                        hasActiveRun: true,
                        lastActivityAtMs: observedAtMs,
                        lastSeenAtMs: observedAtMs,
                        observedAtMs,
                        sessionKey: "agent:main:main",
                        startedAtMs: observedAtMs - 60_000,
                        state: "working",
                    },
                ],
            }),
            "backups.getKopiaStatus": dashboardStoryValue(kopiaStatus),
            "backups.getWalgStatus": dashboardStoryValue(walgStatus),
            "cache.getEntry": dashboardStoryResolver((input) => {
                const key =
                    typeof input === "object" && input !== null && "key" in input
                        ? String(input.key)
                        : "";
                const entry = entries.get(key);
                if (entry === undefined) throw new TypeError("Safe missing entry");
                return entry;
            }),
            "cache.getStatus": dashboardStoryValue(cacheStatus),
            "database.overview": dashboardStoryValue(databaseOverview),
            "docker.overview": dashboardStoryValue(dockerOverview),
            "incidents.list": dashboardStoryValue({
                incidents: [
                    {
                        fingerprint: "d".repeat(64),
                        firstSeenAtMs: observedAtMs - 10_000,
                        generation: 1,
                        id: "019fe300-0000-7000-8000-000000000051",
                        kind: "filesystem",
                        lastSeenAtMs: observedAtMs,
                        monitorKey: "ops-check",
                        occurrenceCount: 2,
                        severity: "warning",
                        state: "active",
                        title: "Overview active incident",
                    },
                ],
            }),
            "jobs.listRuns": dashboardStoryValue(jobs),
            "logs.listSources": dashboardStoryValue(logSources),
            "logs.maintenanceStatus": dashboardStoryValue(logMaintenance),
            "notifications.list": dashboardStoryValue(notifications),
            "reports.list": dashboardStoryValue({
                reports: [
                    {
                        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                        kind: "heartbeat",
                        occurredAtMs: observedAtMs,
                        source: "monitor",
                        status: "warning",
                        summary: "One bounded overview summary.",
                        title: "Overview heartbeat",
                    },
                ],
            }),
            "serviceActions.getStatus": dashboardStoryValue(serviceActions),
            "system.metrics": dashboardStoryValue(systemMetrics),
            "tasks.list": dashboardStoryValue({
                tasks: [
                    {
                        assignee: "mira-2026",
                        createdAtMs: observedAtMs - 3000,
                        id: "019fe300-0000-7000-8000-000000000031",
                        labels: ["rewrite"],
                        priority: "high",
                        status: "in-progress",
                        title: "Finish the Greenfield rewrite",
                        updatedAtMs: observedAtMs,
                        version: 2,
                    },
                ],
            }),
            ...overrides.queries,
        },
    };
}

const emptyCacheStatus = {
    entries: [],
    generatedAtMs: observedAtMs,
    totalCount: 0,
    truncated: false,
} satisfies CacheStatusResult;

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FreshPopulated: Story = {
    args: { fixtures: overviewFixtures(), route: "/" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole(
                "heading",
                { name: "Durable operations" },
                { timeout: 5000 }
            )
        ).toBeVisible();
        await expect(canvas.getByRole("heading", { name: "Chat runtime" })).toBeVisible();
        await expect(
            canvas.getByRole("heading", { name: "HTTP procedures" })
        ).toBeVisible();
        await expect(
            await canvas.findByText(/1 images · 512 MiB/u, {}, { timeout: 5000 })
        ).toBeVisible();
        await expect(
            await canvas.findByText(/PgBouncer 10 clients/u, {}, { timeout: 5000 })
        ).toBeVisible();
        await expect(
            await canvas.findByRole(
                "list",
                { name: "Log maintenance policies" },
                { timeout: 5000 }
            )
        ).toBeVisible();
    },
};

export const Empty: Story = {
    args: {
        fixtures: overviewFixtures({
            queries: {
                "agents.listStatuses": dashboardStoryValue({
                    statuses: [
                        {
                            agentId: "main",
                            freshness: "unavailable",
                            gatewayAvailability: "disconnected",
                            state: "idle",
                        },
                    ],
                } satisfies ListAgentStatusesResult),
                "cache.getStatus": dashboardStoryValue(emptyCacheStatus),
                "incidents.list": dashboardStoryValue({ incidents: [] }),
                "notifications.list": dashboardStoryValue({
                    notifications: [],
                    readCount: 0,
                    unreadCount: 0,
                }),
                "reports.list": dashboardStoryValue({ reports: [] }),
                "tasks.list": dashboardStoryValue({ tasks: [] }),
            },
        }),
        route: "/",
    },
};

export const PartialUnavailable: Story = {
    args: {
        fixtures: overviewFixtures({
            queries: {
                "backups.getKopiaStatus": dashboardStoryFailure(
                    new TypeError("Safe Kopia story failure")
                ),
                "docker.overview": dashboardStoryFailure(
                    new TypeError("Safe Docker story failure")
                ),
                "logs.maintenanceStatus": dashboardStoryFailure(
                    new TypeError("Safe maintenance story failure")
                ),
                "system.metrics": dashboardStoryValue({
                    ...systemMetrics,
                    application: {
                        ...systemMetrics.application,
                        cache: { state: "unavailable" },
                        realtime: { state: "unavailable" },
                    },
                }),
            },
        }),
        route: "/",
    },
};

export const ApplicationUnavailable: Story = {
    args: {
        fixtures: overviewFixtures({
            queries: {
                "system.metrics": dashboardStoryValue({
                    ...systemMetrics,
                    application: unavailableStorySystemApplicationMetrics,
                }),
            },
        }),
        route: "/",
    },
};

export const LogMaintenanceAttention: Story = {
    args: {
        fixtures: overviewFixtures({
            queries: {
                "logs.maintenanceStatus": dashboardStoryValue(attentionLogMaintenance),
            },
        }),
        route: "/",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByText("Last failed", {}, { timeout: 5000 })
        ).toBeVisible();
    },
};

export const LastKnownGood: Story = {
    args: {
        fixtures: overviewFixtures({
            queries: {
                "backups.getKopiaStatus": dashboardStoryValue({
                    ...kopiaStatus,
                    staleSinceMs: observedAtMs,
                    state: "last-known-good",
                } satisfies KopiaBackupStatus),
                "backups.getWalgStatus": dashboardStoryValue({
                    ...walgStatus,
                    staleSinceMs: observedAtMs,
                    state: "last-known-good",
                } satisfies WalgBackupStatus),
                "cache.getEntry": dashboardStoryResolver((input) => {
                    const key =
                        typeof input === "object" && input !== null && "key" in input
                            ? String(input.key)
                            : "";
                    const entry = cacheEntries.find((candidate) => candidate.key === key);
                    if (entry === undefined) throw new TypeError("Safe missing entry");
                    return { ...entry, freshness: "stale" };
                }),
                "system.metrics": dashboardStoryValue({
                    ...systemMetrics,
                    freshness: "stale",
                }),
            },
        }),
        route: "/",
    },
};

export const RefreshQueued: Story = {
    args: {
        fixtures: overviewFixtures({
            mutations: {
                "cache.refreshEntry": dashboardStoryValue(queuedRefresh),
            },
        }),
        route: "/",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "View system.host" })
        );
        await userEvent.click(await canvas.findByRole("button", { name: "Refresh now" }));
        await expect(
            await canvas.findByText(/Refresh requested. Saved data updates/u)
        ).toBeVisible();
    },
};
