import { getTime } from "date-fns";
import * as v from "valibot";

import {
    type ActiveJobDisableIntent,
    type JobRunEvent,
    type JobRunResult,
    type JobRunSummary,
    type JobWorkerControl,
    type JobWorkerSummary,
    type ScheduleConfiguration,
    type ScheduleSummary,
    activeJobDisableIntentSchema,
    jobResourceKeysSchema,
    jobRunEventSchema,
    jobRunResultSchema,
    jobRunSummarySchema,
    jobWorkerControlSchema,
    jobWorkerSummarySchema,
    scheduleConfigurationSchema,
    scheduleSummarySchema,
} from "../../../contracts/jobModel.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { jobDisableIntentSelectSchema } from "../../database/validation/jobDisableIntents.ts";
import { jobRunEventSelectSchema } from "../../database/validation/jobRunEvents.ts";
import { jobRunSelectSchema } from "../../database/validation/jobRuns.ts";
import { jobWorkerControlSelectSchema } from "../../database/validation/jobWorkerControl.ts";
import { scheduledJobSelectSchema } from "../../database/validation/scheduledJobs.ts";
import { workerInstanceSelectSchema } from "../../database/validation/workerInstances.ts";
import { findJobActionDefinition, isRegisteredJobSchedule } from "./actionRegistry.ts";

export type JobDisableIntentRecord = v.InferOutput<typeof jobDisableIntentSelectSchema>;
export type JobRunEventRecord = v.InferOutput<typeof jobRunEventSelectSchema>;
export type JobRunRecord = v.InferOutput<typeof jobRunSelectSchema>;
export type JobWorkerControlRecord = v.InferOutput<typeof jobWorkerControlSelectSchema>;
export type ScheduledJobRecord = v.InferOutput<typeof scheduledJobSelectSchema>;
export type WorkerInstanceRecord = v.InferOutput<typeof workerInstanceSelectSchema>;

/**
 * Converts one validated persistence run into its redacted public projection.
 * @returns Contract-validated public run summary.
 */
export function toJobRunSummary(record: JobRunRecord): JobRunSummary {
    return v.parse(jobRunSummarySchema, {
        actionKey: record.actionKey,
        attemptCount: record.attemptCount,
        attemptLimit: record.attemptLimit,
        availableAtMs: getTime(record.availableAt),
        cancellationPolicy: record.cancellationPolicy,
        ...(record.cancelRequestedAt === null
            ? {}
            : { cancelRequestedAtMs: getTime(record.cancelRequestedAt) }),
        displayName: record.displayName,
        eventCount: record.eventCount,
        ...(record.finishedAt === null
            ? {}
            : { finishedAtMs: getTime(record.finishedAt) }),
        ...(record.firstStartedAt === null
            ? {}
            : { firstStartedAtMs: getTime(record.firstStartedAt) }),
        id: record.id,
        ...(record.lastAttemptStartedAt === null
            ? {}
            : { lastAttemptStartedAtMs: getTime(record.lastAttemptStartedAt) }),
        priority: record.priority,
        queuedAtMs: getTime(record.queuedAt),
        resourceClass: record.resourceClass,
        resourceKeys: v.parse(
            jobResourceKeysSchema,
            parseJsonText(record.resourceKeysJson)
        ),
        retrySafe: record.retrySafe,
        ...(record.scheduledForAt === null
            ? {}
            : { scheduledForAtMs: getTime(record.scheduledForAt) }),
        ...(record.scheduledJobId === null
            ? {}
            : { scheduledJobId: record.scheduledJobId }),
        ...(record.scheduledJobVersion === null
            ? {}
            : { scheduledJobVersion: record.scheduledJobVersion }),
        state: record.state,
        stateVersion: record.stateVersion,
        ...(record.terminalCode === null ? {} : { terminalCode: record.terminalCode }),
        ...(record.terminalMessage === null
            ? {}
            : { terminalMessage: record.terminalMessage }),
        timeoutMs: record.timeoutMs,
        triggerType: record.triggerType,
        updatedAtMs: getTime(record.updatedAt),
    });
}

/**
 * Parses the bounded terminal result of a successful run.
 * @returns The structured result when the run succeeded.
 */
export function toJobRunResult(record: JobRunRecord): JobRunResult | undefined {
    return record.resultJson === null
        ? undefined
        : v.parse(jobRunResultSchema, parseJsonText(record.resultJson));
}

/**
 * Converts one immutable event row into its bounded public projection.
 * @returns Contract-validated public event.
 */
export function toJobRunEvent(record: JobRunEventRecord): JobRunEvent {
    return v.parse(jobRunEventSchema, {
        attempt: record.attempt,
        kind: record.kind,
        ...(record.message === null ? {} : { message: record.message }),
        occurredAtMs: getTime(record.occurredAt),
        ...(record.progressJson === null
            ? {}
            : { progress: parseJsonText(record.progressJson) }),
        sequence: record.sequence,
        ...(record.workerInstanceId === null
            ? {}
            : { workerInstanceId: record.workerInstanceId }),
    });
}

