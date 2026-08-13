import * as v from "valibot";

import {
    backupCachePayloadSchema,
    type BackupCachePayload,
    type BackupType,
} from "../contracts/backups.ts";
import {
    BackupExecutionError,
    type BackupJobExecutionPort,
} from "../contracts/backupsWorker.ts";
import {
    databaseObservabilityCachePayloadSchema,
    type DatabaseObservabilityCachePayload,
} from "../contracts/database.ts";
import type { DatabaseObservabilityCollector } from "../contracts/databaseObservabilityCollector.ts";
import {
    deliveryCheckoutCachePayloadSchema,
    type DeliveryOverviewSectionId,
    deliveryPreviewCachePayloadSchema,
    deliveryPullRequestsCachePayloadSchema,
    deliveryReleasesCachePayloadSchema,
} from "../contracts/delivery.ts";
import {
    type DeliveryJobExecutionPort,
    type DeliveryJobOperationResult,
    type DeliveryOperationJobPayload,
    type DeliveryOverviewPreviousSections,
    type DeliveryOverviewSectionRefreshResult,
} from "../contracts/deliveryWorker.ts";
import {
    dockerGetContainerLogsResultSchema,
    dockerOverviewCachePayloadSchema,
    dockerPrunePreviewResultSchema,
    type DockerOverviewCachePayload,
} from "../contracts/docker.ts";
import {
    DockerUpdaterSourceConflictError,
    type DockerJobExecutionPort,
    type DockerJobUpdaterInput,
    type DockerOperationJobPayload,
} from "../contracts/dockerWorker.ts";
import {
    gitWorkspaceCachePayloadSchema,
    type GitWorkspaceCachePayload,
} from "../contracts/gitWorkspace.ts";
import { quotaCachePayloadSchema, type QuotaCachePayload } from "../contracts/quota.ts";
import {
    weatherCachePayloadSchema,
    type WeatherCachePayload,
} from "../contracts/weather.ts";
import {
    createDevelopmentAuthoritySimulators,
    type DevelopmentAuthoritySimulators,
    type DevelopmentSimulationOperation,
} from "./developmentAuthoritySimulators.ts";
import {
    FixedDockerOperationsError,
    type FixedDockerOperations,
} from "./docker/fixedDockerOperations.ts";

const sourceRevision = "d".repeat(64);
const currentReleaseId = "f".repeat(40);
const previousReleaseId = "e".repeat(40);
const firstPullRequestHead = "a".repeat(40);
const secondPullRequestHead = "b".repeat(40);
const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;
const unusedImageId = `sha256:${"d".repeat(64)}`;
const unusedVolumeName = "unused-development-cache";
const serviceId = "c".repeat(64);
const rollbackTransitionId = "018f6f50-6a9e-7b88-8000-000000000001";

export interface DevelopmentRuntimeAuthorityOutcomeOverrides {
    readonly conflict?: ReadonlySet<DevelopmentSimulationOperation>;
    readonly unknown?: ReadonlySet<DevelopmentSimulationOperation>;
}

interface DevelopmentDeliveryCompositionAuthority {
    readonly readActionActive: (input?: {
        readonly excludeRunId?: string;
        readonly signal?: AbortSignal;
    }) => Promise<boolean>;
    readonly readActivePreviewOperation: (
        signal?: AbortSignal
    ) => Promise<
        | Extract<
              DeliveryOperationJobPayload,
              { operation: "start-preview" | "stop-preview" }
          >
        | undefined
    >;
    readonly readPrevious: (section: DeliveryOverviewSectionId) => unknown;
}

interface DevelopmentOverviewProviderCollectors {
    readonly git: (signal?: AbortSignal) => Promise<GitWorkspaceCachePayload>;
    readonly quota: (signal?: AbortSignal) => Promise<QuotaCachePayload>;
    readonly weather: (signal?: AbortSignal) => Promise<WeatherCachePayload>;
}

