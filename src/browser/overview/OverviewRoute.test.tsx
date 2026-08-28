import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";

import type {
    AgentConfiguration,
    AgentStatusProjection,
} from "../../contracts/agentModel.ts";
import type { ListAgentStatusesResult } from "../../contracts/agents.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    BackupRequestOperationResult,
    KopiaBackupStatus,
    WalgBackupStatus,
} from "../../contracts/backups.ts";
import type {
    CacheEntry,
    CacheEntryStatus,
    CacheStatusResult,
    RefreshCacheEntryInput,
} from "../../contracts/cache.ts";
import type { DatabaseOverview } from "../../contracts/database.ts";
import type { DockerOverview } from "../../contracts/docker.ts";
import type { ListIncidentsResult } from "../../contracts/incidents.ts";
import type { JobRunSummary } from "../../contracts/jobModel.ts";
import type { JobQueueSummary, ListJobRunsResult } from "../../contracts/jobs.ts";
import type {
    ListLogSourcesOutput,
    LogMaintenanceStatusOutput,
} from "../../contracts/logs.ts";
import type {
    IncidentSummary,
    NotificationRecord,
    ReportSummary,
} from "../../contracts/monitoring.ts";
import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import type { ListReportsResult } from "../../contracts/reports.ts";
import type { GetServiceActionsStatusResult } from "../../contracts/serviceActions.ts";
import {
    type OpenClawUpdateStatus,
    type SystemMetrics,
    openClawUpdateCacheKey,
    openClawUpdateCacheSchemaId,
    openClawUpdateCacheSource,
    openClawUpdateCacheTtlMs,
} from "../../contracts/system.ts";
import type { TaskSummary } from "../../contracts/taskModel.ts";
import type { ListTasksResult } from "../../contracts/tasks.ts";
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
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { logMaintenanceQueryKey } from "../logs/logQueries.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { observedSystemApplicationMetrics } from "../test/systemMetrics.ts";

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
        email: "operator@example.com",
        username: "operator",
    },
};

const systemMetrics = Object.freeze({
    application: observedSystemApplicationMetrics(timestampMs),
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

const weatherEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAtMs: timestampMs + 90 * 60_000,
    freshness: "stale",
    key: "weather.spydeberg",
    lastAttemptAtMs: timestampMs,
    lastAttemptDurationMs: 120,
    lastAttemptNumber: 1,
    lastAttemptRunId: "019fe000-0000-7000-8000-000000000004",
    lastAttemptStatus: "succeeded",
    lastSuccessAtMs: timestampMs,
    manualRunAvailable: true,
    metadata: {},
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
        observedAtMs: timestampMs,
        temperatureC: 15,
        timezone: "Europe/Oslo",
        windKilometresPerHour: 9,
    },
    schemaId: "weather.spydeberg.v1",
    source: "weather.open-meteo",
    updatedAtMs: timestampMs,
} as const satisfies CacheEntry);

const quotaEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAtMs: timestampMs + 60 * 60_000,
    freshness: "stale",
    key: "quotas.summary",
    lastAttemptAtMs: timestampMs,
    lastAttemptDurationMs: 120,
    lastAttemptNumber: 1,
    lastAttemptRunId: "019fe000-0000-7000-8000-000000000005",
    lastAttemptStatus: "succeeded",
    lastSuccessAtMs: timestampMs,
    manualRunAvailable: true,
    metadata: {},
    payload: {
        observedAtMs: timestampMs,
        providers: [
            {
                id: "elevenlabs",
                label: "ElevenLabs",
                remainingPercent: 72,
                resetsAtMs: timestampMs + 24 * 60 * 60_000,
                status: "available",
            },
            {
                id: "openai",
                label: "OpenAI / Codex",
                status: "available",
                usedPercent: 34,
                windows: [
                    {
                        resetsAtMs: timestampMs + 60_000,
                        usedPercent: 0,
                        windowDurationMinutes: 300,
                    },
                    {
                        resetsAtMs: timestampMs + 4 * 24 * 60 * 60_000,
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
                        resetsAtMs: timestampMs + 2 * 60_000,
                        usedPercent: 36,
                        windowDurationMinutes: 300,
                    },
                    {
                        regenerationPercent: 2,
                        resetsAtMs: timestampMs + 7 * 24 * 60 * 60_000,
                        usedPercent: 28,
                        windowDurationMinutes: 10_080,
                    },
                ],
            },
        ],
    },
    schemaId: "quotas.summary.v2",
    source: "quota.providers",
    updatedAtMs: timestampMs,
} as const satisfies CacheEntry);

const gitEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAtMs: timestampMs + 5 * 60_000,
    freshness: "stale",
    key: "git.workspace",
    lastAttemptAtMs: timestampMs,
    lastAttemptDurationMs: 120,
    lastAttemptNumber: 1,
    lastAttemptRunId: "019fe000-0000-7000-8000-000000000006",
    lastAttemptStatus: "succeeded",
    lastSuccessAtMs: timestampMs,
    manualRunAvailable: true,
    metadata: {},
    payload: {
        observedAtMs: timestampMs,
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
                changedFileCount: 2,
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
    updatedAtMs: timestampMs,
} as const satisfies CacheEntry);

