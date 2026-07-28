import {
    assertContractKeys,
    contractArray,
    contractEnum,
    contractFiniteNumber,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractBoolean,
    optionalContractString,
    requiresContractBoolean,
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
    disableIntent?: JobDisableIntent | null;
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
const JOB_EXECUTION_STATUSES = [
    "queued",
    "running",
    "success",
    "failed",
    "cancelled",
] as const;
const JOB_EXECUTION_TRIGGER_TYPES = ["manual", "schedule", "startup", "system"] as const;
const JOB_RESOURCE_CLASSES = [
    "interactive",
    "light",
    "network",
    "host-heavy",
    "exclusive",
] as const;

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
        patchInput.disableIntent === undefined || patchInput.disableIntent === null
            ? patchInput.disableIntent
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

function responseString(
    input: Record<string, unknown>,
    key: string,
    path: string
): string {
    return contractString(input[key], `${path}.${key}`, {
        allowEmpty: true,
        trim: false,
    });
}

function optionalResponseString(
    input: Record<string, unknown>,
    key: string,
    path: string
): string | undefined {
    return optionalContractString(input[key], `${path}.${key}`, {
        allowEmpty: true,
        trim: false,
    });
}

function responseNumber(
    input: Record<string, unknown>,
    key: string,
    path: string
): number {
    return contractFiniteNumber(input[key], `${path}.${key}`);
}

function optionalResponseNumber(
    input: Record<string, unknown>,
    key: string,
    path: string
): number | undefined {
    return input[key] === undefined ? undefined : responseNumber(input, key, path);
}

function parseJobDisableIntentResponse(value: unknown, path: string): JobDisableIntent {
    const input = contractRecord(value, path);
    assertContractKeys(input, ["comment", "mode", "until"], path);
    const mode = contractEnum(
        input.mode,
        ["indefinite", "until"] as const,
        `${path}.mode`
    );
    const comment = responseString(input, "comment", path);
    if (mode === "indefinite") {
        if (input.until !== undefined) {
            return invalidContract(`${path}.until`, "is not allowed for indefinite mode");
        }
        return { comment, mode };
    }
    return {
        comment,
        mode,
        // Preserve malformed persisted timestamps for the UI's bounded fallback.
        until: responseString(input, "until", path),
    };
}

/** Parses one public queue execution returned by the backend. */
export function parseJobExecution(
    value: unknown,
    path = "response.execution"
): JobExecution {
    const input = contractRecord(value, path);
    const cancelRequestedAt = optionalResponseString(input, "cancelRequestedAt", path);
    const finishedAt = optionalResponseString(input, "finishedAt", path);
    const heartbeatAt = optionalResponseString(input, "heartbeatAt", path);
    const message = optionalResponseString(input, "message", path);
    const scheduledJobId = optionalResponseString(input, "scheduledJobId", path);
    const scheduledRunId = optionalResponseNumber(input, "scheduledRunId", path);
    const startedAt = optionalResponseString(input, "startedAt", path);
    const output =
        input.output === undefined
            ? undefined
            : contractRecord(input.output, `${path}.output`);
    return {
        actionKey: responseString(input, "actionKey", path),
        attempt: responseNumber(input, "attempt", path),
        availableAt: responseString(input, "availableAt", path),
        cancellable: requiresContractBoolean(input.cancellable, `${path}.cancellable`),
        displayName: responseString(input, "displayName", path),
        id: responseString(input, "id", path),
        queuedAt: responseString(input, "queuedAt", path),
        resourceClass: contractEnum(
            input.resourceClass,
            JOB_RESOURCE_CLASSES,
            `${path}.resourceClass`
        ),
        status: contractEnum(input.status, JOB_EXECUTION_STATUSES, `${path}.status`),
        triggerType: contractEnum(
            input.triggerType,
            JOB_EXECUTION_TRIGGER_TYPES,
            `${path}.triggerType`
        ),
        ...(cancelRequestedAt !== undefined && { cancelRequestedAt }),
        ...(finishedAt !== undefined && { finishedAt }),
        ...(heartbeatAt !== undefined && { heartbeatAt }),
        ...(message !== undefined && { message }),
        ...(output !== undefined && { output }),
        ...(scheduledJobId !== undefined && { scheduledJobId }),
        ...(scheduledRunId !== undefined && { scheduledRunId }),
        ...(startedAt !== undefined && { startedAt }),
    };
}

/** Parses the low-cardinality queue summary shared by jobs and metrics. */
export function parseJobExecutionSummary(
    value: unknown,
    path = "response.summary"
): JobExecutionSummary {
    const input = contractRecord(value, path);
    const activeResourceClasses = contractArray(
        input.activeResourceClasses,
        `${path}.activeResourceClasses`
    ).map((entry, index) =>
        contractEnum(
            entry,
            JOB_RESOURCE_CLASSES,
            `${path}.activeResourceClasses[${index}]`
        )
    );
    const oldestQueuedAgeMs = optionalResponseNumber(input, "oldestQueuedAgeMs", path);
    const oldestQueuedAt = optionalResponseString(input, "oldestQueuedAt", path);
    const workerLastHeartbeatAt = optionalResponseString(
        input,
        "workerLastHeartbeatAt",
        path
    );
    return {
        activeResourceClasses,
        queued: responseNumber(input, "queued", path),
        running: responseNumber(input, "running", path),
        workerCapacity: responseNumber(input, "workerCapacity", path),
        workerCount: responseNumber(input, "workerCount", path),
        workerOnline: requiresContractBoolean(input.workerOnline, `${path}.workerOnline`),
        ...(oldestQueuedAgeMs !== undefined && { oldestQueuedAgeMs }),
        ...(oldestQueuedAt !== undefined && { oldestQueuedAt }),
        ...(workerLastHeartbeatAt !== undefined && { workerLastHeartbeatAt }),
    };
}

export function parseJobExecutionsResponse(value: unknown): JobExecutionsResponse {
    const input = contractRecord(value, "response");
    return {
        executions: contractArray(input.executions, "response.executions").map(
            (execution, index) =>
                parseJobExecution(execution, `response.executions[${index}]`)
        ),
        summary: parseJobExecutionSummary(input.summary),
    };
}

export function parseJobExecutionResponse(value: unknown): JobExecutionResponse {
    const input = contractRecord(value, "response");
    return { execution: parseJobExecution(input.execution) };
}

export function parseJobExecutionCancelResponse(
    value: unknown
): JobExecutionCancelResponse {
    const input = contractRecord(value, "response");
    return {
        execution: parseJobExecution(input.execution),
        isOk:
            input.isOk === true ? true : invalidContract("response.isOk", "must be true"),
    };
}

/** Parses one scheduled run, including its bounded public output object. */
export function parseScheduledJobRun(
    value: unknown,
    path = "response.run"
): ScheduledJobRun {
    const input = contractRecord(value, path);
    const cancelRequestedAt = optionalResponseString(input, "cancelRequestedAt", path);
    const executionId = optionalResponseString(input, "executionId", path);
    const finishedAt = optionalResponseString(input, "finishedAt", path);
    const message = optionalResponseString(input, "message", path);
    return {
        cancellable: requiresContractBoolean(input.cancellable, `${path}.cancellable`),
        id: responseNumber(input, "id", path),
        jobId: responseString(input, "jobId", path),
        output: contractRecord(input.output, `${path}.output`),
        queuedAt: responseString(input, "queuedAt", path),
        resourceClass: contractEnum(
            input.resourceClass,
            JOB_RESOURCE_CLASSES,
            `${path}.resourceClass`
        ),
        startedAt: responseString(input, "startedAt", path),
        status: contractEnum(input.status, JOB_EXECUTION_STATUSES, `${path}.status`),
        triggerType: contractEnum(
            input.triggerType,
            JOB_EXECUTION_TRIGGER_TYPES,
            `${path}.triggerType`
        ),
        ...(cancelRequestedAt !== undefined && { cancelRequestedAt }),
        ...(executionId !== undefined && { executionId }),
        ...(finishedAt !== undefined && { finishedAt }),
        ...(message !== undefined && { message }),
    };
}

/** Parses one scheduled job returned by list, detail, or mutation routes. */
export function parseScheduledJob(value: unknown, path = "response.job"): ScheduledJob {
    const input = contractRecord(value, path);
    const cronExpression = optionalResponseString(input, "cronExpression", path);
    const disableIntent =
        input.disableIntent === undefined
            ? undefined
            : parseJobDisableIntentResponse(input.disableIntent, `${path}.disableIntent`);
    const lastRun =
        input.lastRun === undefined
            ? undefined
            : parseScheduledJobRun(input.lastRun, `${path}.lastRun`);
    const nextRunAt = optionalResponseString(input, "nextRunAt", path);
    const timeOfDay = optionalResponseString(input, "timeOfDay", path);
    return {
        actionKey: responseString(input, "actionKey", path),
        actionPayload: contractRecord(input.actionPayload, `${path}.actionPayload`),
        createdAt: responseString(input, "createdAt", path),
        description: responseString(input, "description", path),
        enabled: requiresContractBoolean(input.enabled, `${path}.enabled`),
        id: responseString(input, "id", path),
        intervalSeconds: responseNumber(input, "intervalSeconds", path),
        isQueued: requiresContractBoolean(input.isQueued, `${path}.isQueued`),
        isRunning: requiresContractBoolean(input.isRunning, `${path}.isRunning`),
        name: responseString(input, "name", path),
        resourceClass: contractEnum(
            input.resourceClass,
            JOB_RESOURCE_CLASSES,
            `${path}.resourceClass`
        ),
        scheduleType: contractEnum(
            input.scheduleType,
            SCHEDULE_TYPES,
            `${path}.scheduleType`
        ),
        timeoutMs: responseNumber(input, "timeoutMs", path),
        updatedAt: responseString(input, "updatedAt", path),
        ...(cronExpression !== undefined && { cronExpression }),
        ...(disableIntent !== undefined && { disableIntent }),
        ...(lastRun !== undefined && { lastRun }),
        ...(nextRunAt !== undefined && { nextRunAt }),
        ...(timeOfDay !== undefined && { timeOfDay }),
    };
}

export function parseScheduledJobsResponse(value: unknown): ScheduledJobsResponse {
    const input = contractRecord(value, "response");
    return {
        jobs: contractArray(input.jobs, "response.jobs").map((job, index) =>
            parseScheduledJob(job, `response.jobs[${index}]`)
        ),
    };
}

export function parseScheduledJobResponse(value: unknown): ScheduledJobResponse {
    const input = contractRecord(value, "response");
    return { job: parseScheduledJob(input.job) };
}

export function parseScheduledJobMutationResponse(
    value: unknown
): ScheduledJobMutationResponse {
    const input = contractRecord(value, "response");
    return {
        isOk:
            input.isOk === true ? true : invalidContract("response.isOk", "must be true"),
        job: parseScheduledJob(input.job),
    };
}

export function parseScheduledJobRunsResponse(value: unknown): ScheduledJobRunsResponse {
    const input = contractRecord(value, "response");
    return {
        runs: contractArray(input.runs, "response.runs").map((run, index) =>
            parseScheduledJobRun(run, `response.runs[${index}]`)
        ),
    };
}

export function parseScheduledJobRunResponse(value: unknown): ScheduledJobRunResponse {
    const input = contractRecord(value, "response");
    return {
        isOk:
            input.isOk === true ? true : invalidContract("response.isOk", "must be true"),
        run: parseScheduledJobRun(input.run),
    };
}