export interface DevelopmentRuntimeAuthority {
    readonly backups: BackupJobExecutionPort;
    readonly createDelivery: (
        authority: DevelopmentDeliveryCompositionAuthority
    ) => DeliveryJobExecutionPort;
    readonly databaseObservability: DatabaseObservabilityCollector;
    readonly docker: Omit<
        DockerJobExecutionPort,
        "publishEvents" | "readPrevious" | "readPreviousAttemptStatus"
    >;
    readonly dockerOperations: FixedDockerOperations;
    readonly hostOperations: DevelopmentAuthoritySimulators["hostOperations"];
    readonly openClawGateway: DevelopmentAuthoritySimulators["openClawGateway"];
    readonly openClawServiceActions: DevelopmentAuthoritySimulators["openClawServiceActions"];
    readonly overviewProviders: DevelopmentOverviewProviderCollectors;
}

function checkedNow(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 1000) {
        throw new Error("Development runtime authority clock is invalid");
    }
    return value;
}

function databasePayload(): DatabaseObservabilityCachePayload {
    const databases = ["mira", "postgres"].map((name) => ({
        blocksHit: name === "mira" ? 990 : 199,
        blocksRead: name === "mira" ? 10 : 1,
        cacheHitRatio: name === "mira" ? 99 : 99.5,
        committedTransactions: name === "mira" ? 240 : 12,
        connections: name === "mira" ? 3 : 1,
        detailsState: "available" as const,
        name,
        rolledBackTransactions: name === "mira" ? 2 : 0,
        sizeBytes: name === "mira" ? 64 * 1024 * 1024 : 8 * 1024 * 1024,
    }));
    return v.parse(databaseObservabilityCachePayloadSchema, {
        databases,
        pgbouncer: {
            averageQueryMs: 3.2,
            averageTransactionMs: 5.1,
            clientConnections: 4,
            maxWaitSeconds: 0,
            serverConnections: 3,
            waitingClients: 0,
        },
        statements: [
            {
                calls: 120,
                meanExecutionMs: 8,
                rank: 1,
                rows: 1200,
                sharedBlocksHit: 1180,
                sharedBlocksRead: 20,
                totalExecutionMs: 960,
            },
        ],
        summary: {
            activeConnections: 1,
            averageCacheHitRatio: (1189 / 1200) * 100,
            idleConnections: 3,
            maintenance: {
                assessedPhysicalBytes: 64 * 1024 * 1024,
                assessmentComplete: true,
                estimatedReclaimableBytes: 0,
                estimatedReclaimablePercent: 0,
                highDeadTupleTableCount: 0,
                requiresBloatReview: false,
                slowStatementCount: 0,
                status: "healthy",
                unassessedPhysicalBytes: 0,
                unassessedTableCount: 0,
            },
            pgStatStatementsEnabled: true,
            totalConnections: 4,
            totalDatabaseSizeBytes: 72 * 1024 * 1024,
            unavailableDatabaseCount: 0,
        },
        tableHealth: [
            {
                assessment: "assessed",
                database: "mira",
                deadTuplePercent: 0,
                deadTuples: 0,
                estimatedReclaimableBytes: 0,
                liveTuples: 1200,
                physicalBytes: 64 * 1024 * 1024,
                schema: "public",
                table: "job_runs",
            },
        ],
        torrentCounts: {
            bitmagnet: { count: 125_000, state: "available" },
            comet: { count: 64_000, state: "available" },
        },
    });
}

