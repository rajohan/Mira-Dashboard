import * as v from "valibot";

import {
    dockerOverviewCachePayloadSchema,
    dockerUpdaterEventMaximum,
    type DockerOverviewCachePayload,
    type DockerUpdaterEvent,
    type DockerUpdaterPolicy,
    type DockerUpdaterService as DockerUpdaterServiceSnapshot,
} from "../../contracts/docker.ts";
import {
    type DockerJobProgressReporter,
    type DockerJobUpdaterInput,
    DockerUpdaterSourceConflictError,
} from "../../contracts/dockerWorker.ts";
import type { DockerComposeDiscoveredService } from "./composeDiscovery.ts";
import {
    type DockerComposeCommandRunner,
    DockerComposeImageUpdateError,
    type DockerComposeImageUpdateResult,
    type DockerComposeStackReconciler,
    type DockerImageReferenceRestorer,
    reconcileDockerComposeStack,
    updateDockerComposeImage,
} from "./composeImageUpdate.ts";
import type {
    DockerUpdaterGitHeadFile,
    DockerUpdaterGitSync,
    DockerUpdaterGitSyncChange,
    DockerUpdaterGitSyncResult,
    DockerUpdaterGitSyncUnavailableReason,
} from "./gitSync.ts";
import {
    DockerOverviewDiscoveryError,
    type DockerOverviewCollector,
} from "./overviewCollector.ts";
import { scanDockerUpdates, type DockerUpdaterScanOptions } from "./updaterScan.ts";

const composeEnvironment = Object.freeze({
    HOME: "/home/ubuntu",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
});
const dockerExecutable = "/usr/bin/docker" as const;
const dockerImageTagDeadlineMs = 30_000;
const dockerImageTagOutputMaximumBytes = 64 * 1024;
const dockerOperationDeadlineMs = 35 * 60_000;
const dockerRecoveryDeadlineMs = 35 * 60_000;

function updaterPoliciesMatch(
    left: DockerUpdaterPolicy,
    right: DockerUpdaterPolicy
): boolean {
    if (left.state !== right.state) return false;
    if (left.state === "inventory-only") {
        return right.state === "inventory-only" && left.reason === right.reason;
    }
    return (
        right.state === "managed" &&
        left.automatic === right.automatic &&
        left.track === right.track
    );
}

function hasEligibleRuntime(
    payload: DockerOverviewCachePayload,
    service: DockerUpdaterServiceSnapshot
): boolean {
    const containers = payload.containers.filter(
        (container) =>
            container.project === service.project && container.service === service.service
    );
    if (containers.length === 0) return false;
    const imageIds = new Set(containers.map(({ imageId }) => imageId));
    return (
        imageIds.size === 1 &&
        containers.every(
            ({ health, state }) =>
                state === "running" && health !== "starting" && health !== "unhealthy"
        )
    );
}

function retainUnchangedScannedStatuses(
    scanned: DockerOverviewCachePayload,
    settled: DockerOverviewCachePayload,
    successfulIds: ReadonlySet<string>
): readonly DockerUpdaterServiceSnapshot[] {
    const scannedById = new Map(
        scanned.updaterServices.map((service) => [service.id, service])
    );
    return settled.updaterServices.map((service) => {
        if (successfulIds.has(service.id)) {
            return { ...service, status: { state: "current" as const } };
        }
        const prior = scannedById.get(service.id);
        return prior !== undefined &&
            prior.currentImage === service.currentImage &&
            updaterPoliciesMatch(prior.policy, service.policy) &&
            hasEligibleRuntime(settled, service)
            ? { ...service, status: prior.status }
            : service;
    });
}

export type DockerUpdaterRunOutcome =
    | "completed"
    | "completed-with-failures"
    | "source-sync-pending"
    | "unknown-outcome";

/** Sanitized Git settlement without Compose paths or process diagnostics. */
export type DockerUpdaterRunGitResult =
    | Readonly<{ status: "no-change" }>
    | Readonly<{ commit: string; status: "pushed" }>
    | Readonly<{ commit: string; status: "committed-push-pending" }>
    | Readonly<{
          reason: DockerUpdaterGitSyncUnavailableReason;
          status: "unavailable";
      }>
    | Readonly<{ commit?: string; status: "unknown-outcome" }>;

export interface DockerUpdaterRunResult {
    readonly failedCount: number;
    readonly git: DockerUpdaterRunGitResult;
    readonly outcome: DockerUpdaterRunOutcome;
    readonly payload: DockerOverviewCachePayload;
    readonly updatedCount: number;
}

export interface DockerUpdaterService {
    readonly refresh: (
        previous?: unknown,
        signal?: AbortSignal
    ) => Promise<DockerOverviewCachePayload>;
    readonly run: (
        input: DockerJobUpdaterInput,
        signal?: AbortSignal,
        reportProgress?: DockerJobProgressReporter
    ) => Promise<DockerUpdaterRunResult>;
    readonly scan: (
        previous?: unknown,
        signal?: AbortSignal,
        reportProgress?: DockerJobProgressReporter
    ) => Promise<DockerOverviewCachePayload>;
}

