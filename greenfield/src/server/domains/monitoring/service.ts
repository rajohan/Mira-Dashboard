import {
    addMilliseconds,
    compareAsc,
    differenceInMilliseconds,
    getTime,
    minutesToMilliseconds,
    toDate,
} from "date-fns";
import { Context, Data, Effect, Layer, Schema } from "effect";

import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    isDatabaseRuntimeWriteUnavailableError,
    type DatabaseRuntimeWriteUnavailableError,
} from "../../database/runtime/databaseErrors.ts";
import { defaultRealtimeRetentionMilliseconds } from "../realtime/retention.ts";
import {
    MonitoringSnapshotValidationError,
    normalizeMonitoringSnapshot,
    type NormalizedMonitoringProblem,
} from "./normalization.ts";
import {
    insertRealtimeEvent,
    monitoringRealtimeTopics,
    type MutableSubmissionCounts,
} from "./realtimeEvents.ts";
import type { MonitoringRepository } from "./repository.ts";
import { serializeMonitoringJsonObject } from "./serialization.ts";
import { applyMonitoringSnapshotLifecycle } from "./snapshotLifecycle.ts";

export { monitoringRealtimeTopics } from "./realtimeEvents.ts";
export { MonitoringSnapshotValidationError } from "./normalization.ts";

const TaggedErrorClass = Schema.TaggedError;
const maximumSnapshotFutureSkewMilliseconds = minutesToMilliseconds(5);
const realtimeRetentionSchema = positiveSafeIntegerSchema(
    "Monitoring realtime retention must be a positive integer"
);
const clockMillisecondsSchema = timestampMillisecondsSchema(
    "Monitoring clock must return valid Date milliseconds"
);
const realtimeExpiryMillisecondsSchema = timestampMillisecondsSchema(
    "Monitoring realtime expiry must be valid Date milliseconds"
);

export type MonitoringSubmissionStatus = "accepted" | "duplicate" | "stale";

export interface MonitoringSubmissionResult {
    createdIncidents: number;
    duplicateRunId: boolean;
    observedIncidents: number;
    reopenedIncidents: number;
    reportId: string | null;
    resolvedIncidents: number;
    realtimeEvents: number;
    runId: string;
    status: MonitoringSubmissionStatus;
}

export interface MonitoringServiceDependencies {
    generateId?: () => string;
    nowMs?: () => number;
    realtimeRetentionMs?: number;
    repository: MonitoringSubmissionRepository;
    wakeEventPump?: () => Promise<void> | void;
}

/** Minimal persistence port owned by complete-snapshot ingestion. */
export type MonitoringSubmissionRepository = Pick<
    MonitoringRepository,
    "withImmediateTransaction"
>;

export type MonitoringSubmissionError =
    | DatabaseRuntimeWriteUnavailableError
    | MonitoringRunConflictError
    | MonitoringSnapshotValidationError;

interface MonitoringServiceShape {
    readonly submitCompleteSnapshot: (
        input: unknown
    ) => Effect.Effect<MonitoringSubmissionResult, MonitoringSubmissionError>;
}

export class MonitoringService extends Context.Service<
    MonitoringService,
    MonitoringServiceShape
>()("mira-dashboard/server/domains/monitoring/MonitoringService") {}

/** A run id was retried with content that differs from its immutable first submission. */
export class MonitoringRunConflictError extends TaggedErrorClass<MonitoringRunConflictError>(
    "mira-dashboard/server/domains/monitoring/MonitoringRunConflictError"
)("MonitoringRunConflictError", {
    message: Schema.String,
    runId: Schema.String,
}) {}

class MonitoringUnexpectedSubmissionError extends Data.TaggedError(
    "MonitoringUnexpectedSubmissionError"
)<{
    readonly cause: unknown;
}> {}

function isMonitoringSubmissionError(error: unknown): error is MonitoringSubmissionError {
    return (
        error instanceof MonitoringSnapshotValidationError ||
        error instanceof MonitoringRunConflictError ||
        isDatabaseRuntimeWriteUnavailableError(error)
    );
}

function emptyCounts(): MutableSubmissionCounts {
    return {
        createdIncidents: 0,
        observedIncidents: 0,
        reopenedIncidents: 0,
        resolvedIncidents: 0,
        realtimeEvents: 0,
    };
}

function isNewerThanLatestRun(
    completedAtMs: number,
    runId: string,
    latestCompletedAt: Date,
    latestRunId: string
): boolean {
    const completedAtOrder = compareAsc(completedAtMs, latestCompletedAt);
    return completedAtOrder > 0 || (completedAtOrder === 0 && runId > latestRunId);
}

function reportStatusForProblems(
    problems: readonly NormalizedMonitoringProblem[]
): "error" | "ok" | "warning" {
    if (
        problems.some(
            (problem) => problem.severity === "critical" || problem.severity === "error"
        )
    ) {
        return "error";
    }
    return problems.some((problem) => problem.severity === "warning") ? "warning" : "ok";
}

/**
 * Creates the business service for complete monitor snapshots.
 * All lifecycle, report, notification, observation, and outbox writes share one immediate
 * SQLite transaction supplied by the repository.
 * @param dependencies Repository and replaceable clock, identity, and wakeup boundaries.
 * @returns Monitoring lifecycle service.
 */