function initialDockerPayload(now: number): DockerOverviewCachePayload {
    return v.parse(dockerOverviewCachePayloadSchema, {
        containers: [
            {
                createdAtMs: now - 86_400_000,
                health: "healthy",
                id: containerId,
                image: "example/dashboard:1.0.0",
                imageId,
                mounts: [
                    {
                        destination: "/data",
                        name: "dashboard-data",
                        readOnly: false,
                        type: "volume",
                    },
                ],
                name: "dashboard-1",
                networks: [{ addresses: ["172.20.0.2"], name: "dashboard" }],
                ports: [
                    {
                        containerPort: 3100,
                        hostPort: 3100,
                        hostScope: "loopback",
                        protocol: "tcp",
                    },
                ],
                project: "dashboard",
                restartCount: 0,
                service: "dashboard",
                startedAtMs: now - 3_600_000,
                state: "running",
                stats: {
                    blockReadBytes: 1024,
                    blockWrittenBytes: 2048,
                    cpuPercent: 1.5,
                    memoryLimitBytes: 512 * 1024 * 1024,
                    memoryPercent: 12.5,
                    memoryUsedBytes: 64 * 1024 * 1024,
                    networkReceivedBytes: 4096,
                    networkSentBytes: 8192,
                    pids: 8,
                },
            },
        ],
        images: [
            {
                createdAtMs: now - 86_400_000,
                id: imageId,
                references: ["example/dashboard:1.0.0"],
                sizeBytes: 128 * 1024 * 1024,
                usedByContainerIds: [containerId],
            },
            {
                createdAtMs: now - 172_800_000,
                id: unusedImageId,
                references: ["example/unused-development:0.9.0"],
                sizeBytes: 24 * 1024 * 1024,
                usedByContainerIds: [],
            },
        ],
        observedAtMs: now,
        sourceRevision,
        updaterEvents: [
            {
                atMs: now - 60_000,
                id: "018f6f50-6a9e-7b88-8000-000000000002",
                kind: "update-available",
                serviceId,
                summary: "A development-only image update is available.",
            },
        ],
        updaterServices: [
            {
                currentImage: "example/dashboard:1.0.0",
                id: serviceId,
                policy: { automatic: true, state: "managed", track: "tag" },
                project: "dashboard",
                service: "dashboard",
                status: {
                    candidateImage: "example/dashboard:1.1.0",
                    state: "update-available",
                },
            },
        ],
        volumes: [
            {
                driver: "local",
                name: "dashboard-data",
                scope: "local",
                sizeBytes: 32 * 1024 * 1024,
                usedByContainerIds: [containerId],
            },
            {
                driver: "local",
                name: unusedVolumeName,
                scope: "local",
                sizeBytes: 4 * 1024 * 1024,
                usedByContainerIds: [],
            },
        ],
    });
}

function backupPayload(type: BackupType, now: number): BackupCachePayload {
    return v.parse(
        backupCachePayloadSchema,
        type === "kopia"
            ? {
                  backupCount: 4,
                  healthy: true,
                  observedAtMs: now,
                  providerIdle: true,
                  sourceRevision,
                  sources: [
                      {
                          health: "current",
                          id: "docker",
                          latestCompletedAtMs: now - 3_600_000,
                          latestFileCount: 120,
                          latestSizeBytes: 8 * 1024 * 1024,
                          snapshotCount: 2,
                      },
                      {
                          health: "current",
                          id: "projects",
                          latestCompletedAtMs: now - 7_200_000,
                          snapshotCount: 2,
                      },
                  ],
                  type,
              }
            : {
                  backupCount: 3,
                  healthy: true,
                  latestCompletedAtMs: now - 3_600_000,
                  observedAtMs: now,
                  providerIdle: true,
                  sourceRevision,
                  type,
              }
    );
}

function overviewProviders(nowMs: () => number): DevelopmentOverviewProviderCollectors {
    return Object.freeze({
        git: (signal?: AbortSignal): Promise<GitWorkspaceCachePayload> =>
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                return v.parse(gitWorkspaceCachePayloadSchema, {
                    observedAtMs: checkedNow(nowMs),
                    repositories: [
                        {
                            branch: "main",
                            changedFileCount: 2,
                            detached: false,
                            headSha: currentReleaseId,
                            id: "dashboard",
                            stagedFileCount: 0,
                            state: "available",
                            untrackedFileCount: 1,
                        },
                        {
                            branch: "main",
                            changedFileCount: 0,
                            detached: false,
                            headSha: previousReleaseId,
                            id: "docker",
                            stagedFileCount: 0,
                            state: "available",
                            untrackedFileCount: 0,
                        },
                        {
                            branch: "main",
                            changedFileCount: 1,
                            detached: false,
                            headSha: firstPullRequestHead,
                            id: "openclaw",
                            stagedFileCount: 1,
                            state: "available",
                            untrackedFileCount: 0,
                        },
                    ],
                });
            }),
        quota: (signal?: AbortSignal): Promise<QuotaCachePayload> =>
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                return v.parse(quotaCachePayloadSchema, {
                    observedAtMs: checkedNow(nowMs),
                    providers: [
                        {
                            id: "elevenlabs",
                            label: "ElevenLabs",
                            remaining: 80_000,
                            remainingPercent: 80,
                            status: "available",
                            unit: "text-characters",
                        },
                        {
                            id: "openai",
                            label: "OpenAI",
                            remaining: 70,
                            remainingPercent: 70,
                            status: "available",
                        },
                        {
                            id: "openrouter",
                            label: "OpenRouter",
                            remaining: 8,
                            remainingPercent: 80,
                            status: "available",
                            unit: "currency-usd",
                        },
                        {
                            id: "synthetic",
                            label: "Synthetic",
                            remaining: 90,
                            remainingPercent: 90,
                            status: "available",
                        },
                    ],
                });
            }),
        weather: (signal?: AbortSignal): Promise<WeatherCachePayload> =>
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const now = checkedNow(nowMs);
                return v.parse(weatherCachePayloadSchema, {
                    apparentTemperatureC: 11,
                    condition: "rain",
                    forecast: [
                        {
                            condition: "rain",
                            date: "2026-08-13",
                            maximumTemperatureC: 14,
                            minimumTemperatureC: 8,
                        },
                        {
                            condition: "cloudy",
                            date: "2026-08-14",
                            maximumTemperatureC: 16,
                            minimumTemperatureC: 9,
                        },
                        {
                            condition: "clear",
                            date: "2026-08-15",
                            maximumTemperatureC: 18,
                            minimumTemperatureC: 10,
                        },
                    ],
                    humidityPercent: 72,
                    location: "Spydeberg",
                    observedAtMs: now,
                    temperatureC: 12,
                    timezone: "Europe/Oslo",
                    windKilometresPerHour: 9,
                });
            }),
    });
}