export interface DockerUpdaterServiceOptions {
    readonly afterReconcileStack?: (signal?: AbortSignal) => Promise<void>;
    readonly collector: DockerOverviewCollector;
    readonly composeRunner?: DockerComposeCommandRunner;
    readonly generateId?: () => string;
    readonly git: DockerUpdaterGitSync;
    readonly nowMs?: () => number;
    readonly restoreImageReference?: DockerImageReferenceRestorer;
    readonly reconcileStack?: DockerComposeStackReconciler;
    readonly scan?: DockerUpdaterScanOptions;
    readonly updateImage?: typeof updateDockerComposeImage;
}

function fail(cause?: unknown): never {
    throw new Error(
        "Docker updater execution failed",
        cause === undefined ? undefined : { cause }
    );
}

function sourceConflict(): never {
    throw new DockerUpdaterSourceConflictError();
}

function verificationFailureSummary(error: unknown, project: string, service: string) {
    const stage =
        error instanceof DockerOverviewDiscoveryError
            ? ` during ${error.stage.replaceAll("-", " ")}`
            : "";
    return `Update verification failed${stage} for ${project}/${service}; the prior state was restored.`;
}

async function readBounded(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<number> {
    const reader = stream.getReader();
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) return total;
            total += next.value.byteLength;
            if (total > maximumBytes) fail();
        }
    } finally {
        reader.releaseLock();
    }
}

const defaultComposeRunner: DockerComposeCommandRunner = async (
    executable,
    arguments_,
    options
) => {
    const signal =
        options.signal === undefined
            ? AbortSignal.timeout(options.deadlineMs)
            : AbortSignal.any([options.signal, AbortSignal.timeout(options.deadlineMs)]);
    const child = Bun.spawn([executable, ...arguments_], {
        cwd: options.cwd,
        env: composeEnvironment,
        signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
            child.exited,
            readBounded(child.stdout, options.outputMaximumBytes),
            readBounded(child.stderr, options.outputMaximumBytes),
        ]);
        return Object.freeze({ exitCode, stderrBytes, stdoutBytes });
    } catch (error) {
        child.kill();
        await child.exited.catch(() => {});
        return fail(error);
    }
};

const defaultImageReferenceRestorer: DockerImageReferenceRestorer = async (
    imageId,
    imageReference,
    parentSignal
) => {
    const signal =
        parentSignal === undefined
            ? AbortSignal.timeout(dockerImageTagDeadlineMs)
            : AbortSignal.any([
                  parentSignal,
                  AbortSignal.timeout(dockerImageTagDeadlineMs),
              ]);
    const child = Bun.spawn([dockerExecutable, "image", "tag", imageId, imageReference], {
        env: composeEnvironment,
        signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
            child.exited,
            readBounded(child.stdout, dockerImageTagOutputMaximumBytes),
            readBounded(child.stderr, dockerImageTagOutputMaximumBytes),
        ]);
        if (
            exitCode !== 0 ||
            stdoutBytes > dockerImageTagOutputMaximumBytes ||
            stderrBytes > dockerImageTagOutputMaximumBytes
        ) {
            fail();
        }
    } catch (error) {
        child.kill();
        await child.exited.catch(() => {});
        return fail(error);
    }
};

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function exactRunningServiceRuntime(
    payload: DockerOverviewCachePayload,
    project: string,
    service: string,
    expectedImageReference?: string
): Readonly<{ imageId: string; replicaCount: number }> {
    const matching = payload.containers.filter(
        (container) => container.project === project && container.service === service
    );
    if (
        matching.length === 0 ||
        matching.some(
            ({ health, image, state }) =>
                state !== "running" ||
                health === "starting" ||
                health === "unhealthy" ||
                (expectedImageReference !== undefined && image !== expectedImageReference)
        )
    ) {
        return fail();
    }
    const imageIds = new Set(matching.map(({ imageId }) => imageId));
    if (imageIds.size !== 1) return fail();
    return Object.freeze({
        imageId: imageIds.values().next().value!,
        replicaCount: matching.length,
    });
}

function events(
    current: readonly DockerUpdaterEvent[],
    added: readonly DockerUpdaterEvent[]
): DockerUpdaterEvent[] {
    return [...current, ...added]
        .toSorted(
            (left, right) => right.atMs - left.atMs || compareStrings(left.id, right.id)
        )
        .slice(0, dockerUpdaterEventMaximum);
}

function exactService(
    services: readonly DockerComposeDiscoveredService[],
    project: string,
    service: string
): DockerComposeDiscoveredService {
    const matches = services.filter(
        (candidate) => candidate.project === project && candidate.service === service
    );
    return matches.length === 1 ? matches[0]! : fail();
}

function gitOutcome(result: DockerUpdaterGitSyncResult): DockerUpdaterRunOutcome {
    switch (result.status) {
        case "pushed":
        case "no-change": {
            return "completed";
        }
        case "committed-push-pending":
        case "unavailable": {
            return "source-sync-pending";
        }
        case "unknown-outcome": {
            return "unknown-outcome";
        }
    }
}