export function createMonitoringService(
    dependencies: MonitoringServiceDependencies
): MonitoringService["Service"] {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const realtimeRetentionMs = parseSchemaWithRangeError(
        realtimeRetentionSchema,
        dependencies.realtimeRetentionMs ?? defaultRealtimeRetentionMilliseconds
    );
    const wakeAfterCommit = async (changed: boolean): Promise<void> => {
        if (!changed || dependencies.wakeEventPump === undefined) return;
        try {
            await dependencies.wakeEventPump();
        } catch {
            // SQLite is authoritative; adaptive polling recovers a missed wakeup.
        }
    };

    const commitCompleteSnapshot = async (
        input: unknown
    ): Promise<MonitoringSubmissionResult> => {
        const normalized = normalizeMonitoringSnapshot(input);
        const receivedAtMs = parseSchemaWithRangeError(clockMillisecondsSchema, nowMs());
        if (
            differenceInMilliseconds(normalized.snapshot.completedAtMs, receivedAtMs) >
            maximumSnapshotFutureSkewMilliseconds
        ) {
            throw new MonitoringSnapshotValidationError({
                message: `completedAtMs cannot be more than ${maximumSnapshotFutureSkewMilliseconds} milliseconds in the future`,
            });
        }
        const snapshotOccurredAt = toDate(normalized.snapshot.completedAtMs);
        const outboxOccurredAt = toDate(receivedAtMs);
        const expiresAt = addMilliseconds(outboxOccurredAt, realtimeRetentionMs);
        parseSchemaWithRangeError(realtimeExpiryMillisecondsSchema, getTime(expiresAt));
        const committed = await dependencies.repository.withImmediateTransaction(
            (unit) => {
                const existingRun = unit.findRun(normalized.snapshot.runId);
                if (existingRun !== undefined) {
                    if (existingRun.submissionSha256 !== normalized.submissionSha256) {
                        throw new MonitoringRunConflictError({
                            message: `Monitoring run ${normalized.snapshot.runId} was already submitted with different content`,
                            runId: normalized.snapshot.runId,
                        });
                    }
                    return {
                        ...emptyCounts(),
                        duplicateRunId: true,
                        reportId: existingRun.reportId,
                        runId: existingRun.id,
                        status: "duplicate" as const,
                    };
                }

                const counts = emptyCounts();
                const latestRun = unit.findLatestCompleteRun(
                    normalized.snapshot.monitorKey
                );
                const reportId = generateId();
                // The resource-scoped maintenance job owns bounded expiry deletion;
                // request transactions only stamp the durable retention boundary.

                unit.insertReport({
                    bodyMarkdown: normalized.snapshot.report.bodyMarkdown,
                    id: reportId,
                    kind: normalized.snapshot.report.kind,
                    metadataJson: serializeMonitoringJsonObject(
                        normalized.snapshot.report.metadata
                    ),
                    occurredAt: snapshotOccurredAt,
                    source: normalized.snapshot.report.source,
                    sourceJobId: normalized.snapshot.report.sourceJobId,
                    status: reportStatusForProblems(normalized.snapshot.problems),
                    summary: normalized.snapshot.report.summary ?? null,
                    title: normalized.snapshot.report.title,
                });
                unit.insertMonitorRun({
                    completedAt: snapshotOccurredAt,
                    completeSnapshot: true,
                    id: normalized.snapshot.runId,
                    monitorKey: normalized.snapshot.monitorKey,
                    reportId,
                    startedAt: toDate(normalized.snapshot.startedAtMs),
                    state: "succeeded",
                    submissionSha256: normalized.submissionSha256,
                });
                insertRealtimeEvent(unit, counts, {
                    entityId: reportId,
                    entityType: "report",
                    expiresAt,
                    occurredAt: outboxOccurredAt,
                    operation: "created",
                    topic: monitoringRealtimeTopics.reports,
                });

                if (
                    latestRun?.completedAt !== undefined &&
                    latestRun.completedAt !== null &&
                    !isNewerThanLatestRun(
                        normalized.snapshot.completedAtMs,
                        normalized.snapshot.runId,
                        latestRun.completedAt,
                        latestRun.id
                    )
                ) {
                    return {
                        ...counts,
                        duplicateRunId: false,
                        reportId,
                        runId: normalized.snapshot.runId,
                        status: "stale" as const,
                    };
                }

                applyMonitoringSnapshotLifecycle({
                    counts,
                    expiresAt,
                    generateId,
                    outboxOccurredAt,
                    snapshot: normalized.snapshot,
                    snapshotOccurredAt,
                    unit,
                });

                return {
                    ...counts,
                    duplicateRunId: false,
                    reportId,
                    runId: normalized.snapshot.runId,
                    status: "accepted" as const,
                };
            }
        );

        return committed;
    };

    const submitCompleteSnapshot = Effect.fn("MonitoringService.submitCompleteSnapshot")(
        function* (
            input: unknown
        ): Effect.fn.Return<MonitoringSubmissionResult, MonitoringSubmissionError> {
            const committed = yield* Effect.tryPromise({
                catch: (error) =>
                    isMonitoringSubmissionError(error)
                        ? error
                        : new MonitoringUnexpectedSubmissionError({ cause: error }),
                try: () => commitCompleteSnapshot(input),
            }).pipe(
                Effect.catchTag("MonitoringUnexpectedSubmissionError", (error) =>
                    Effect.die(error.cause)
                )
            );

            yield* Effect.promise(() => wakeAfterCommit(committed.realtimeEvents > 0));
            return committed;
        }
    );

    return MonitoringService.of({ submitCompleteSnapshot });
}

/**
 * Provides the monitoring application service from its asynchronous write boundary.
 * @param dependencies Repository plus replaceable clock, identity, and wakeup boundaries.
 * @returns A layer containing one monitoring application service.
 */
export function monitoringServiceLayer(
    dependencies: MonitoringServiceDependencies
): Layer.Layer<MonitoringService> {
    return Layer.succeed(MonitoringService, createMonitoringService(dependencies));
}