function deliveryPullRequestsPayload(now: number) {
    const actions = [
        { action: "approve-review", actor: "raymond", available: true, scope: "self" },
        { action: "merge", actor: "mira", available: true, scope: "prefix" },
        {
            action: "merge-and-deploy",
            actor: "mira",
            available: true,
            scope: "prefix",
        },
        { action: "preview-start", actor: "mira", available: true, scope: "prefix" },
        { action: "reject", actor: "mira", available: true, scope: "self" },
        {
            action: "update-branch",
            actor: "mira",
            available: false,
            reason: "not-behind",
            scope: "self",
        },
    ] as const;
    const member = (number: number, headSha: string, baseRef: string) => ({
        actions,
        additions: number === 41 ? 24 : 12,
        author: "mira-2026",
        baseRef,
        body: "Development-only representative pull request data.",
        changedFiles: 3,
        checksState: "passed" as const,
        createdAtMs: now - 7_200_000,
        deletions: 4,
        headRef: `development-stack-${number}`,
        headSha,
        isCrossRepository: false,
        isDraft: false,
        mergeState: "CLEAN",
        mergeability: "mergeable" as const,
        number,
        reviewState: "approved" as const,
        title: `Development stack layer ${number}`,
        updatedAtMs: now - 60_000,
        url: `https://github.com/rajohan/Mira-Dashboard/pull/${number}`,
    });
    return v.parse(deliveryPullRequestsCachePayloadSchema, {
        groups: [
            {
                id: "c".repeat(64),
                kind: "native-stack",
                members: [
                    member(41, firstPullRequestHead, "main"),
                    member(42, secondPullRequestHead, "development-stack-41"),
                ],
            },
        ],
        observedAtMs: now,
        reviewerCapability: {
            actor: "raymond",
            available: true,
            revision: sourceRevision,
        },
        sourceRevision,
    });
}