function publicGitResult(result: DockerUpdaterGitSyncResult): DockerUpdaterRunGitResult {
    switch (result.status) {
        case "no-change": {
            return Object.freeze({ status: result.status });
        }
        case "pushed":
        case "committed-push-pending": {
            return Object.freeze({ commit: result.commit, status: result.status });
        }
        case "unavailable": {
            return Object.freeze({ reason: result.reason, status: result.status });
        }
        case "unknown-outcome": {
            return Object.freeze({
                ...(result.commit === undefined ? {} : { commit: result.commit }),
                status: result.status,
            });
        }
    }
}

function event(
    generateId: () => string,
    nowMs: () => number,
    input: Omit<DockerUpdaterEvent, "atMs" | "id">
): DockerUpdaterEvent {
    return { ...input, atMs: nowMs(), id: generateId() };
}

function updateSettlementEventKind(
    outcome: DockerUpdaterRunOutcome
): "source-sync-pending" | "update-outcome-unknown" | "update-succeeded" {
    if (outcome === "completed" || outcome === "completed-with-failures") {
        return "update-succeeded";
    }
    return outcome === "unknown-outcome"
        ? "update-outcome-unknown"
        : "source-sync-pending";
}

function updateSettlementSummary(
    kind: ReturnType<typeof updateSettlementEventKind>,
    service: { readonly project: string; readonly service: string }
): string {
    if (kind === "update-succeeded") {
        return `Updated ${service.project}/${service.service} and pushed the Compose source.`;
    }
    if (kind === "source-sync-pending") {
        return `Updated ${service.project}/${service.service}; Compose source synchronization is pending.`;
    }
    return `Updated ${service.project}/${service.service}; final source synchronization could not be confirmed.`;
}

function unknownMutationResult(input: {
    readonly addedEvents: readonly DockerUpdaterEvent[];
    readonly affectedServices: readonly {
        readonly id: string;
        readonly project: string;
        readonly service: string;
    }[];
    readonly confirmedCurrentIds: ReadonlySet<string>;
    readonly failedCount: number;
    readonly failureStage: string;
    readonly generateId: () => string;
    readonly nowMs: () => number;
    readonly payload: DockerOverviewCachePayload;
    readonly updatedCount: number;
}): DockerUpdaterRunResult {
    const affectedById = new Map(
        input.affectedServices.map((service) => [service.id, service])
    );
    const unknownEvents = [...affectedById.values()].map((service) =>
        event(input.generateId, input.nowMs, {
            kind: "update-outcome-unknown",
            serviceId: service.id,
            summary: `Update outcome for ${service.project}/${service.service} could not be confirmed after ${input.failureStage}; Docker and Compose state require reconciliation.`,
        })
    );
    const payload = v.parse(dockerOverviewCachePayloadSchema, {
        ...input.payload,
        updaterEvents: events(input.payload.updaterEvents, [
            ...input.addedEvents,
            ...unknownEvents,
        ]),
        updaterServices: input.payload.updaterServices.map((service) => {
            if (input.confirmedCurrentIds.has(service.id)) {
                return { ...service, status: { state: "current" as const } };
            }
            return affectedById.has(service.id)
                ? { ...service, status: { state: "unavailable" as const } }
                : service;
        }),
    });
    return Object.freeze({
        failedCount: input.failedCount,
        git: Object.freeze({ status: "unknown-outcome" }),
        outcome: "unknown-outcome",
        payload,
        updatedCount: input.updatedCount,
    });
}

/**
 * Creates dynamic scan/update orchestration with exact Compose CAS and Git settlement.
 * @param options Discovery, registry, Compose, Git, clock, and identity boundaries.
 * @returns Worker-owned updater service with no public path or provider diagnostics.
 */