const overviewProviderEntries = new Map<string, CacheEntry>([
    [weatherEntry.key, weatherEntry],
    [quotaEntry.key, quotaEntry],
    [gitEntry.key, gitEntry],
]);

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

const kopiaBackupStatus = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: timestampMs,
    state: "unavailable",
    type: "kopia",
} as const satisfies KopiaBackupStatus);

const backupRunId = "019fe000-0000-7000-8000-000000000008";
const freshKopiaBackupStatus = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: timestampMs,
    payload: {
        backupCount: 8,
        healthy: true,
        observedAtMs: timestampMs,
        providerIdle: true,
        sourceRevision: "d".repeat(64),
        sources: [
            {
                health: "current",
                id: "primary",
                latestCompletedAtMs: timestampMs,
                snapshots: Array.from({ length: 8 }, (_, index) => ({
                    completedAtMs: timestampMs - index,
                    retentionReasons: [],
                })),
                snapshotCount: 8,
            },
        ],
        type: "kopia",
    },
    state: "fresh",
} as const satisfies KopiaBackupStatus);

const queuedKopiaBackup = Object.freeze({
    jobRunId: backupRunId,
    operation: "run",
    queued: true,
    type: "kopia",
} as const satisfies BackupRequestOperationResult);

const walgBackupStatus = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: timestampMs,
    state: "unavailable",
    type: "walg",
} as const satisfies WalgBackupStatus);

const dockerOverview = Object.freeze({
    checkedAtMs: timestampMs,
    state: "unavailable",
} as const satisfies DockerOverview);

const databaseOverview = Object.freeze({
    checkedAtMs: timestampMs,
    postgresql: { state: "unavailable" },
    sqlite: { state: "unavailable" },
} as const satisfies DatabaseOverview);

const detailedDockerOverview = Object.freeze({
    checkedAtMs: timestampMs,
    containers: [
        {
            createdAtMs: timestampMs - 60_000,
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
            startedAtMs: timestampMs - 50_000,
            state: "running",
        },
    ],
    images: [
        {
            createdAtMs: timestampMs - 60_000,
            id: `sha256:${"2".repeat(64)}`,
            references: ["example/dashboard:1.0.0"],
            sizeBytes: 512 * 1024 ** 2,
            usedByContainerIds: ["1".repeat(64)],
        },
    ],
    observedAtMs: timestampMs,
    sourceRevision: "a".repeat(64),
    state: "fresh",
    updaterEvents: [],
    updaterServices: [],
    volumes: [
        {
            createdAtMs: timestampMs - 60_000,
            driver: "local",
            name: "dashboard-data",
            scope: "local",
            sizeBytes: 2 * 1024 ** 3,
            usedByContainerIds: ["1".repeat(64)],
        },
    ],
} as const satisfies DockerOverview);

const detailedDatabaseOverview = Object.freeze({
    checkedAtMs: timestampMs,
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
        observedAtMs: timestampMs,
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
                meanExecutionMs: 1008.25,
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
                lastAutoanalyzeAtMs: timestampMs - 1000,
                lastAutovacuumAtMs: timestampMs - 2000,
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
            maintenance: {
                enabled: true,
                latestSuccessfulAtMs: timestampMs - 60_000,
                nextRunAtMs: timestampMs + 86_400_000,
                observedAtMs: timestampMs,
                runs: [
                    {
                        finishedAtMs: timestampMs - 60_000,
                        queuedAtMs: timestampMs - 120_000,
                        runId: "019fc968-1a9b-7765-8f1b-d5b863b0e7c0",
                        startedAtMs: timestampMs - 90_000,
                        state: "succeeded",
                    },
                ],
                schedule: { timeOfDay: "02:40", timeZone: "Europe/Oslo" },
                state: "available",
            },
            restoreVerification: {
                reason: "verification-unavailable",
                state: "unavailable",
            },
        },
        migrations: { applied: 12, available: 12, current: true },
        observedAtMs: timestampMs,
        state: "fresh",
        storage: {
            databaseBytes: 64 * 1024 ** 2,
            freeBytes: 4 * 1024 ** 2,
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
            storageBytes: 68 * 1024 ** 2,
            walBytes: 4 * 1024 ** 2 - 32_768,
        },
    },
} as const satisfies DatabaseOverview);

const logSources = Object.freeze({
    observedAtMs: timestampMs,
    sources: [
        {
            availability: "available",
            group: "dashboard",
            id: "dashboard.web",
            label: "Dashboard web",
            modifiedAtMs: timestampMs,
            sizeBytes: 2048,
        },
        {
            availability: "missing",
            group: "openclaw",
            id: "openclaw.gateway",
            label: "OpenClaw Gateway",
        },
    ],
} as const satisfies ListLogSourcesOutput);

const logMaintenance = Object.freeze({
    observedAtMs: timestampMs,
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
} as const satisfies LogMaintenanceStatusOutput);

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

