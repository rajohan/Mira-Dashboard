import { Effect } from "effect";
import * as v from "valibot";

import {
    dockerOverviewCacheKey,
    dockerOverviewCachePayloadSchema,
    dockerOverviewCacheSchemaId,
    dockerOverviewCacheSource,
    type DockerOverviewCachePayload,
    type DockerUpdaterEvent,
} from "../../../contracts/docker.ts";
import {
    DockerUpdaterSourceConflictError,
    type DockerJobExecutionPort,
    type DockerJobUpdaterInput,
    type DockerJobUpdaterResult,
    type DockerOperationJobPayload,
} from "../../../contracts/dockerWorker.ts";
import type { UpsertNotificationInput } from "../../../contracts/notifications.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { parseDockerOperationJobPayload } from "../docker/jobPayload.ts";
import {
    type JobActionExecutionContext,
    type JobActionExecutor,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
} from "./actionRegistry.ts";
export type {
    DockerJobExecutionPort,
    DockerJobUpdaterResult,
} from "../../../contracts/dockerWorker.ts";

const dockerOverviewTtlMs = 5 * 60_000;
const scheduledUpdaterPayloadSchema = v.strictObject({
    kind: v.literal("updater-run"),
});

type DockerPostSettlementWarning =
    | "docker-notification-publication-failed"
    | "docker-overview-cache-commit-failed"
    | "docker-overview-refresh-failed";

const notificationPolicy = Object.freeze({
    "discovery-failed": Object.freeze({
        severity: "warning" as const,
        title: "Docker discovery failed",
    }),
    "scan-failed": Object.freeze({
        severity: "warning" as const,
        title: "Docker update scan failed",
    }),
    "source-sync-pending": Object.freeze({
        severity: "warning" as const,
        title: "Docker source sync pending",
    }),
    "update-available": Object.freeze({
        severity: "info" as const,
        title: "Docker update available",
    }),
    "update-failed": Object.freeze({
        severity: "error" as const,
        title: "Docker update failed",
    }),
    "update-outcome-unknown": Object.freeze({
        severity: "error" as const,
        title: "Docker update outcome unknown",
    }),
    "update-succeeded": Object.freeze({
        severity: "info" as const,
        title: "Docker update completed",
    }),
});

/**
 * Maps material updater transitions to the existing global notification catalog.
 * @returns A notification for material transitions, or undefined for scan completion.
 */
export function dockerUpdaterEventNotification(
    event: DockerUpdaterEvent
): UpsertNotificationInput | undefined {
    if (event.kind === "scan-completed") return undefined;
    const policy = notificationPolicy[event.kind];
    return {
        id: event.id,
        kind: `docker.${event.kind}`,
        linkUrl: "/docker",
        message: event.summary,
        occurredAtMs: event.atMs,
        severity: policy.severity,
        source: "docker-updater",
        title: policy.title,
    };
}

export function dockerUpdaterEventsNotification(
    events: readonly DockerUpdaterEvent[]
): UpsertNotificationInput | undefined {
    const material = events.filter(({ kind }) => kind !== "scan-completed");
    if (material.length === 0) return undefined;
    if (material.length === 1) return dockerUpdaterEventNotification(material[0]!);
    const notifications = material.map((event) => dockerUpdaterEventNotification(event)!);
    const severityOrder = { critical: 4, error: 3, warning: 2, info: 1 } as const;
    const severity = notifications.toSorted(
        (left, right) => severityOrder[right.severity] - severityOrder[left.severity]
    )[0]!.severity;
    const onlyUpdates = material.every(({ kind }) => kind === "update-available");
    return {
        id: material.toSorted((left, right) => right.atMs - left.atMs)[0]!.id,
        kind: onlyUpdates ? "docker.updates-available" : "docker.run-summary",
        linkUrl: "/docker",
        message: onlyUpdates
            ? "Docker services have updates available."
            : "Docker updater events were recorded in this run.",
        occurredAtMs: Math.max(...material.map(({ atMs }) => atMs)),
        severity,
        source: "docker-updater",
        title: onlyUpdates ? "Docker updates available" : "Docker updater report",
    };
}

function parsedPrevious(
    port: DockerJobExecutionPort
): DockerOverviewCachePayload | undefined {
    const parsed = v.safeParse(dockerOverviewCachePayloadSchema, port.readPrevious());
    return parsed.success ? parsed.output : undefined;
}

function newlyEmittedEvents(
    previous: DockerOverviewCachePayload | undefined,
    current: DockerOverviewCachePayload
): readonly DockerUpdaterEvent[] {
    const previousIds = new Set(previous?.updaterEvents.map(({ id }) => id));
    return Object.freeze(current.updaterEvents.filter(({ id }) => !previousIds.has(id)));
}