/**
 * Restores the complete mutually exclusive schedule variant from one row.
 * @returns Contract-validated schedule configuration.
 */
export function toScheduleConfiguration(
    record: ScheduledJobRecord
): ScheduleConfiguration {
    if (record.scheduleKind === "interval") {
        return v.parse(scheduleConfigurationSchema, {
            intervalMs: record.intervalMs,
            kind: "interval",
        });
    }
    if (record.scheduleKind === "daily") {
        return v.parse(scheduleConfigurationSchema, {
            kind: "daily",
            timeOfDay: record.timeOfDay,
            timeZone: record.timeZone,
        });
    }
    return v.parse(scheduleConfigurationSchema, {
        expression: record.cronExpression,
        kind: "cron",
        timeZone: record.timeZone,
    });
}

/**
 * Converts one still-open operator disable intent to its public shape.
 * @returns Contract-validated active disable intent.
 */
export function toActiveDisableIntent(
    record: JobDisableIntentRecord
): ActiveJobDisableIntent {
    if (record.endedAt !== null || record.scheduledJobId === null) {
        throw new Error("Expected an active Dashboard schedule disable intent");
    }
    return v.parse(activeJobDisableIntentSchema, {
        createdAtMs: getTime(record.createdAt),
        ...(record.expiresAt === null ? {} : { expiresAtMs: getTime(record.expiresAt) }),
        id: record.id,
        reason: record.reason,
    });
}

export interface ScheduleSummaryRelations {
    readonly activeDisableIntent?: JobDisableIntentRecord;
    readonly activeRun?: JobRunRecord;
    readonly latestRun?: JobRunRecord;
}

/**
 * Builds one contract-validated schedule projection with related run state.
 * @returns Contract-validated public schedule summary.
 */
export function toScheduleSummary(
    record: ScheduledJobRecord,
    relations: ScheduleSummaryRelations = {}
): ScheduleSummary {
    return v.parse(scheduleSummarySchema, {
        actionKey: record.actionKey,
        ...(relations.activeDisableIntent === undefined
            ? {}
            : {
                  activeDisableIntent: toActiveDisableIntent(
                      relations.activeDisableIntent
                  ),
              }),
        ...(relations.activeRun === undefined
            ? {}
            : { activeRun: toJobRunSummary(relations.activeRun) }),
        attemptLimit: record.attemptLimit,
        cancellationPolicy: record.cancellationPolicy,
        createdAtMs: getTime(record.createdAt),
        description: record.description,
        enabled: record.enabled,
        id: record.id,
        ...(relations.latestRun === undefined
            ? {}
            : { latestRun: toJobRunSummary(relations.latestRun) }),
        manualRunAvailable:
            isRegisteredJobSchedule(record.id, record.actionKey) &&
            findJobActionDefinition(record.actionKey)?.manualExposure === "jobs-write",
        name: record.name,
        ...(record.enabled && record.nextRunAt !== null
            ? { nextRunAtMs: getTime(record.nextRunAt) }
            : {}),
        priority: record.priority,
        resourceClass: record.resourceClass,
        resourceKeys: v.parse(
            jobResourceKeysSchema,
            parseJsonText(record.resourceKeysJson)
        ),
        retrySafe: record.retrySafe,
        schedule: toScheduleConfiguration(record),
        timeoutMs: record.timeoutMs,
        updatedAtMs: getTime(record.updatedAt),
        version: record.version,
    });
}

/**
 * Converts the required singleton row to the public worker-control state.
 * @returns Contract-validated public worker control.
 */
export function toJobWorkerControl(record: JobWorkerControlRecord): JobWorkerControl {
    return v.parse(jobWorkerControlSchema, {
        claimingPaused: record.claimingPaused,
        updatedAtMs: getTime(record.updatedAt),
        version: record.version,
    });
}

/**
 * Builds one bounded worker summary with a separately counted active workload.
 * @returns Contract-validated public worker summary.
 */
export function toJobWorkerSummary(
    record: WorkerInstanceRecord,
    activeRunCount: number
): JobWorkerSummary {
    return v.parse(jobWorkerSummarySchema, {
        activeRunCount,
        capacity: record.capacity,
        ...(record.drainingAt === null
            ? {}
            : { drainingAtMs: getTime(record.drainingAt) }),
        heartbeatAtMs: getTime(record.heartbeatAt),
        id: record.id,
        releaseId: record.releaseId,
        startedAtMs: getTime(record.startedAt),
        state: record.state,
        ...(record.stoppedAt === null ? {} : { stoppedAtMs: getTime(record.stoppedAt) }),
    });
}