const attentionLogMaintenance = Object.freeze({
    ...logMaintenance,
    policies: logMaintenance.policies.map((policy) =>
        policy.id === "docker-managed"
            ? {
                  ...policy,
                  lastRun: {
                      run: {
                          ...failedRefresh,
                          actionKey: "maintenance.rotate-logs",
                          displayName: "Rotate managed logs",
                          id: "019fe000-0000-7000-8000-000000000007",
                          resourceKeys: ["maintenance.logs"],
                      },
                  },
              }
            : policy
    ),
} satisfies LogMaintenanceStatusOutput);

const overviewReport = Object.freeze({
    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
    kind: "heartbeat",
    occurredAtMs: timestampMs,
    source: "monitor",
    status: "warning",
    summary: "One bounded overview summary.",
    title: "Overview heartbeat",
} as const satisfies ReportSummary);

const reportPage = Object.freeze({
    reports: [overviewReport],
} as const satisfies ListReportsResult);

const overviewQueueSummary = Object.freeze({
    activeResourceClasses: ["light"],
    control: { claimingPaused: false, updatedAtMs: timestampMs, version: 1 },
    oldestQueuedAtMs: timestampMs - 60_000,
    stateCounts: {
        cancelled: 0,
        failed: 1,
        queued: 2,
        running: 1,
        succeeded: 12,
        "timed-out": 0,
    },
    workers: [],
} satisfies JobQueueSummary);

const jobRunPage = Object.freeze({
    runs: [],
    summary: overviewQueueSummary,
} satisfies ListJobRunsResult);

const serviceActionsStatus = Object.freeze({
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
    observedAtMs: timestampMs,
} satisfies GetServiceActionsStatusResult);

const overviewTask = Object.freeze({
    assignee: "mira-2026",
    createdAtMs: timestampMs - 3000,
    id: "019fe300-0000-7000-8000-000000000031",
    labels: ["rewrite"],
    number: 232,
    priority: "high",
    status: "in-progress",
    title: "Complete the core operations overview",
    updatedAtMs: timestampMs,
    version: 2,
} as const satisfies TaskSummary);

const overviewTaskPage = Object.freeze({
    tasks: [overviewTask],
} satisfies ListTasksResult);

const agentConfiguration = Object.freeze({
    agents: [
        {
            description: "Primary Dashboard operator",
            displayName: "Mira",
            id: "main",
            role: "primary",
        },
        {
            description: "Focused research specialist",
            displayName: "Researcher",
            id: "researcher",
            role: "specialist",
        },
    ],
} as const satisfies AgentConfiguration);

const mainAgentStatus = Object.freeze({
    agentId: "main",
    currentTask: "Complete the core operations overview",
    freshness: "fresh",
    gatewayAvailability: "active",
    hasActiveRun: true,
    lastActivityAtMs: timestampMs,
    lastSeenAtMs: timestampMs,
    observedAtMs: timestampMs,
    sessionKey: "agent:main:main",
    startedAtMs: timestampMs - 60_000,
    state: "working",
} as const satisfies AgentStatusProjection);

const agentStatusPage = Object.freeze({
    statuses: [
        mainAgentStatus,
        {
            agentId: "researcher",
            freshness: "unavailable",
            gatewayAvailability: "disconnected",
            lastActivityAtMs: timestampMs - 120_000,
            state: "idle",
        },
    ],
} as const satisfies ListAgentStatusesResult);

const overviewNotification = Object.freeze({
    id: "019fe300-0000-7000-8000-000000000041",
    incidentGeneration: 1,
    incidentId: "019fe300-0000-7000-8000-000000000051",
    kind: "heartbeat",
    message: "One reviewed notification is still unread.",
    occurredAtMs: timestampMs,
    severity: "warning",
    source: "monitor",
    title: "Overview notification",
} as const satisfies NotificationRecord);

const notificationPage = Object.freeze({
    notifications: [overviewNotification],
    readCount: 8,
    unreadCount: 3,
} satisfies ListNotificationsResult);

const overviewIncident = Object.freeze({
    fingerprint: "a".repeat(64),
    firstSeenAtMs: timestampMs - 10_000,
    generation: 1,
    id: "019fe300-0000-7000-8000-000000000051",
    kind: "filesystem",
    lastSeenAtMs: timestampMs,
    monitorKey: "ops-check",
    occurrenceCount: 2,
    severity: "warning",
    state: "active",
    title: "Overview active incident",
} as const satisfies IncidentSummary);

const incidentPage = Object.freeze({
    incidents: [overviewIncident],
} satisfies ListIncidentsResult);

const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

interface TransportCall {
    readonly input: unknown;
    readonly path: string;
}

