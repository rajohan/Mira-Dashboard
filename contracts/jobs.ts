import {
    assertContractKeys,
    contractEnum,
    contractFiniteNumber,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractBoolean,
    optionalContractString,
} from "./runtime";

export type JobDisableIntent =
    | { mode: "indefinite"; comment: string }
    | { mode: "until"; comment: string; until: string };

export type JobResourceClass =
    "interactive" | "light" | "network" | "host-heavy" | "exclusive";

export type JobExecutionStatus =
    "queued" | "running" | "success" | "failed" | "cancelled";

export type JobExecutionTriggerType = "manual" | "schedule" | "startup" | "system";

/** Public queue item returned by the job-execution API. */
export interface JobExecution {
    actionKey: string;
    attempt: number;
    availableAt: string;
    cancelRequestedAt?: string;
    cancellable: boolean;
    displayName: string;
    finishedAt?: string;
    heartbeatAt?: string;
    id: string;
    message?: string;
    output?: Record<string, unknown>;
    queuedAt: string;
    resourceClass: JobResourceClass;
    scheduledJobId?: string;
    scheduledRunId?: number;
    startedAt?: string;
    status: JobExecutionStatus;
    triggerType: JobExecutionTriggerType;
}

export interface JobExecutionSummary {
    activeResourceClasses: JobResourceClass[];
    oldestQueuedAgeMs?: number;
    oldestQueuedAt?: string;
    queued: number;
    running: number;
    workerCapacity: number;
    workerCount: number;
    workerLastHeartbeatAt?: string;
    workerOnline: boolean;
}

export interface JobExecutionsResponse {
    executions: JobExecution[];
    summary: JobExecutionSummary;
}

export interface JobExecutionResponse {
    execution: JobExecution;
}

export interface JobExecutionCancelResponse extends JobExecutionResponse {
    isOk: true;
}

export type ScheduledJobScheduleType = "interval" | "daily" | "cron";
export type ScheduledJobRunStatus =
    "queued" | "running" | "success" | "failed" | "cancelled";
export type ScheduledJobTriggerType = JobExecutionTriggerType;

export interface ScheduledJob {
    actionKey: string;
    actionPayload: Record<string, unknown>;
    createdAt: string;
    cronExpression?: string;
    description: string;
    disableIntent?: JobDisableIntent;
    enabled: boolean;
    id: string;
    intervalSeconds: number;
    isQueued: boolean;
    isRunning: boolean;
    lastRun?: ScheduledJobRun;
    name: string;
    nextRunAt?: string;
    resourceClass: JobResourceClass;
    scheduleType: ScheduledJobScheduleType;
    timeOfDay?: string;
    timeoutMs: number;
    updatedAt: string;
}

export interface ScheduledJobRun {
    cancelRequestedAt?: string;
    cancellable: boolean;
    executionId?: string;
    finishedAt?: string;
    id: number;
    jobId: string;
    message?: string;
    output: Record<string, unknown>;
    queuedAt: string;
    resourceClass: JobResourceClass;
    startedAt: string;
    status: ScheduledJobRunStatus;
    triggerType: ScheduledJobTriggerType;
}

export interface ScheduledJobPatch {
    cronExpression?: string | null;
    disableIntent?: JobDisableIntent;
    enabled?: boolean;
    intervalSeconds?: number;
    scheduleType?: ScheduledJobScheduleType;
    timeOfDay?: string | null;
}

export interface ScheduledJobUpdateRequest {
    patch: ScheduledJobPatch;
}

export interface ScheduledJobsResponse {
    jobs: ScheduledJob[];
}

export interface ScheduledJobResponse {
    job: ScheduledJob;
}

export interface ScheduledJobMutationResponse extends ScheduledJobResponse {
    isOk: true;
}

export interface ScheduledJobRunsResponse {
    runs: ScheduledJobRun[];
}

export interface ScheduledJobRunResponse {
    isOk: true;
    run: ScheduledJobRun;
}

const SCHEDULE_TYPES = ["interval", "daily", "cron"] as const;

export function parseJobDisableIntent(
    value: unknown,
    path = "body.patch.disableIntent"
): JobDisableIntent {
    const input = contractRecord(value, path);
    assertContractKeys(input, ["comment", "mode", "until"], path);
    const mode = contractEnum(
        input.mode,
        ["indefinite", "until"] as const,
        `${path}.mode`
    );
    const comment = contractString(input.comment, `${path}.comment`, {
        maximumLength: 1000,
    });
    if (mode === "indefinite") {
        if (input.until !== undefined) {
            return invalidContract(`${path}.until`, "is not allowed for indefinite mode");
        }
        return { comment, mode };
    }
    const until = contractString(input.until, `${path}.until`);
    if (Number.isNaN(Date.parse(until))) {
        return invalidContract(`${path}.until`, "must be a valid timestamp");
    }
    return { comment, mode, until: new Date(until).toISOString() };
}

export function parseScheduledJobUpdateRequest(
    value: unknown
): ScheduledJobUpdateRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["patch"], "body");
    const patchInput = contractRecord(input.patch, "body.patch");
    assertContractKeys(
        patchInput,
        [
            "cronExpression",
            "disableIntent",
            "enabled",
            "intervalSeconds",
            "scheduleType",
            "timeOfDay",
        ],
        "body.patch"
    );
    const cronExpression =
        patchInput.cronExpression === null
            ? patchInput.cronExpression
            : optionalContractString(
                  patchInput.cronExpression,
                  "body.patch.cronExpression",
                  { allowEmpty: true, trim: false }
              );
    const disableIntent =
        patchInput.disableIntent === undefined
            ? undefined
            : parseJobDisableIntent(patchInput.disableIntent);
    const enabled = optionalContractBoolean(patchInput.enabled, "body.patch.enabled");
    const intervalSeconds =
        patchInput.intervalSeconds === undefined
            ? undefined
            : contractFiniteNumber(
                  patchInput.intervalSeconds,
                  "body.patch.intervalSeconds"
              );
    const scheduleType =
        patchInput.scheduleType === undefined
            ? undefined
            : contractEnum(
                  patchInput.scheduleType,
                  SCHEDULE_TYPES,
                  "body.patch.scheduleType"
              );
    const timeOfDay =
        patchInput.timeOfDay === null
            ? patchInput.timeOfDay
            : optionalContractString(patchInput.timeOfDay, "body.patch.timeOfDay", {
                  allowEmpty: true,
                  trim: false,
              });
    return {
        patch: {
            ...(cronExpression !== undefined && { cronExpression }),
            ...(disableIntent !== undefined && { disableIntent }),
            ...(enabled !== undefined && { enabled }),
            ...(intervalSeconds !== undefined && { intervalSeconds }),
            ...(scheduleType !== undefined && { scheduleType }),
            ...(timeOfDay !== undefined && { timeOfDay }),
        },
    };
}
