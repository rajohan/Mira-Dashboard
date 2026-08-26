import * as v from "valibot";

import {
    dockerOverviewCachePayloadSchema,
    dockerUpdaterEventMaximum,
    type DockerOverviewCachePayload,
    type DockerUpdaterEvent,
} from "../../contracts/docker.ts";
import {
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
import type { DockerOverviewCollector } from "./overviewCollector.ts";
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
        signal?: AbortSignal
    ) => Promise<DockerUpdaterRunResult>;
    readonly scan: (
        previous?: unknown,
        signal?: AbortSignal
    ) => Promise<DockerOverviewCachePayload>;
}

export interface DockerUpdaterServiceOptions {
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

function exactRunningServiceImageId(
    payload: DockerOverviewCachePayload,
    project: string,
    service: string
): string {
    const matching = payload.containers.filter(
        (container) => container.project === project && container.service === service
    );
    if (matching.length === 0 || matching.some(({ state }) => state !== "running")) {
        return fail();
    }
    const imageIds = new Set(matching.map(({ imageId }) => imageId));
    if (imageIds.size !== 1) return fail();
    return imageIds.values().next().value!;
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
            summary: `Update outcome for ${service.project}/${service.service} could not be confirmed; Docker and Compose state require reconciliation.`,
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
        ((signal) => reconcileDockerComposeStack(composeRunner, signal));
    const updateImage = options.updateImage ?? updateDockerComposeImage;
    const scanOptions = Object.freeze({
        ...options.scan,
        generateId,
        nowMs,
    });

    async function scan(
        previous?: unknown,
        signal?: AbortSignal
    ): Promise<DockerOverviewCachePayload> {
        const discovery = await options.collector.discover(previous, signal);
        const result = await scanDockerUpdates(
            discovery.compose,
            discovery.payload,
            signal,
            scanOptions
        );
        return result.payload;
    }

    async function run(
        input: DockerJobUpdaterInput,
        signal?: AbortSignal
    ): Promise<DockerUpdaterRunResult> {
        let discovery = await options.collector.discover(input.previous, signal);
        if (
            input.expectedSourceRevision !== undefined &&
            discovery.payload.sourceRevision !== input.expectedSourceRevision
        ) {
            sourceConflict();
        }
        const scanResult = await scanDockerUpdates(
            discovery.compose,
            discovery.payload,
            signal,
            scanOptions
        );
        let payload = scanResult.payload;
        const selected = payload.updaterServices.filter((service) => {
            if (service.status.state !== "update-available") return false;
            if (service.policy.state !== "managed") return false;
            if (input.serviceId !== undefined) return service.id === input.serviceId;
            return service.policy.automatic;
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
            expectedRepositoryHead = await options.git.readHead(signal);
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
            signal
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
        const preflightDiscovery = await options.collector.discover(payload, signal);
        if (
            preflightDiscovery.payload.sourceRevision !== discovery.payload.sourceRevision
        ) {
            sourceConflict();
        }
        discovery = preflightDiscovery;
        const preMutationPayload = payload;
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
            return Object.freeze({ selectedService, source });
        });
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
                signal
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
        const addedEvents: DockerUpdaterEvent[] = [];
        let failedCount = 0;
        for (const selectedService of selected) {
            signal?.throwIfAborted();
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
                            return Object.freeze({
                                runtimeImageId: exactRunningServiceImageId(
                                    current.payload,
                                    source.project,
                                    source.service
                                ),
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
                    signal
                );
                updateSucceeded = true;
                discovery = await options.collector.discover(payload, signal);
                payload = discovery.payload;
                const after = exactService(
                    discovery.compose.services,
                    source.project,
                    source.service
                );
                if (after.imageReference !== targetImageReference) fail();
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
                        for (const update of [
                            ...applied,
                            { result: updateResult, service: selectedService },
                        ].toReversed()) {
                            await update.result.rollback();
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
                        generateId,
                        nowMs,
                        payload,
                        updatedCount: updateResult === undefined ? successful.length : 0,
                    });
                }
                const recovered = await options.collector.discover(payload, signal);
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
        }

        if (applied.length > 0) {
            try {
                await reconcileStack(signal);
                discovery = await options.collector.discover(payload, signal);
                payload = discovery.payload;
            } catch {
                let recovered = true;
                for (const update of applied.toReversed()) {
                    recovered = (await update.result.rollback()) && recovered;
                }
                if (recovered) {
                    try {
                        await reconcileStack(signal);
                        const restored = await options.collector.discover(
                            preMutationPayload,
                            signal
                        );
                        for (const { selectedService, source } of plannedSources) {
                            const restoredSource = exactService(
                                restored.compose.services,
                                selectedService.project,
                                selectedService.service
                            );
                            if (
                                restoredSource.composePath !== source.composePath ||
                                restoredSource.contentSha256 !== source.contentSha256 ||
                                restoredSource.imageReference !== source.imageReference
                            ) {
                                fail();
                            }
                        }
                        payload = restored.payload;
                    } catch {
                        recovered = false;
                    }
                }
                if (!recovered) {
                    return unknownMutationResult({
                        addedEvents,
                        affectedServices: successful,
                        confirmedCurrentIds: new Set(),
                        failedCount,
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
        try {
            git = await options.git.sync(
                {
                    changes: [...changes.values()].toSorted((left, right) =>
                        compareStrings(left.composePath, right.composePath)
                    ),
                    expectedRepositoryHead,
                },
                signal
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
                generateId,
                nowMs,
                payload,
                updatedCount: successful.length,
            });
        }
        if (git.status === "unavailable" && applied.length > 0) {
            let rollbackCompleted = true;
            for (const update of applied.toReversed()) {
                rollbackCompleted = (await update.result.rollback()) && rollbackCompleted;
            }
            let recoveredPayload: DockerOverviewCachePayload | undefined;
            if (rollbackCompleted) {
                try {
                    const recovered = await options.collector.discover(
                        preMutationPayload,
                        signal
                    );
                    for (const { selectedService, source } of plannedSources) {
                        const recoveredSource = exactService(
                            recovered.compose.services,
                            selectedService.project,
                            selectedService.service
                        );
                        if (
                            recoveredSource.composePath !== source.composePath ||
                            recoveredSource.contentSha256 !== source.contentSha256 ||
                            recoveredSource.imageReference !== source.imageReference
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
            updaterServices: payload.updaterServices.map((service) =>
                successfulIds.has(service.id)
                    ? { ...service, status: { state: "current" as const } }
                    : service
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