function createDeliveryPort(
    authority: DevelopmentDeliveryCompositionAuthority,
    simulators: DevelopmentAuthoritySimulators,
    overrides: DevelopmentRuntimeAuthorityOutcomeOverrides,
    nowMs: () => number
): DeliveryJobExecutionPort {
    let previewRunning = false;
    const operationMode = (operation: DevelopmentSimulationOperation) => {
        if (overrides.conflict?.has(operation) === true) return "conflict" as const;
        if (overrides.unknown?.has(operation) === true) return "unknown" as const;
        return "success" as const;
    };
    const refresh = (
        _previous: DeliveryOverviewPreviousSections,
        signal?: AbortSignal
    ): Promise<readonly DeliveryOverviewSectionRefreshResult[]> =>
        Promise.resolve().then(() => {
            signal?.throwIfAborted();
            const now = checkedNow(nowMs);
            const preview = v.parse(deliveryPreviewCachePayloadSchema, {
                actionActive: false,
                observedAtMs: now,
                preview: previewRunning
                    ? {
                          controlsAvailable: true,
                          headSha: secondPullRequestHead,
                          number: 42,
                          revision: sourceRevision,
                          startedAtMs: now - 60_000,
                          status: "running",
                          title: "Development stack preview",
                          updatedAtMs: now,
                          url: "https://preview.example.invalid/",
                      }
                    : {
                          controlsAvailable: true,
                          revision: sourceRevision,
                          status: "stopped",
                          updatedAtMs: now,
                      },
                sourceRevision,
            });
            const checkout = v.parse(deliveryCheckoutCachePayloadSchema, {
                checkout: {
                    branch: "main",
                    condition: "ready",
                    expectedBranch: "main",
                    headSha: currentReleaseId,
                    remoteHeadSha: currentReleaseId,
                    revision: sourceRevision,
                    safeForDeploy: true,
                    upstream: "origin/main",
                },
                observedAtMs: now,
                sourceRevision,
            });
            const releases = v.parse(deliveryReleasesCachePayloadSchema, {
                actionActive: false,
                observedAtMs: now,
                releases: {
                    activationRevision: sourceRevision,
                    current: {
                        builtAtMs: now - 3_600_000,
                        commitTitle: "Development current release",
                        commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${currentReleaseId}`,
                        releaseId: currentReleaseId,
                        runtimeRevision: currentReleaseId,
                        schemaTarget: 1,
                    },
                    previous: {
                        builtAtMs: now - 86_400_000,
                        commitTitle: "Development previous release",
                        commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${previousReleaseId}`,
                        releaseId: previousReleaseId,
                        runtimeRevision: previousReleaseId,
                        schemaTarget: 1,
                    },
                    rollback: {
                        actor: "mira",
                        available: true,
                        target: {
                            databaseSnapshotTransitionId: rollbackTransitionId,
                            releaseId: previousReleaseId,
                            runtimeRevision: previousReleaseId,
                        },
                    },
                },
                sourceRevision,
            });
            return Object.freeze([
                {
                    payload: deliveryPullRequestsPayload(now),
                    section: "pull-requests",
                    state: "succeeded",
                },
                { payload: preview, section: "preview", state: "succeeded" },
                { payload: checkout, section: "checkout", state: "succeeded" },
                { payload: releases, section: "releases", state: "succeeded" },
            ] as const);
        });
    return Object.freeze({
        execute(
            payload: DeliveryOperationJobPayload,
            signal?: AbortSignal
        ): Promise<DeliveryJobOperationResult> {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const receiptOperation = `delivery:${payload.operation}` as const;
                const mode = operationMode(receiptOperation);
                if (payload.sourceRevision !== sourceRevision || mode === "conflict") {
                    simulators.record(receiptOperation, "conflict");
                    throw new Error("Development Delivery source state changed");
                }
                if (mode === "unknown") {
                    simulators.record(receiptOperation, "unknown-outcome");
                    return {
                        operation: payload.operation,
                        outcome: "unknown-outcome",
                    };
                }
                if (payload.operation === "start-preview") previewRunning = true;
                if (payload.operation === "stop-preview") previewRunning = false;
                simulators.record(receiptOperation);
                signal?.throwIfAborted();
                let releaseId: string | undefined;
                if (payload.operation === "rollback-release") {
                    releaseId = payload.target.releaseId;
                } else if (
                    payload.operation === "deploy" ||
                    (payload.operation === "merge-pull-request" && payload.deploy)
                ) {
                    releaseId = currentReleaseId;
                }
                return {
                    operation: payload.operation,
                    outcome:
                        payload.operation === "update-branch" ? "enqueued" : "completed",
                    ...(releaseId === undefined ? {} : { releaseId }),
                };
            });
        },
        readPrevious: (section: DeliveryOverviewSectionId) =>
            authority.readPrevious(section),
        refresh,
    });
}

/**
 * Composes all production-shaped source-development data and mutation ports without
 * retaining Docker, GitHub, PostgreSQL, systemd, network, or production-path authority.
 * @param input Marked state root, optional deterministic clock, and test outcomes.
 * @returns One complete development-only runtime authority adapter.
 */