export function createDockerUpdaterService(
    options: DockerUpdaterServiceOptions
): DockerUpdaterService {
    const composeRunner = options.composeRunner ?? defaultComposeRunner;
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = options.nowMs ?? Date.now;
    const restoreImageReference =
        options.restoreImageReference ?? defaultImageReferenceRestorer;
    const reconcileStack =
        options.reconcileStack ??
        ((explicitServices, signal) =>
            reconcileDockerComposeStack(composeRunner, explicitServices, signal));
    const updateImage = options.updateImage ?? updateDockerComposeImage;
    const scanOptions = Object.freeze({
        ...options.scan,
        generateId,
        nowMs,
    });

    async function scan(
        previous?: unknown,
        signal?: AbortSignal,
        reportProgress?: DockerJobProgressReporter
    ): Promise<DockerOverviewCachePayload> {
        await reportProgress?.({
            message: "Discovering Docker services",
            phase: "discovering",
        });
        const discovery = await options.collector.discover(previous, signal);
        const result = await scanDockerUpdates(
            discovery.compose,
            discovery.payload,
            signal,
            { ...scanOptions, reportProgress }
        );
        return result.payload;
    }

    async function reconcileVerifiedStack(
        previous: DockerOverviewCachePayload,
        expectedComposeSourceRevision: string,
        explicitServices: readonly string[],
        signal: AbortSignal
    ) {
        const before = await options.collector.discover(previous, signal);
        if (before.compose.sourceRevision !== expectedComposeSourceRevision) {
            sourceConflict();
        }
        await reconcileStack(explicitServices, signal);
        await options.afterReconcileStack?.(signal);
        const after = await options.collector.discover(before.payload, signal);
        if (after.compose.sourceRevision !== expectedComposeSourceRevision) {
            sourceConflict();
        }
        return after;
    }

    async function discoverAfterMutation(
        previous: DockerOverviewCachePayload,
        signal: AbortSignal
    ) {
        let firstFailure: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await options.collector.discover(previous, signal);
            } catch (error) {
                firstFailure ??= error;
                signal.throwIfAborted();
            }
        }
        throw firstFailure;
    }

    async function run(
        input: DockerJobUpdaterInput,
        signal?: AbortSignal,
        reportProgress?: DockerJobProgressReporter
    ): Promise<DockerUpdaterRunResult> {
        const operationSignal =
            signal === undefined
                ? AbortSignal.timeout(dockerOperationDeadlineMs)
                : AbortSignal.any([
                      signal,
                      AbortSignal.timeout(dockerOperationDeadlineMs),
                  ]);
        await reportProgress?.({
            message: "Discovering Docker services",
            phase: "discovering",
        });
        let discovery = await options.collector.discover(input.previous, operationSignal);
        if (
            input.expectedSourceRevision !== undefined &&
            discovery.payload.sourceRevision !== input.expectedSourceRevision
        ) {
            sourceConflict();
        }
        const scanResult = await scanDockerUpdates(
            discovery.compose,
            discovery.payload,
            operationSignal,
            { ...scanOptions, reportProgress }
        );
        let payload = scanResult.payload;
        const scannedPayload = payload;
        const selected = payload.updaterServices.filter((service) => {
            if (service.status.state !== "update-available") return false;
            if (service.policy.state !== "managed") return false;
            if (input.serviceId !== undefined) return service.id === input.serviceId;
            return !input.automaticOnly || service.policy.automatic;
        });
        await reportProgress?.({
            completed: 0,
            message: `Preparing ${selected.length} Docker update${selected.length === 1 ? "" : "s"}`,
            phase: "updating",
            total: selected.length,
        });
        if (input.serviceId !== undefined) {
            if (selected.length !== 1) sourceConflict();
            const selectedService = selected[0]!;
            if (
                selectedService.currentImage !== input.currentImage ||
                selectedService.status.state !== "update-available" ||
                selectedService.status.candidateImage !== input.candidateImage
            ) {
                sourceConflict();
            }
        }
        let expectedRepositoryHead: string;
        try {
            expectedRepositoryHead = await options.git.readHead(operationSignal);
        } catch {
            const git = Object.freeze({
                composePaths: Object.freeze([]),
                reason: "repository" as const,
                status: "unavailable" as const,
            });
            payload = v.parse(dockerOverviewCachePayloadSchema, {
                ...payload,
                updaterEvents: events(payload.updaterEvents, [
                    event(generateId, nowMs, {
                        kind: "source-sync-pending",
                        summary:
                            "Docker updates were not started because Git source synchronization was unavailable.",
                    }),
                ]),
            });
            return Object.freeze({
                failedCount: 0,
                git: publicGitResult(git),
                outcome: "source-sync-pending",
                payload,
                updatedCount: 0,
            });
        }
        const gitPreflight = await options.git.sync(
            { changes: [], expectedRepositoryHead },
            operationSignal
        );
        if (gitPreflight.status !== "no-change" && gitPreflight.status !== "pushed") {
            const outcome = gitOutcome(gitPreflight);
            payload = v.parse(dockerOverviewCachePayloadSchema, {
                ...payload,
                updaterEvents: events(payload.updaterEvents, [
                    event(generateId, nowMs, {
                        kind:
                            outcome === "unknown-outcome"
                                ? "update-outcome-unknown"
                                : "source-sync-pending",
                        summary:
                            outcome === "unknown-outcome"
                                ? "Docker updates were not started because Git source synchronization could not be confirmed."
                                : "Docker updates were not started because Git source synchronization is pending.",
                    }),
                ]),
            });
            return Object.freeze({
                failedCount: 0,
                git: publicGitResult(gitPreflight),
                outcome,
                payload,
                updatedCount: 0,
            });
        }
        if (selected.length === 0) {
            if (gitPreflight.status === "pushed") {
                payload = v.parse(dockerOverviewCachePayloadSchema, {
                    ...payload,
                    updaterEvents: events(payload.updaterEvents, [
                        event(generateId, nowMs, {
                            kind: "update-succeeded",
                            summary:
                                "Previously committed Docker Compose source was pushed.",
                        }),
                    ]),
                });
            }
            return Object.freeze({
                failedCount: 0,
                git: publicGitResult(gitPreflight),
                outcome: "completed",
                payload,
                updatedCount: 0,
            });
        }
        const preflightDiscovery = await options.collector.discover(
            payload,
            operationSignal
        );
        if (
            preflightDiscovery.payload.sourceRevision !== discovery.payload.sourceRevision
        ) {
            sourceConflict();
        }
        discovery = preflightDiscovery;
        const preMutationPayload = payload;
        const preMutationSettlementRevision = discovery.compose.settlementRevision;
        const revalidatedRuntimeImageIds = new Map<string, string>();
        const rollbackRuntimeReplicaCounts = new Map<string, number>();
        const updatedRuntimeImageIds = new Map<string, string>();
        const updatedRuntimeReplicaCounts = new Map<string, number>();
        const plannedSources = selected.map((selectedService) => {
            const source = exactService(
                discovery.compose.services,
                selectedService.project,
                selectedService.service
            );
            if (
                !source.enabled ||
                source.imageReference !== selectedService.currentImage
            ) {
                fail();
            }
            const runtime = exactRunningServiceRuntime(
                preMutationPayload,
                selectedService.project,
                selectedService.service
            );
            return Object.freeze({
                runtimeImageId: runtime.imageId,
                runtimeReplicaCount: runtime.replicaCount,
                selectedService,
                source,
            });
        });

        function verifyRestoredSources(
            restored: Awaited<ReturnType<DockerOverviewCollector["discover"]>>,
            affectedServices: readonly (typeof selected)[number][]
        ): void {
            const plannedById = new Map(
                plannedSources.map((planned) => [planned.selectedService.id, planned])
            );
            for (const service of affectedServices) {
                const planned = plannedById.get(service.id);
                if (planned === undefined) fail();
                const restoredSource = exactService(
                    restored.compose.services,
                    service.project,
                    service.service
                );
                if (
                    restoredSource.composePath !== planned.source.composePath ||
                    restoredSource.contentSha256 !== planned.source.contentSha256 ||
                    restoredSource.imageReference !== planned.source.imageReference ||
                    restoredSource.enabled !== planned.source.enabled ||
                    restoredSource.sourceAmbiguous !== planned.source.sourceAmbiguous ||
                    restoredSource.configFiles.length !==
                        planned.source.configFiles.length ||
                    restoredSource.configFiles.some(
                        (path, index) => path !== planned.source.configFiles[index]
                    )
                ) {
                    fail();
                }
            }
        }

        async function reconcileRestoredStack(
            previous: DockerOverviewCachePayload,
            affectedServices: readonly (typeof selected)[number][],
            signal: AbortSignal
        ) {
            const before = await options.collector.discover(previous, signal);
            if (before.compose.settlementRevision !== preMutationSettlementRevision) {
                sourceConflict();
            }
            verifyRestoredSources(before, affectedServices);
            await reconcileStack(
                affectedServices.map(({ service }) => service),
                signal
            );
            await options.afterReconcileStack?.(signal);
            const after = await options.collector.discover(before.payload, signal);
            if (after.compose.settlementRevision !== preMutationSettlementRevision) {
                sourceConflict();
            }
            verifyRestoredSources(after, affectedServices);
            return after;
        }
        const plannedFilesByPath = new Map<string, DockerUpdaterGitHeadFile>();
        for (const { source } of plannedSources) {
            const existing = plannedFilesByPath.get(source.composePath);
            if (
                existing !== undefined &&
                existing.expectedContentSha256 !== source.contentSha256
            ) {
                fail();
            }
            plannedFilesByPath.set(
                source.composePath,
                Object.freeze({
                    composePath: source.composePath,
                    expectedContentSha256: source.contentSha256,
                })
            );
        }
        try {
            await options.git.verifyHeadFiles(
                {
                    expectedRepositoryHead,
                    files: [...plannedFilesByPath.values()].toSorted((left, right) =>
                        compareStrings(left.composePath, right.composePath)
                    ),
                },
                operationSignal
            );
        } catch {
            const git = Object.freeze({
                composePaths: Object.freeze([]),
                reason: "conflict" as const,
                status: "unavailable" as const,
            });
            payload = v.parse(dockerOverviewCachePayloadSchema, {
                ...payload,
                updaterEvents: events(payload.updaterEvents, [
                    event(generateId, nowMs, {
                        kind: "source-sync-pending",
                        summary:
                            "Docker updates were not started because the planned Compose sources do not match Git HEAD.",
                    }),
                ]),
            });
            return Object.freeze({
                failedCount: 0,
                git: publicGitResult(git),
                outcome: "source-sync-pending",
                payload,
                updatedCount: 0,
            });
        }
        const changes = new Map<string, DockerUpdaterGitSyncChange>();
        const successful: typeof selected = [];
        const applied: Array<{
            readonly result: DockerComposeImageUpdateResult;
            readonly service: (typeof selected)[number];
        }> = [];

        async function rollbackAndVerify(
            updates: readonly (typeof applied)[number][],
            affectedServices: readonly (typeof selected)[number][]
        ): Promise<DockerOverviewCachePayload | undefined> {
            const recoverySignal = AbortSignal.timeout(dockerRecoveryDeadlineMs);
            let rollbackCompleted = true;
            for (const update of updates.toReversed()) {
                try {
                    rollbackCompleted =
                        (await update.result.rollback(recoverySignal)) &&
                        rollbackCompleted;
                } catch {
                    rollbackCompleted = false;
                }
            }
            if (!rollbackCompleted) return undefined;

            try {
                const restored = await reconcileRestoredStack(
                    preMutationPayload,
                    affectedServices,
                    recoverySignal
                );
                const plannedById = new Map(
                    plannedSources.map((planned) => [planned.selectedService.id, planned])
                );
                for (const service of affectedServices) {
                    const planned = plannedById.get(service.id);
                    if (planned === undefined) fail();
                    const restoredSource = exactService(
                        restored.compose.services,
                        service.project,
                        service.service
                    );
                    if (
                        restoredSource.composePath !== planned.source.composePath ||
                        restoredSource.contentSha256 !== planned.source.contentSha256 ||
                        restoredSource.imageReference !== planned.source.imageReference ||
                        (() => {
                            const runtime = exactRunningServiceRuntime(
                                restored.payload,
                                service.project,
                                service.service
                            );
                            return (
                                runtime.imageId !==
                                    (revalidatedRuntimeImageIds.get(service.id) ??
                                        planned.runtimeImageId) ||
                                runtime.replicaCount !==
                                    (rollbackRuntimeReplicaCounts.get(service.id) ??
                                        planned.runtimeReplicaCount)
                            );
                        })()
                    ) {
                        fail();
                    }
                }
                return restored.payload;
            } catch {
                return undefined;
            }
        }

        const addedEvents: DockerUpdaterEvent[] = [];
        let failedCount = 0;
        for (const [selectedIndex, selectedService] of selected.entries()) {
            operationSignal.throwIfAborted();
            await reportProgress?.({
                completed: selectedIndex,
                message: `Updating ${selectedService.project}/${selectedService.service}`,
                phase: "updating",
                total: selected.length,
            });
            if (selectedService.status.state !== "update-available") fail();
            const source = exactService(
                discovery.compose.services,
                selectedService.project,
                selectedService.service
            );
            if (
                !source.enabled ||
                source.imageReference !== selectedService.currentImage
            ) {
                fail();
            }
            const targetImageReference = selectedService.status.candidateImage;
            const before =
                changes.get(source.composePath)?.expectedBeforeContentSha256 ??
                source.contentSha256;
            const expectedDiscoveryRevision = discovery.payload.sourceRevision;
            let updateSucceeded = false;
            let updateResult: DockerComposeImageUpdateResult | undefined;
            try {
                updateResult = await updateImage(
                    {
                        expectedContentSha256: source.contentSha256,
                        expectedImageReference: source.imageReference,
                        project: source.project,
                        service: source.service,
                        targetImageReference,
                    },
                    {
                        composePath: source.composePath,
                        revalidateTarget: async (phase, revalidationSignal) => {
                            const current = await options.collector.discover(
                                payload,
                                revalidationSignal
                            );
                            if (
                                phase === "pre-update" &&
                                current.payload.sourceRevision !==
                                    expectedDiscoveryRevision
                            ) {
                                throw new DockerComposeImageUpdateError("conflict");
                            }
                            const runtime = exactRunningServiceRuntime(
                                current.payload,
                                source.project,
                                source.service
                            );
                            if (phase === "pre-update") {
                                revalidatedRuntimeImageIds.set(
                                    selectedService.id,
                                    runtime.imageId
                                );
                            } else {
                                rollbackRuntimeReplicaCounts.set(
                                    selectedService.id,
                                    runtime.replicaCount
                                );
                            }
                            return Object.freeze({
                                runtimeImageId: runtime.imageId,
                                target: exactService(
                                    current.compose.services,
                                    source.project,
                                    source.service
                                ),
                            });
                        },
                        runCompose: composeRunner,
                        restoreImageReference,
                    },
                    operationSignal
                );
                updateSucceeded = true;
                discovery = await discoverAfterMutation(payload, operationSignal);
                payload = discovery.payload;
                const after = exactService(
                    discovery.compose.services,
                    source.project,
                    source.service
                );
                if (after.imageReference !== targetImageReference) fail();
                const updatedRuntime = exactRunningServiceRuntime(
                    discovery.payload,
                    selectedService.project,
                    selectedService.service,
                    targetImageReference
                );
                updatedRuntimeImageIds.set(selectedService.id, updatedRuntime.imageId);
                updatedRuntimeReplicaCounts.set(
                    selectedService.id,
                    updatedRuntime.replicaCount
                );
                changes.set(source.composePath, {
                    composePath: source.composePath,
                    expectedAfterContentSha256: after.contentSha256,
                    expectedBeforeContentSha256: before,
                });
                successful.push(selectedService);
                applied.push({ result: updateResult, service: selectedService });
            } catch (error) {
                if (
                    updateSucceeded ||
                    !(error instanceof DockerComposeImageUpdateError) ||
                    !error.rollbackCompleted
                ) {
                    if (updateResult === undefined) {
                        for (const update of applied) update.result.settle();
                    } else {
                        const affectedUpdates = [
                            ...applied,
                            { result: updateResult, service: selectedService },
                        ];
                        const affectedServices = [...successful, selectedService];
                        const restoredPayload = await rollbackAndVerify(
                            affectedUpdates,
                            affectedServices
                        );
                        if (restoredPayload !== undefined) {
                            const failureEvents = affectedServices.map((service) =>
                                event(generateId, nowMs, {
                                    kind: "update-failed",
                                    serviceId: service.id,
                                    summary: verificationFailureSummary(
                                        error,
                                        service.project,
                                        service.service
                                    ),
                                })
                            );
                            return Object.freeze({
                                failedCount: failedCount + affectedServices.length,
                                git: Object.freeze({ status: "no-change" as const }),
                                outcome: "completed-with-failures" as const,
                                payload: v.parse(dockerOverviewCachePayloadSchema, {
                                    ...restoredPayload,
                                    updaterEvents: events(restoredPayload.updaterEvents, [
                                        ...addedEvents,
                                        ...failureEvents,
                                    ]),
                                }),
                                updatedCount: 0,
                            });
                        }
                    }
                    return unknownMutationResult({
                        addedEvents,
                        affectedServices: [...successful, selectedService],
                        confirmedCurrentIds:
                            updateResult === undefined
                                ? new Set(successful.map(({ id }) => id))
                                : new Set(),
                        failedCount,
                        failureStage: "Compose apply or rollback verification",
                        generateId,
                        nowMs,
                        payload,
                        updatedCount: updateResult === undefined ? successful.length : 0,
                    });
                }
                const recovered = await options.collector.discover(
                    payload,
                    operationSignal
                );
                if (error.reason === "conflict") {
                    sourceConflict();
                }
                const recoveredSource = exactService(
                    recovered.compose.services,
                    source.project,
                    source.service
                );
                if (
                    recoveredSource.contentSha256 !== source.contentSha256 ||
                    recoveredSource.imageReference !== source.imageReference
                ) {
                    fail();
                }
                discovery = recovered;
                payload = recovered.payload;
                failedCount += 1;
                addedEvents.push(
                    event(generateId, nowMs, {
                        kind: "update-failed",
                        serviceId: selectedService.id,
                        summary: `Update failed for ${selectedService.project}/${selectedService.service}; the prior source was retained.`,
                    })
                );
            }
            await reportProgress?.({
                completed: selectedIndex + 1,
                message: `Processed ${selectedService.project}/${selectedService.service}`,
                phase: "updating",
                total: selected.length,
            });
        }

        if (applied.length > 0) {
            await reportProgress?.({
                message: "Reconciling the Docker Compose stack",
                phase: "reconciling",
            });
            try {
                discovery = await reconcileVerifiedStack(
                    payload,
                    discovery.compose.sourceRevision,
                    successful.map(({ service }) => service),
                    operationSignal
                );
                for (const selectedService of successful) {
                    const runtime = exactRunningServiceRuntime(
                        discovery.payload,
                        selectedService.project,
                        selectedService.service
                    );
                    if (
                        runtime.imageId !==
                            updatedRuntimeImageIds.get(selectedService.id) ||
                        runtime.replicaCount !==
                            updatedRuntimeReplicaCounts.get(selectedService.id)
                    ) {
                        fail();
                    }
                }
                payload = discovery.payload;
            } catch {
                const recoverySignal = AbortSignal.timeout(dockerRecoveryDeadlineMs);
                let recovered = true;
                for (const update of applied.toReversed()) {
                    recovered =
                        (await update.result.rollback(recoverySignal)) && recovered;
                }
                try {
                    const restored = await reconcileRestoredStack(
                        preMutationPayload,
                        successful,
                        recoverySignal
                    );
                    for (const {
                        runtimeImageId,
                        runtimeReplicaCount,
                        selectedService,
                        source,
                    } of plannedSources) {
                        const restoredSource = exactService(
                            restored.compose.services,
                            selectedService.project,
                            selectedService.service
                        );
                        if (
                            restoredSource.composePath !== source.composePath ||
                            restoredSource.contentSha256 !== source.contentSha256 ||
                            restoredSource.imageReference !== source.imageReference ||
                            (() => {
                                const runtime = exactRunningServiceRuntime(
                                    restored.payload,
                                    selectedService.project,
                                    selectedService.service
                                );
                                return (
                                    runtime.imageId !==
                                        (revalidatedRuntimeImageIds.get(
                                            selectedService.id
                                        ) ?? runtimeImageId) ||
                                    runtime.replicaCount !==
                                        (rollbackRuntimeReplicaCounts.get(
                                            selectedService.id
                                        ) ?? runtimeReplicaCount)
                                );
                            })()
                        ) {
                            fail();
                        }
                    }
                    payload = restored.payload;
                } catch {
                    recovered = false;
                }
                if (!recovered) {
                    return unknownMutationResult({
                        addedEvents,
                        affectedServices: successful,
                        confirmedCurrentIds: new Set(),
                        failedCount,
                        failureStage:
                            "full-stack reconciliation and rollback verification",
                        generateId,
                        nowMs,
                        payload,
                        updatedCount: 0,
                    });
                }
                const reconcileEvents = successful.map((service) =>
                    event(generateId, nowMs, {
                        kind: "update-failed",
                        serviceId: service.id,
                        summary: `Update failed for ${service.project}/${service.service}; full stack reconciliation failed and the prior state was restored.`,
                    })
                );
                payload = v.parse(dockerOverviewCachePayloadSchema, {
                    ...payload,
                    updaterEvents: events(payload.updaterEvents, [
                        ...addedEvents,
                        ...reconcileEvents,
                    ]),
                });
                return Object.freeze({
                    failedCount: failedCount + successful.length,
                    git: Object.freeze({ status: "no-change" as const }),
                    outcome: "completed-with-failures" as const,
                    payload,
                    updatedCount: 0,
                });
            }
        }

        let git: DockerUpdaterGitSyncResult;
        await reportProgress?.({
            message: "Settling Docker source changes",
            phase: "settling",
        });
        try {
            git = await options.git.sync(
                {
                    changes: [...changes.values()].toSorted((left, right) =>
                        compareStrings(left.composePath, right.composePath)
                    ),
                    expectedRepositoryHead,
                },
                operationSignal
            );
        } catch (error) {
            if (successful.length === 0) fail(error);
            for (const update of applied) update.result.settle();
            const successfulIds = new Set(successful.map(({ id }) => id));
            return unknownMutationResult({
                addedEvents,
                affectedServices: successful,
                confirmedCurrentIds: successfulIds,
                failedCount,
                failureStage: "Git source settlement",
                generateId,
                nowMs,
                payload,
                updatedCount: successful.length,
            });
        }
        if (git.status === "unavailable" && applied.length > 0) {
            const recoverySignal = AbortSignal.timeout(dockerRecoveryDeadlineMs);
            let rollbackCompleted = true;
            for (const update of applied.toReversed()) {
                rollbackCompleted =
                    (await update.result.rollback(recoverySignal)) && rollbackCompleted;
            }
            let recoveredPayload: DockerOverviewCachePayload | undefined;
            if (rollbackCompleted) {
                try {
                    const recovered = await reconcileRestoredStack(
                        preMutationPayload,
                        successful,
                        recoverySignal
                    );
                    for (const {
                        runtimeImageId,
                        runtimeReplicaCount,
                        selectedService,
                        source,
                    } of plannedSources) {
                        const recoveredSource = exactService(
                            recovered.compose.services,
                            selectedService.project,
                            selectedService.service
                        );
                        if (
                            recoveredSource.composePath !== source.composePath ||
                            recoveredSource.contentSha256 !== source.contentSha256 ||
                            recoveredSource.imageReference !== source.imageReference ||
                            (() => {
                                const runtime = exactRunningServiceRuntime(
                                    recovered.payload,
                                    selectedService.project,
                                    selectedService.service
                                );
                                return (
                                    runtime.imageId !==
                                        (revalidatedRuntimeImageIds.get(
                                            selectedService.id
                                        ) ?? runtimeImageId) ||
                                    runtime.replicaCount !==
                                        (rollbackRuntimeReplicaCounts.get(
                                            selectedService.id
                                        ) ?? runtimeReplicaCount)
                                );
                            })()
                        ) {
                            fail();
                        }
                    }
                    recoveredPayload = recovered.payload;
                } catch {
                    rollbackCompleted = false;
                }
            }
            if (!rollbackCompleted || recoveredPayload === undefined) {
                return unknownMutationResult({
                    addedEvents,
                    affectedServices: successful,
                    confirmedCurrentIds: new Set(),
                    failedCount,
                    failureStage: "Git rejection and rollback verification",
                    generateId,
                    nowMs,
                    payload,
                    updatedCount: 0,
                });
            }
            const rollbackEvents = successful.map((service) =>
                event(generateId, nowMs, {
                    kind: "update-failed",
                    serviceId: service.id,
                    summary: `Update failed for ${service.project}/${service.service}; Git rejected the source before commit and the prior state was restored.`,
                })
            );
            payload = v.parse(dockerOverviewCachePayloadSchema, {
                ...recoveredPayload,
                updaterEvents: events(recoveredPayload.updaterEvents, [
                    ...addedEvents,
                    ...rollbackEvents,
                ]),
            });
            return Object.freeze({
                failedCount: failedCount + successful.length,
                git: publicGitResult(git),
                outcome: "completed-with-failures",
                payload,
                updatedCount: 0,
            });
        }
        for (const update of applied) update.result.settle();
        let outcome = gitOutcome(git);
        if (outcome === "completed" && failedCount > 0) {
            outcome = "completed-with-failures";
        }
        const successfulIds = new Set(successful.map(({ id }) => id));
        payload = v.parse(dockerOverviewCachePayloadSchema, {
            ...payload,
            updaterServices: retainUnchangedScannedStatuses(
                scannedPayload,
                payload,
                successfulIds
            ),
        });
        const settlementKind = updateSettlementEventKind(outcome);
        for (const service of successful) {
            addedEvents.push(
                event(generateId, nowMs, {
                    kind: settlementKind,
                    serviceId: service.id,
                    summary: updateSettlementSummary(settlementKind, service),
                })
            );
        }
        payload = v.parse(dockerOverviewCachePayloadSchema, {
            ...payload,
            updaterEvents: events(payload.updaterEvents, addedEvents),
        });
        return Object.freeze({
            failedCount,
            git: publicGitResult(git),
            outcome,
            payload,
            updatedCount: successful.length,
        });
    }

    return Object.freeze({
        refresh: (previous?: unknown, signal?: AbortSignal) =>
            options.collector.collect(previous, signal),
        run,
        scan,
    });
}