interface OverviewTransportOptions {
    readonly backupMutationOutput?: BackupRequestOperationResult | Error;
    readonly cacheEntryOutputs?: readonly (CacheEntry | Error)[];
    readonly cacheStatusOutputs?: readonly (CacheStatusResult | Error)[];
    readonly databaseOverviewOutput?: DatabaseOverview;
    readonly dockerOverviewOutput?: DockerOverview;
    readonly jobOutputs?: readonly (ListJobRunsResult | Error)[];
    readonly kopiaBackupStatusOutput?: KopiaBackupStatus;
    readonly logMaintenanceOutputs?: readonly (LogMaintenanceStatusOutput | Error)[];
    readonly openClawUpdateStatus?: OpenClawUpdateStatus;
    readonly refreshOutputs?: readonly (JobRunSummary | Error)[];
    readonly reportOutputs?: readonly (ListReportsResult | Error)[];
    readonly systemMetricsOutputs?: readonly (SystemMetrics | Error)[];
    readonly walgBackupStatusOutput?: WalgBackupStatus;
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
    readonly #backupMutationOutput: BackupRequestOperationResult | Error;
    readonly #cacheEntryOutputs: readonly (CacheEntry | Error)[];
    readonly #cacheStatusOutputs: readonly (CacheStatusResult | Error)[];
    readonly #databaseOverviewOutput: DatabaseOverview;
    readonly #dockerOverviewOutput: DockerOverview;
    readonly #jobOutputs: readonly (ListJobRunsResult | Error)[];
    readonly #kopiaBackupStatusOutput: KopiaBackupStatus;
    readonly #logMaintenanceOutputs: readonly (LogMaintenanceStatusOutput | Error)[];
    readonly #openClawUpdateStatus: OpenClawUpdateStatus;
    readonly #refreshOutputs: readonly (JobRunSummary | Error)[];
    readonly #reportOutputs: readonly (ListReportsResult | Error)[];
    readonly #systemMetricsOutputs: readonly (SystemMetrics | Error)[];
    readonly #walgBackupStatusOutput: WalgBackupStatus;
    readonly mutationCalls: TransportCall[] = [];
    readonly queryCalls: TransportCall[] = [];