async function persistSnapshot(
    context: JobActionExecutionContext,
    payload: DockerOverviewCachePayload,
    durationMs: number
): Promise<void> {
    await context.commitCacheAttempt({
        durationMs,
        entries: [
            {
                key: dockerOverviewCacheKey,
                metadata: { kind: "docker-overview" },
                payload,
                schemaId: dockerOverviewCacheSchemaId,
                source: dockerOverviewCacheSource,
                ttlMs: dockerOverviewTtlMs,
            },
        ],
        kind: "succeeded",
    });
}

async function persistFailure(
    context: JobActionExecutionContext,
    durationMs: number
): Promise<void> {
    await context.commitCacheAttempt({
        durationMs,
        failureCode: "provider/docker-overview-unavailable",
        failureMessage: "Docker overview projection could not be collected.",
        key: dockerOverviewCacheKey,
        kind: "failed",
    });
}

async function publishEvents(
    port: DockerJobExecutionPort,
    context: JobActionExecutionContext,
    events: readonly DockerUpdaterEvent[]
): Promise<DockerPostSettlementWarning | undefined> {
    if (events.length === 0 || port.publishEvents === undefined) return undefined;
    let published = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await port.publishEvents(events);
            published = true;
            break;
        } catch {
            // Retry the one run-level publication when its outcome is unconfirmed.
        }
    }
    if (!published) {
        await writePostSettlementWarning(
            context,
            "Docker notification publication failed after bounded retries; the durable Docker job result remains authoritative."
        );
        return "docker-notification-publication-failed";
    }
    return undefined;
}

async function writePostSettlementWarning(
    context: JobActionExecutionContext,
    message: string
): Promise<void> {
    try {
        await Effect.runPromise(context.writeOutput("stderr", message));
    } catch {
        // Post-settlement diagnostics must never replace the authoritative effect result.
    }
}

function warningResult(warnings: readonly DockerPostSettlementWarning[]): {
    readonly postSettlementWarnings?: readonly DockerPostSettlementWarning[];
} {
    return warnings.length === 0
        ? {}
        : { postSettlementWarnings: Object.freeze([...warnings]) };
}

async function persistSettledSnapshot(
    context: JobActionExecutionContext,
    payload: DockerOverviewCachePayload,
    durationMs: number
): Promise<boolean> {
    try {
        await persistSnapshot(context, payload, durationMs);
        return true;
    } catch {
        await writePostSettlementWarning(
            context,
            "The Docker action settled, but its refreshed overview could not be committed; the durable job result remains authoritative."
        );
        return false;
    }
}

function elapsed(startedAt: number): number {
    return Math.max(0, Math.floor(performance.now() - startedAt));
}

function discoveryFailureEvent(atMs: number): DockerUpdaterEvent {
    return {
        atMs,
        id: Bun.randomUUIDv7(),
        kind: "discovery-failed",
        summary:
            "Docker discovery failed. The last successful overview remains available when retained.",
    };
}

/**
 * Creates the periodic dynamic Engine/Compose cache refresh action.
 * @returns The worker-only Docker overview executor.
 */
export function createDockerOverviewJobExecutor(
    port: DockerJobExecutionPort
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                v.parse(
                    v.strictObject({ key: v.literal(dockerOverviewCacheKey) }),
                    rawPayload
                );
                const startedAt = performance.now();
                const previous = parsedPrevious(port);
                const previousAttemptStatus = port.readPreviousAttemptStatus?.();
                let payload: DockerOverviewCachePayload;
                try {
                    payload = await port.refresh(previous, signal);
                } catch (error) {
                    const failurePersisted = await persistFailure(
                        context,
                        elapsed(startedAt)
                    ).then(
                        () => true,
                        () => false
                    );
                    if (failurePersisted && previousAttemptStatus !== "failed") {
                        await publishEvents(port, context, [
                            discoveryFailureEvent(context.nowMs()),
                        ]);
                    }
                    throw new JobActionRetryableError(error);
                }
                await persistSnapshot(context, payload, elapsed(startedAt));
                return {
                    cacheKeys: [dockerOverviewCacheKey],
                    completedAtMs: context.nowMs(),
                };
            },
        });
}

function updaterInput(
    payload: JsonObject
):
    | { readonly operation: "scheduled" }
    | { readonly operation: "manual"; readonly payload: DockerOperationJobPayload } {
    const scheduled = v.safeParse(scheduledUpdaterPayloadSchema, payload);
    if (scheduled.success) return { operation: "scheduled" };
    const parsed = parseDockerOperationJobPayload(payload);
    if (
        parsed.operation !== "updater-run" &&
        parsed.operation !== "updater-scan" &&
        parsed.operation !== "updater-update-service"
    ) {
        throw new TypeError("Docker updater job payload is invalid");
    }
    return { operation: "manual", payload: parsed };
}

/**
 * Creates both scheduled and explicit source-fenced updater action execution.
 * @returns The worker-only Docker updater executor.
 */