export function createDevelopmentRuntimeAuthority(input: {
    readonly nowMs?: () => number;
    readonly outcomes?: DevelopmentRuntimeAuthorityOutcomeOverrides;
    readonly stateRoot: string;
}): DevelopmentRuntimeAuthority {
    const nowMs = input.nowMs ?? Date.now;
    const outcomes = input.outcomes ?? {};
    const simulators = createDevelopmentAuthoritySimulators({
        nowMs,
        stateRoot: input.stateRoot,
    });
    let dockerPayload = initialDockerPayload(checkedNow(nowMs));
    const mode = (operation: DevelopmentSimulationOperation) => {
        if (outcomes.conflict?.has(operation) === true) return "conflict" as const;
        if (outcomes.unknown?.has(operation) === true) return "unknown" as const;
        return "success" as const;
    };
    const assertDockerSource = (
        operation: DevelopmentSimulationOperation,
        expectedSourceRevision: string | undefined
    ): void => {
        if (
            mode(operation) === "conflict" ||
            (expectedSourceRevision !== undefined &&
                expectedSourceRevision !== dockerPayload.sourceRevision)
        ) {
            simulators.record(operation, "conflict");
            throw new DockerUpdaterSourceConflictError();
        }
    };
    const docker: DevelopmentRuntimeAuthority["docker"] = Object.freeze({
        execute(
            payload: DockerOperationJobPayload,
            signal?: AbortSignal
        ): Promise<{
            readonly operation: DockerOperationJobPayload["operation"];
            readonly outcome: "completed" | "unknown-outcome";
            readonly targetCount: number;
        }> {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const operation = `docker:${payload.operation}` as const;
                assertDockerSource(operation, payload.sourceRevision);
                if (mode(operation) === "unknown") {
                    simulators.record(operation, "unknown-outcome");
                    return {
                        operation: payload.operation,
                        outcome: "unknown-outcome" as const,
                        targetCount: 0,
                    };
                }
                simulators.record(operation);
                let targetCount = 1;
                if (payload.operation === "prune-execute") {
                    targetCount =
                        payload.target === "images"
                            ? payload.imageIds.length
                            : payload.volumeNames.length;
                }
                return {
                    operation: payload.operation,
                    outcome: "completed" as const,
                    targetCount,
                };
            });
        },
        refresh(_previous?: unknown, signal?: AbortSignal) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                return dockerPayload;
            });
        },
        runUpdater(input: DockerJobUpdaterInput, signal?: AbortSignal) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const operation = "docker:updater-run" as const;
                assertDockerSource(operation, input.expectedSourceRevision);
                if (mode(operation) === "unknown") {
                    simulators.record(operation, "unknown-outcome");
                    return {
                        failedCount: 0,
                        outcome: "unknown-outcome" as const,
                        payload: dockerPayload,
                        updatedCount: 0,
                    };
                }
                simulators.record(operation);
                return {
                    failedCount: 0,
                    outcome: "completed" as const,
                    payload: dockerPayload,
                    updatedCount: input.serviceId === undefined ? 0 : 1,
                };
            });
        },
        scan(_previous?: unknown, signal?: AbortSignal) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                simulators.record("docker:updater-scan");
                return dockerPayload;
            });
        },
    });
    const dockerOperations: FixedDockerOperations = Object.freeze({
        async execute(
            payload: Parameters<FixedDockerOperations["execute"]>[0],
            signal?: AbortSignal
        ) {
            try {
                const result = await docker.execute(payload, signal);
                if (result.outcome === "unknown-outcome") {
                    throw new FixedDockerOperationsError("unknown-outcome");
                }
                return Object.freeze({
                    operation: payload.operation,
                    status: "completed" as const,
                    targetCount: result.targetCount,
                });
            } catch (error) {
                if (error instanceof DockerUpdaterSourceConflictError) {
                    throw new FixedDockerOperationsError("conflict");
                }
                throw error;
            }
        },
        previewPrune(
            input: Parameters<FixedDockerOperations["previewPrune"]>[0],
            signal?: AbortSignal
        ) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                if (input.sourceRevision !== dockerPayload.sourceRevision) {
                    throw new FixedDockerOperationsError("conflict");
                }
                if (input.target === "images") {
                    const image = dockerPayload.images.find(
                        ({ id }) => id === unusedImageId
                    );
                    if (image === undefined) {
                        throw new FixedDockerOperationsError("not-found");
                    }
                    return v.parse(dockerPrunePreviewResultSchema, {
                        estimatedReclaimableBytes: image.sizeBytes,
                        items: [
                            {
                                id: image.id,
                                references: image.references,
                                sizeBytes: image.sizeBytes,
                            },
                        ],
                        sourceRevision: dockerPayload.sourceRevision,
                        target: "images",
                    });
                }
                const volume = dockerPayload.volumes.find(
                    ({ name }) => name === unusedVolumeName
                );
                if (volume === undefined) {
                    throw new FixedDockerOperationsError("not-found");
                }
                return v.parse(dockerPrunePreviewResultSchema, {
                    estimatedReclaimableBytes: volume.sizeBytes ?? 0,
                    items: [
                        {
                            name: volume.name,
                            ...(volume.sizeBytes === undefined
                                ? {}
                                : { sizeBytes: volume.sizeBytes }),
                        },
                    ],
                    sourceRevision: dockerPayload.sourceRevision,
                    target: "volumes",
                });
            });
        },
        readContainerLogs(
            input: Parameters<FixedDockerOperations["readContainerLogs"]>[0],
            signal?: AbortSignal
        ) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                if (input.sourceRevision !== dockerPayload.sourceRevision) {
                    throw new FixedDockerOperationsError("conflict");
                }
                if (input.containerId !== containerId) {
                    throw new FixedDockerOperationsError("not-found");
                }
                return v.parse(dockerGetContainerLogsResultSchema, {
                    containerId,
                    lines: [
                        "2026-08-13T09:00:00.000Z development service ready",
                        "2026-08-13T09:01:00.000Z representative request completed",
                    ].slice(-input.tail),
                    observedAtMs: checkedNow(nowMs),
                    redacted: true,
                    sourceRevision: dockerPayload.sourceRevision,
                    truncated: false,
                });
            });
        },
    });
    const backups = Object.freeze({
        clearAttention(
            {
                sourceRevision: expected,
                type,
            }: Parameters<BackupJobExecutionPort["clearAttention"]>[0],
            signal?: AbortSignal
        ) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const operation = `backup:${type}-clear-attention` as const;
                if (expected !== sourceRevision || mode(operation) === "conflict") {
                    simulators.record(operation, "conflict");
                    throw new BackupExecutionError("conflict");
                }
                if (mode(operation) === "unknown") {
                    simulators.record(operation, "unknown-outcome");
                    return { outcome: "unknown-outcome" as const };
                }
                simulators.record(operation);
                return { outcome: "completed" as const, sourceRevision };
            });
        },
        refresh(signal?: AbortSignal) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const now = checkedNow(nowMs);
                return {
                    kopia: {
                        kind: "succeeded" as const,
                        payload: backupPayload("kopia", now),
                    },
                    walg: {
                        kind: "succeeded" as const,
                        payload: backupPayload("walg", now),
                    },
                };
            });
        },
        run(
            {
                expectedSourceRevision,
                type,
            }: Parameters<BackupJobExecutionPort["run"]>[0],
            signal?: AbortSignal
        ) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                const operation = `backup:${type}-run` as const;
                if (
                    (expectedSourceRevision !== undefined &&
                        expectedSourceRevision !== sourceRevision) ||
                    mode(operation) === "conflict"
                ) {
                    simulators.record(operation, "conflict");
                    throw new BackupExecutionError("conflict");
                }
                if (mode(operation) === "unknown") {
                    simulators.record(operation, "unknown-outcome");
                    return { outcome: "unknown-outcome" as const };
                }
                simulators.record(operation);
                return { outcome: "completed" as const, sourceRevision };
            });
        },
    }) satisfies BackupJobExecutionPort;
    const databaseObservability: DatabaseObservabilityCollector = Object.freeze({
        collect(signal?: AbortSignal) {
            return Promise.resolve().then(() => {
                signal?.throwIfAborted();
                simulators.record("database:observe");
                return databasePayload();
            });
        },
    });
    dockerPayload = v.parse(dockerOverviewCachePayloadSchema, dockerPayload);
    return Object.freeze({
        backups,
        createDelivery: (authority: DevelopmentDeliveryCompositionAuthority) =>
            createDeliveryPort(authority, simulators, outcomes, nowMs),
        databaseObservability,
        docker,
        dockerOperations,
        hostOperations: simulators.hostOperations,
        openClawGateway: simulators.openClawGateway,
        openClawServiceActions: simulators.openClawServiceActions,
        overviewProviders: overviewProviders(nowMs),
    });
}