    constructor(options: OverviewTransportOptions = {}) {
        this.#backupMutationOutput = options.backupMutationOutput ?? queuedKopiaBackup;
        this.#cacheEntryOutputs = options.cacheEntryOutputs ?? [hostEntry];
        this.#cacheStatusOutputs = options.cacheStatusOutputs ?? [cacheStatus];
        this.#databaseOverviewOutput = options.databaseOverviewOutput ?? databaseOverview;
        this.#dockerOverviewOutput = options.dockerOverviewOutput ?? dockerOverview;
        this.#jobOutputs = options.jobOutputs ?? [jobRunPage];
        this.#kopiaBackupStatusOutput =
            options.kopiaBackupStatusOutput ?? kopiaBackupStatus;
        this.#logMaintenanceOutputs = options.logMaintenanceOutputs ?? [logMaintenance];
        this.#openClawUpdateStatus = options.openClawUpdateStatus ?? {
            available: false,
            channel: "beta",
            installedVersion: "2026.8.1-beta.2",
            latestVersion: "2026.8.1-beta.2",
            state: "observed",
        };
        this.#refreshOutputs = options.refreshOutputs ?? [queuedRefresh];
        this.#reportOutputs = options.reportOutputs ?? [reportPage];
        this.#systemMetricsOutputs = options.systemMetricsOutputs ?? [systemMetrics];
        this.#walgBackupStatusOutput = options.walgBackupStatusOutput ?? walgBackupStatus;
    }

    mutation(path: string, input?: unknown): Promise<unknown> {
        const callIndex = this.mutationCalls.filter((call) => call.path === path).length;
        this.mutationCalls.push({ input, path });
        if (path === "cache.refreshEntry") {
            return transportOutput(this.#refreshOutputs, callIndex, path);
        }
        if (path === "backups.runKopia") {
            return this.#backupMutationOutput instanceof Error
                ? Promise.reject(this.#backupMutationOutput)
                : Promise.resolve(this.#backupMutationOutput);
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
            case "backups.getKopiaStatus": {
                return Promise.resolve(this.#kopiaBackupStatusOutput);
            }
            case "backups.getWalgStatus": {
                return Promise.resolve(this.#walgBackupStatusOutput);
            }
            case "database.overview": {
                return Promise.resolve(this.#databaseOverviewOutput);
            }
            case "docker.overview": {
                return Promise.resolve(this.#dockerOverviewOutput);
            }
            case "agents.getConfiguration": {
                return Promise.resolve(agentConfiguration);
            }
            case "agents.listStatuses": {
                return Promise.resolve(agentStatusPage);
            }
            case "cache.getEntry": {
                const key = (input as { readonly key?: unknown } | undefined)?.key;
                if (typeof key === "string") {
                    if (key === openClawUpdateCacheKey) {
                        return Promise.resolve({
                            ...hostEntry,
                            expiresAtMs: timestampMs + openClawUpdateCacheTtlMs,
                            key,
                            payload: this.#openClawUpdateStatus,
                            schemaId: openClawUpdateCacheSchemaId,
                            source: openClawUpdateCacheSource,
                        });
                    }
                    const providerEntry = overviewProviderEntries.get(key);
                    if (providerEntry !== undefined)
                        return Promise.resolve(providerEntry);
                }
                const providerCallCount = this.queryCalls.filter(
                    (call) =>
                        call.path === path &&
                        (call.input as { readonly key?: unknown } | undefined)?.key ===
                            "system.host"
                ).length;
                return transportOutput(
                    this.#cacheEntryOutputs,
                    providerCallCount - 1,
                    path
                );
            }
            case "cache.getStatus": {
                return transportOutput(this.#cacheStatusOutputs, callIndex, path);
            }
            case "jobs.listRuns": {
                return transportOutput(this.#jobOutputs, callIndex, path);
            }
            case "logs.listSources": {
                return Promise.resolve(logSources);
            }
            case "logs.maintenanceStatus": {
                return transportOutput(this.#logMaintenanceOutputs, callIndex, path);
            }
            case "incidents.list": {
                return Promise.resolve(incidentPage);
            }
            case "notifications.list": {
                return Promise.resolve(notificationPage);
            }
            case "reports.list": {
                return transportOutput(this.#reportOutputs, callIndex, path);
            }
            case "serviceActions.getStatus": {
                return Promise.resolve(serviceActionsStatus);
            }
            case "system.metrics": {
                return transportOutput(this.#systemMetricsOutputs, callIndex, path);
            }
            case "tasks.list": {
                return Promise.resolve(overviewTaskPage);
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

async function renderOverview(transport: OverviewTransport) {
    const queryClient = createDashboardQueryClient();
    queryClients.push(queryClient);
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    collectionRegistries.push(collections);
    const router = createDashboardRouter(createMemoryHistory({ initialEntries: ["/"] }));
    await act(async () => {
        await router.load();
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
        await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    });
    return { queryClient, user: userEvent.setup() };
}

describe("Dashboard operational overview foundation", () => {
    test("surfaces an available OpenClaw release on the dashboard", async () => {
        await renderOverview(
            new OverviewTransport({
                openClawUpdateStatus: {
                    available: true,
                    channel: "beta",
                    installedVersion: "2026.8.1-beta.2",
                    latestVersion: "2026.8.1-beta.3",
                    state: "observed",
                },
            })
        );

        expect(
            await screen.findByText(
                "OpenClaw 2026.8.1-beta.3 is available. Installed: 2026.8.1-beta.2 (beta channel)."
            )
        ).toBeTruthy();
    });

    test("shows an OpenRouter account balance without monthly usage", async () => {
        const providers = quotaEntry.payload.providers.map((provider) => {
            if (provider.id !== "openrouter") return provider;
            const { periodUsage: _periodUsage, ...withoutMonthlyUsage } = provider;
            return withoutMonthlyUsage;
        });
        overviewProviderEntries.set(quotaEntry.key, {
            ...quotaEntry,
            payload: { ...quotaEntry.payload, providers },
        });
        try {
            await renderOverview(new OverviewTransport());

            expect(await screen.findByText("$4.26 balance")).toBeTruthy();
            expect(screen.queryByText(/\$0\.1344 this month/u)).toBeNull();
        } finally {
            overviewProviderEntries.set(quotaEntry.key, quotaEntry);
        }
    });

    test("loads bounded status before exact payload and queues refresh as a job", async () => {
        const transport = new OverviewTransport();
        const { user } = await renderOverview(transport);

        expect(
            await screen.findByRole("heading", { level: 1, name: "Dashboard" })
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", { level: 2, name: "Host metrics" })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", { level: 2, name: "Service actions" })
        ).toBeTruthy();

        const cpuHeading = screen.getByRole("heading", { level: 3, name: "CPU" });
        const cpuCard = cpuHeading.closest("section");
        expect(cpuCard).toBeTruthy();
        expect(within(cpuCard as HTMLElement).getByText("50%")).toBeTruthy();
        expect(within(cpuCard as HTMLElement).getByText("2, 1, 0.5")).toBeTruthy();
        const memoryHeading = screen.getByRole("heading", { level: 3, name: "Memory" });
        const memoryCard = memoryHeading.closest("section");
        expect(memoryCard).toBeTruthy();
        expect(
            within(memoryCard as HTMLElement).getByText("6.0 GiB of 8.0 GiB")
        ).toBeTruthy();
        expect(screen.getByText("12.3 Mbit/s")).toBeTruthy();
        expect(screen.getByText("3 subscribers")).toBeTruthy();
        const hostMetrics = screen.getByLabelText("Host metrics");
        expect(
            within(hostMetrics).getByRole("heading", { level: 3, name: "Weather" })
        ).toBeTruthy();
        const weatherCard = within(hostMetrics)
            .getByRole("heading", { level: 3, name: "Weather" })
            .closest("section");
        expect(weatherCard).toBeTruthy();
        const weatherContent = within(weatherCard as HTMLElement);
        expect(weatherContent.getByText("Spydeberg")).toBeTruthy();
        expect(
            weatherContent.getByText("Showing the last known good weather result.")
        ).toBeTruthy();
        expect(weatherContent.getByText("15°C")).toBeTruthy();
        expect(weatherContent.getByText("Feels")).toBeTruthy();
        expect(weatherContent.getByText("13°")).toHaveClass("whitespace-nowrap");
        expect(weatherContent.getByText("Humidity")).toBeTruthy();
        expect(weatherContent.getByText("Wind")).toBeTruthy();
        expect(weatherContent.getByText("68%")).toBeTruthy();
        expect(weatherContent.getByText("9 km/h")).toBeTruthy();
        expect(weatherContent.getByText("Thu")).toBeTruthy();
        expect(weatherContent.queryByText("Today")).toBeNull();
        expect(
            screen.getByRole("heading", { level: 3, name: "Provider quota" })
        ).toBeTruthy();
        expect(screen.getByText("72% remaining")).toBeTruthy();
        expect(screen.getByText("$0.866 left / $1 quota")).toBeTruthy();
        expect(screen.getByText("$4.26 balance · $0.1344 this month")).toBeTruthy();
        expect(
            screen.getByText("Showing the last known good quota result.")
        ).toBeTruthy();
        expect(screen.getByText("5h 100% left · weekly 66% left")).toBeTruthy();
        expect(
            screen.getByText(
                /^Resets: 5h \d{2}:\d{2} · weekly \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/u
            )
        ).toBeTruthy();
        expect(
            screen.getByText(
                (_content, element) =>
                    element?.tagName === "P" &&
                    /^Reset \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/u.test(
                        element.textContent ?? ""
                    )
            )
        ).toBeTruthy();
        expect(
            screen.getByText(
                /^Regen: 5h \d{2}:\d{2} \(\+5%\) · weekly \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} \(\+2%\)$/u
            )
        ).toBeTruthy();
        const managedGitHeading = screen.getByRole("heading", {
            level: 3,
            name: "Managed Git",
        });
        const managedGitCard = managedGitHeading.closest("section");
        expect(managedGitCard).toBeTruthy();
        expect(
            within(managedGitCard as HTMLElement).getByText("Last known good")
        ).toBeTruthy();
        expect(
            screen.getByRole("link", { name: "Open Mira Dashboard on GitHub" })
        ).toHaveAttribute("href", "https://github.com/rajohan/Mira-Dashboard");
        expect(
            screen.getByRole("link", { name: "Open Docker infrastructure on GitHub" })
        ).toHaveAttribute("href", "https://github.com/rajohan/stremio");
        expect(
            screen.getByRole("link", { name: "Open Mira Workspace on GitHub" })
        ).toHaveAttribute("href", "https://github.com/rajohan/Mira-Workspace");
        expect(screen.getByText("2 changed")).toBeTruthy();
        expect(screen.getByText("1 modified · 0 staged · 1 untracked")).toBeTruthy();
        const operationalSummaries = screen.getByRole("region", {
            name: "Operational summaries",
        });
        const webRuntime = screen.getByRole("heading", { name: "Web runtime" });
        expect(
            operationalSummaries.compareDocumentPosition(webRuntime) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(
            await screen.findByRole("region", { name: "Service summaries" })
        ).toBeTruthy();
        expect(screen.getByText("Docker inventory is unavailable.")).toBeTruthy();
        expect(screen.getByText("SQLite: Unavailable")).toBeTruthy();
        expect(screen.getByText("1 available")).toBeTruthy();
        expect(
            screen.getByRole("list", { name: "Log maintenance policies" })
        ).toBeTruthy();
        expect(screen.getByText("Managed application and container logs")).toBeTruthy();
        expect(screen.getByRole("link", { name: "View Docker" })).toHaveAttribute(
            "href",
            "/docker"
        );
        expect(await screen.findByRole("region", { name: "Backup status" })).toBeTruthy();
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Unfinished tasks",
            })
        ).toBeTruthy();
        expect(screen.getByText("Complete the core operations overview")).toBeTruthy();
        expect(screen.getByRole("link", { name: "View tasks" })).toHaveAttribute(
            "href",
            "/tasks"
        );
        expect(transport.queryCalls.filter(({ path }) => path === "tasks.list")).toEqual([
            {
                input: {
                    filters: { statuses: ["blocked", "in-progress", "todo"] },
                    limit: 100,
                },
                path: "tasks.list",
            },
        ]);
        expect(
            transport.queryCalls.filter(({ path }) => path.startsWith("agents."))
        ).toHaveLength(0);
        expect(
            transport.queryCalls.filter(({ path }) => path === "notifications.list")
        ).toEqual([{ input: { limit: 100 }, path: "notifications.list" }]);
        expect(
            await screen.findByRole("heading", { level: 2, name: "Active incidents" })
        ).toBeTruthy();
        expect(screen.getByText("Overview active incident")).toBeTruthy();
        expect(screen.getByRole("link", { name: "View incidents" })).toHaveAttribute(
            "href",
            "/incidents"
        );
        expect(
            transport.queryCalls.filter(({ path }) => path === "incidents.list")
        ).toEqual([
            {
                input: { filters: { states: ["active"] }, limit: 12 },
                path: "incidents.list",
            },
        ]);
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Dashboard background jobs",
            })
        ).toBeTruthy();
        expect(screen.getByText("Accepting new jobs")).toBeTruthy();
        expect(
            screen.getAllByRole("link", { name: "View Dashboard jobs" })
        ).not.toHaveLength(0);
        const jobSummaryCalls = transport.queryCalls.filter(
            ({ path }) => path === "jobs.listRuns"
        );
        expect(jobSummaryCalls).toContainEqual({
            input: { limit: 1 },
            path: "jobs.listRuns",
        });
        expect(jobSummaryCalls).toContainEqual({
            input: {
                filters: {
                    states: ["queued", "running"],
                    triggerTypes: ["manual"],
                },
                limit: 100,
            },
            path: "jobs.listRuns",
        });
        expect(
            transport.queryCalls.filter(({ path }) => path === "serviceActions.getStatus")
        ).toEqual([{ input: {}, path: "serviceActions.getStatus" }]);
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Recent reports",
            })
        ).toBeTruthy();
        expect(screen.getByText("Overview heartbeat")).toBeTruthy();
        expect(screen.getByRole("link", { name: "View reports" })).toHaveAttribute(
            "href",
            "/reports"
        );
        expect(
            await screen.findByRole("navigation", { name: "Saved data sources" })
        ).toBeTruthy();
        await waitFor(() =>
            expect(
                transport.queryCalls.filter(
                    ({ input, path }) =>
                        path === "cache.getEntry" &&
                        overviewProviderEntries.has(
                            (input as { readonly key: string }).key
                        )
                )
            ).toHaveLength(3)
        );
        expect(screen.getAllByText("Up to date").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);

        await user.click(screen.getByRole("button", { name: "View system.host" }));
        expect(
            await screen.findByRole("heading", { level: 3, name: "Saved payload" })
        ).toBeTruthy();
        expect(screen.getByLabelText("Saved payload JSON")).toHaveAttribute("readonly");
        expect(screen.getByText(/"hostname": "mira-vps"/u)).toBeTruthy();
        expect(screen.queryByText("never-render-this-metadata")).toBeNull();
        await waitFor(() =>
            expect(
                transport.queryCalls.filter(
                    ({ input, path }) =>
                        path === "cache.getEntry" &&
                        (input as { readonly key: string }).key === "system.host"
                )
            ).toHaveLength(1)
        );

        await user.click(screen.getByRole("button", { name: "Refresh now" }));
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
                "Refresh requested. Saved data updates when the background job finishes."
            )
        ).toBeTruthy();
        const queuedRunLink = screen.getByRole("link", { name: "View background job" });
        expect(queuedRunLink.getAttribute("href")).toContain(refreshRunId);
    });

    test("queues a fresh Kopia backup with a session-bound recovery identity", async () => {
        const transport = new OverviewTransport({
            kopiaBackupStatusOutput: freshKopiaBackupStatus,
        });
        const { user } = await renderOverview(transport);

        await screen.findByLabelText("Kopia backup");
        await user.click(screen.getByRole("button", { name: "Queue Kopia backup" }));

        await waitFor(() =>
            expect(
                transport.mutationCalls.filter(({ path }) => path === "backups.runKopia")
            ).toHaveLength(1)
        );
        const mutationInput = transport.mutationCalls.find(
            ({ path }) => path === "backups.runKopia"
        )?.input;
        expect(mutationInput).toEqual({
            confirmation: "run-kopia-backup",
            idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
            sourceRevision: freshKopiaBackupStatus.payload.sourceRevision,
        });
        expect(
            await screen.findByText("Kopia run queued. Runtime success is not assumed.")
        ).toBeTruthy();
    });

    test("marks a recent last-known-good metric sample without hiding cache data", async () => {
        const transport = new OverviewTransport({
            systemMetricsOutputs: [{ ...systemMetrics, freshness: "stale" }],
        });
        await renderOverview(transport);

        expect(
            await screen.findByText(
                "The latest check failed. Showing the most recent reading, which is no more than 30 seconds old."
            )
        ).toBeTruthy();
        expect(
            await screen.findByRole("navigation", { name: "Saved data sources" })
        ).toBeTruthy();
    });

    test("renders complete Docker, database, and log-maintenance summaries", async () => {
        const transport = new OverviewTransport({
            databaseOverviewOutput: detailedDatabaseOverview,
            dockerOverviewOutput: detailedDockerOverview,
            logMaintenanceOutputs: [attentionLogMaintenance],
        });
        await renderOverview(transport);

        expect(await screen.findByText(/1 images · 512 MiB/u)).toBeTruthy();
        expect(screen.getByText("0 unhealthy")).toBeTruthy();
        expect(screen.getByText(/1 volumes · 2\.0 GiB across 1 measured/u)).toBeTruthy();
        expect(
            screen.getByText(/SQLite 64 MiB database · 68 MiB total · 4\.0 MiB reusable/u)
        ).toBeTruthy();
        expect(
            screen.getByText(/PostgreSQL 8\.0 GiB · 10 connections · 97\.3% cache hit/u)
        ).toBeTruthy();
        expect(
            screen.getByText(/PgBouncer 10 clients · 6 servers · 1 waiting/u)
        ).toBeTruthy();
        expect(screen.getByText("Maintenance review")).toBeTruthy();
        expect(screen.getByText("Last failed")).toBeTruthy();
        const sqliteBackupCard = screen.getByLabelText("SQLite backup");
        expect(
            within(sqliteBackupCard)
                .getByRole("link", { name: "View job" })
                .getAttribute("href")
        ).toBe(
            "/jobs?runId=019fc968-1a9b-7765-8f1b-d5b863b0e7c0&scheduleId=database.sqlite-maintenance"
        );
    });

    test("identifies retained log-maintenance data after refresh failure", async () => {
        const transport = new OverviewTransport({
            logMaintenanceOutputs: [
                logMaintenance,
                new TypeError("hidden log maintenance transport detail"),
            ],
        });
        const { queryClient } = await renderOverview(transport);

        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: logMaintenanceQueryKey });
        });

        expect(await screen.findByText(/Last sample:/u)).toHaveTextContent(
            `The refresh failed. Showing the retained validated result. Last sample: ${formatDashboardDateTime(timestampMs)}.`
        );
        expect(screen.queryByText("hidden log maintenance transport detail")).toBeNull();
    });

    test("disables SQLite backup while maintenance is active", async () => {
        const transport = new OverviewTransport({
            databaseOverviewOutput: {
                ...detailedDatabaseOverview,
                sqlite: {
                    ...detailedDatabaseOverview.sqlite,
                    lifecycle: {
                        ...detailedDatabaseOverview.sqlite.lifecycle,
                        maintenance: {
                            ...detailedDatabaseOverview.sqlite.lifecycle.maintenance,
                            runs: [
                                {
                                    queuedAtMs: timestampMs,
                                    runId: "019fc968-1a9b-7765-8f1b-d5b863b0e7c1",
                                    state: "queued",
                                },
                            ],
                        },
                    },
                },
            },
        });
        await renderOverview(transport);

        expect(
            await screen.findByRole("button", { name: "Queue SQLite backup" })
        ).toBeDisabled();
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
        await renderOverview(transport);

        expect(
            await screen.findByRole("heading", {
                level: 3,
                name: "Saved data list incomplete",
            })
        ).toBeTruthy();
    });

    test("indicates a bounded cache inventory without restoring removed disclosure copy", async () => {
        await renderOverview(new OverviewTransport());

        expect(
            await screen.findByLabelText("2 of 129 saved data sources loaded")
        ).toHaveTextContent("2 / 129");
        expect(screen.queryByText(/Showing 2 of 129/iu)).toBeNull();
    });

    test("identifies the retained metrics sample after a refresh failure", async () => {
        const transport = new OverviewTransport({
            systemMetricsOutputs: [
                systemMetrics,
                new TypeError("hidden metrics transport detail"),
            ],
        });
        const { queryClient } = await renderOverview(transport);

        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: ["system", "metrics"] });
        });

        expect(await screen.findByText(/Last sample:/u)).toHaveTextContent(
            `The system usage request could not be completed. Try again. Last sample: ${formatDashboardDateTime(timestampMs)}.`
        );
        expect(screen.queryByText("hidden metrics transport detail")).toBeNull();
    });

    test("reuses an ambiguous refresh key and presents a terminal replay accurately", async () => {
        const rawFailure = new TypeError("never render this refresh transport detail");
        const transport = new OverviewTransport({
            refreshOutputs: [rawFailure, failedRefresh],
        });
        const { user } = await renderOverview(transport);

        await screen.findByRole("navigation", { name: "Saved data sources" });
        await user.click(screen.getByRole("button", { name: "View system.host" }));
        await screen.findByRole("heading", { level: 3, name: "Saved payload" });
        await user.click(screen.getByRole("button", { name: "Refresh now" }));
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await user.click(screen.getByRole("button", { name: "Try refresh again" }));
        expect(
            await screen.findByText(
                "The refresh failed. Open the background job for details."
            )
        ).toBeTruthy();
        expect(screen.queryByText(/Refresh queued/u)).toBeNull();
        const refreshInputs = transport.mutationCalls
            .filter(({ path }) => path === "cache.refreshEntry")
            .map(({ input }) => input as RefreshCacheEntryInput);
        expect(refreshInputs).toHaveLength(2);
        expect(refreshInputs[1]?.idempotencyKey).toBe(refreshInputs[0]?.idempotencyKey);
        expect(
            screen.getByRole("link", { name: "View background job" }).getAttribute("href")
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
        const { user } = await renderOverview(transport);

        await screen.findByRole("navigation", { name: "Saved data sources" });
        await user.click(screen.getByRole("button", { name: "View system.host" }));
        await screen.findByRole("heading", { level: 3, name: "Saved payload" });
        await user.click(screen.getByRole("button", { name: "Refresh now" }));
        await waitFor(() =>
            expect(
                transport.queryCalls.filter(
                    ({ input, path }) =>
                        path === "cache.getEntry" &&
                        (input as { readonly key: string }).key === "system.host"
                )
            ).toHaveLength(2)
        );
        await waitFor(() =>
            expect(screen.queryByRole("link", { name: "View background job" })).toBeNull()
        );
        expect(
            screen.queryByText(
                "Refresh requested. Saved data updates when the background job finishes."
            )
        ).toBeNull();
    });
});