export function createDockerUpdaterJobExecutor(
    port: DockerJobExecutionPort
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                const parsed = updaterInput(rawPayload);
                const startedAt = performance.now();
                const previous = parsedPrevious(port);
                if (
                    parsed.operation === "manual" &&
                    parsed.payload.operation === "updater-scan"
                ) {
                    try {
                        const payload = await port.scan(previous, signal);
                        if (payload.sourceRevision !== parsed.payload.sourceRevision) {
                            throw new DockerUpdaterSourceConflictError();
                        }
                        await persistSnapshot(context, payload, elapsed(startedAt));
                        const notificationWarning = await publishEvents(
                            port,
                            context,
                            newlyEmittedEvents(previous, payload)
                        );
                        const warnings =
                            notificationWarning === undefined
                                ? []
                                : [notificationWarning];
                        return {
                            completedAtMs: context.nowMs(),
                            failedCount: 0,
                            outcome: "completed",
                            ...warningResult(warnings),
                            updatedCount: 0,
                        };
                    } catch (error) {
                        if (!(error instanceof DockerUpdaterSourceConflictError)) {
                            await persistFailure(context, elapsed(startedAt)).catch(
                                () => {}
                            );
                        }
                        throw new JobActionRetryableError(error);
                    }
                }

                let result: DockerJobUpdaterResult;
                try {
                    const manual =
                        parsed.operation === "manual" ? parsed.payload : undefined;
                    let input: DockerJobUpdaterInput;
                    if (manual?.operation === "updater-update-service") {
                        input = {
                            candidateImage: manual.candidateImage,
                            currentImage: manual.currentImage,
                            expectedSourceRevision: manual.sourceRevision,
                            previous,
                            serviceId: manual.serviceId,
                        };
                    } else if (manual === undefined) {
                        input = { previous };
                    } else {
                        input = {
                            expectedSourceRevision: manual.sourceRevision,
                            previous,
                        };
                    }
                    result = await port.runUpdater(input, signal);
                } catch (error) {
                    if (error instanceof JobActionOutcomeUnknownError) throw error;
                    if (!(error instanceof DockerUpdaterSourceConflictError)) {
                        await persistFailure(context, elapsed(startedAt)).catch(() => {});
                    }
                    throw new JobActionRetryableError(error);
                }

                const warnings: DockerPostSettlementWarning[] = [];
                const cacheCommitted = await persistSettledSnapshot(
                    context,
                    result.payload,
                    elapsed(startedAt)
                );
                if (!cacheCommitted) {
                    warnings.push("docker-overview-cache-commit-failed");
                }
                if (cacheCommitted) {
                    const notificationWarning = await publishEvents(
                        port,
                        context,
                        newlyEmittedEvents(previous, result.payload)
                    );
                    if (notificationWarning !== undefined) {
                        warnings.push(notificationWarning);
                    }
                }
                if (result.outcome === "unknown-outcome") {
                    throw new JobActionOutcomeUnknownError();
                }
                return {
                    completedAtMs: context.nowMs(),
                    failedCount: result.failedCount,
                    outcome: result.outcome,
                    ...warningResult(warnings),
                    updatedCount: result.updatedCount,
                };
            },
        });
}

/**
 * Creates exact non-updater Docker operations followed by one fresh projection.
 * @returns The worker-only fixed Docker operation executor.
 */
export function createDockerOperationJobExecutor(
    port: DockerJobExecutionPort
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                const payload = parseDockerOperationJobPayload(rawPayload);
                if (
                    payload.operation === "updater-run" ||
                    payload.operation === "updater-scan" ||
                    payload.operation === "updater-update-service"
                ) {
                    throw new TypeError("Docker operation job payload is invalid");
                }
                const startedAt = performance.now();
                const previous = parsedPrevious(port);
                const result = await port.execute(payload, signal);
                if (result.outcome === "unknown-outcome") {
                    throw new JobActionOutcomeUnknownError();
                }
                const warnings: DockerPostSettlementWarning[] = [];
                try {
                    const overview = await port.refresh(previous, signal);
                    const cacheCommitted = await persistSettledSnapshot(
                        context,
                        overview,
                        elapsed(startedAt)
                    );
                    if (!cacheCommitted) {
                        warnings.push("docker-overview-cache-commit-failed");
                    }
                } catch {
                    await persistFailure(context, elapsed(startedAt)).catch(() => {});
                    warnings.push("docker-overview-refresh-failed");
                    await writePostSettlementWarning(
                        context,
                        "The Docker operation completed, but its follow-up overview refresh failed; the durable operation result remains authoritative."
                    );
                }
                return {
                    completedAtMs: context.nowMs(),
                    operation: result.operation,
                    ...warningResult(warnings),
                    status: "completed",
                    targetCount: result.targetCount,
                };
            },
        });
}
