import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    canonicalNonnegativeSafeIntegerStringSchema,
    hasUniqueArrayItems,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { gatewaySessionKeySchema } from "./gatewaySessions.ts";
import type { ProcedureContract } from "./registry.ts";

export const openClawTaskPageDefault = 100;
export const openClawTaskPageMaximum = 200;
export const openClawTaskResponseMaximumBytes = 512 * 1024;
export const openClawTaskPromptMaximumCharacters = 4000;

export const openClawTaskStatuses = [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
] as const;

export const openClawTaskStatusSchema = v.picklist(
    openClawTaskStatuses,
    "OpenClaw task status is invalid"
);
export const openClawTaskIdSchema = boundedControlSafeTextSchema(
    256,
    "OpenClaw task id is invalid"
);

const optionalTaskIdentitySchema = v.optional(
    boundedControlSafeTextSchema(256, "OpenClaw task identity is invalid")
);
const optionalTaskLabelSchema = v.optional(
    boundedControlSafeTextSchema(256, "OpenClaw task label is invalid")
);
const optionalTaskSummarySchema = v.optional(
    boundedNonBlankTextSchema(4000, "OpenClaw task summary is invalid")
);

const openClawTaskSummaryEntries = {
    agentId: optionalTaskIdentitySchema,
    childSessionKey: v.optional(gatewaySessionKeySchema),
    createdAtMs: v.optional(
        timestampMillisecondsSchema("OpenClaw task creation timestamp is invalid")
    ),
    endedAtMs: v.optional(
        timestampMillisecondsSchema("OpenClaw task end timestamp is invalid")
    ),
    error: optionalTaskSummarySchema,
    flowId: optionalTaskIdentitySchema,
    id: openClawTaskIdSchema,
    kind: optionalTaskLabelSchema,
    lastToolName: v.optional(
        boundedControlSafeTextSchema(200, "OpenClaw task tool name is invalid")
    ),
    ownerKey: optionalTaskIdentitySchema,
    parentTaskId: optionalTaskIdentitySchema,
    progressSummary: optionalTaskSummarySchema,
    runId: optionalTaskIdentitySchema,
    runtime: optionalTaskLabelSchema,
    sessionKey: v.optional(gatewaySessionKeySchema),
    sourceId: optionalTaskIdentitySchema,
    startedAtMs: v.optional(
        timestampMillisecondsSchema("OpenClaw task start timestamp is invalid")
    ),
    status: openClawTaskStatusSchema,
    taskId: optionalTaskIdentitySchema,
    terminalSummary: optionalTaskSummarySchema,
    title: optionalTaskLabelSchema,
    toolUseCount: v.optional(
        v.pipe(
            v.number("OpenClaw task tool count is invalid"),
            v.safeInteger("OpenClaw task tool count is invalid"),
            v.minValue(0, "OpenClaw task tool count is invalid")
        )
    ),
    updatedAtMs: v.optional(
        timestampMillisecondsSchema("OpenClaw task update timestamp is invalid")
    ),
};

const openClawTaskSummaryObjectSchema = v.strictObject(openClawTaskSummaryEntries);

type OpenClawTaskLifecycleFields = Pick<
    v.InferOutput<typeof openClawTaskSummaryObjectSchema>,
    "createdAtMs" | "endedAtMs" | "id" | "startedAtMs" | "taskId" | "updatedAtMs"
>;

function taskLifecycleIsConsistent(task: OpenClawTaskLifecycleFields): boolean {
    return (
        (task.taskId === undefined || task.taskId === task.id) &&
        (task.createdAtMs === undefined ||
            task.startedAtMs === undefined ||
            task.createdAtMs <= task.startedAtMs) &&
        (task.createdAtMs === undefined ||
            task.endedAtMs === undefined ||
            task.createdAtMs <= task.endedAtMs) &&
        (task.startedAtMs === undefined ||
            task.endedAtMs === undefined ||
            task.startedAtMs <= task.endedAtMs) &&
        (task.createdAtMs === undefined ||
            task.updatedAtMs === undefined ||
            task.createdAtMs <= task.updatedAtMs) &&
        (task.startedAtMs === undefined ||
            task.updatedAtMs === undefined ||
            task.startedAtMs <= task.updatedAtMs) &&
        (task.endedAtMs === undefined ||
            task.updatedAtMs === undefined ||
            task.endedAtMs <= task.updatedAtMs)
    );
}

export function openClawTaskSummaryLifecycleIsConsistent(
    task: v.InferOutput<typeof openClawTaskSummaryObjectSchema>
): boolean {
    return taskLifecycleIsConsistent(task);
}

export const openClawTaskSummarySchema = v.pipe(
    openClawTaskSummaryObjectSchema,
    v.check(
        openClawTaskSummaryLifecycleIsConsistent,
        "OpenClaw task lifecycle is inconsistent"
    )
);
const openClawTaskDetailObjectSchema = v.strictObject({
    ...openClawTaskSummaryEntries,
    prompt: v.optional(
        boundedNonBlankTextSchema(
            openClawTaskPromptMaximumCharacters,
            "OpenClaw task prompt is invalid"
        )
    ),
});

export function openClawTaskDetailLifecycleIsConsistent(
    task: v.InferOutput<typeof openClawTaskDetailObjectSchema>
): boolean {
    return taskLifecycleIsConsistent(task);
}

export const openClawTaskDetailSchema = v.pipe(
    openClawTaskDetailObjectSchema,
    v.check(
        openClawTaskDetailLifecycleIsConsistent,
        "OpenClaw task lifecycle is inconsistent"
    )
);

const taskStatusFilterSchema = v.pipe(
    v.array(openClawTaskStatusSchema, "OpenClaw task statuses are invalid"),
    v.minLength(1, "OpenClaw task statuses must not be empty"),
    v.maxLength(openClawTaskStatuses.length),
    v.check(hasUniqueArrayItems, "OpenClaw task statuses must be unique")
);
const taskLimitSchema = v.pipe(
    positiveSafeIntegerSchema("OpenClaw task limit is invalid"),
    v.maxValue(openClawTaskPageMaximum, "OpenClaw task limit is outside its budget")
);

export const openClawTaskListInputSchema = v.strictObject({
    agentId: v.optional(
        boundedControlSafeTextSchema(256, "OpenClaw task agent id is invalid")
    ),
    cursor: v.optional(
        canonicalNonnegativeSafeIntegerStringSchema("OpenClaw task cursor is invalid")
    ),
    limit: v.optional(taskLimitSchema, openClawTaskPageDefault),
    sessionKey: v.optional(gatewaySessionKeySchema),
    statuses: v.optional(taskStatusFilterSchema),
});

const openClawTaskListArraySchema = v.pipe(
    v.array(openClawTaskSummarySchema, "OpenClaw tasks are invalid"),
    v.maxLength(openClawTaskPageMaximum, "OpenClaw task page is outside its budget")
);

export function openClawTasksHaveUniqueIds(
    tasks: v.InferOutput<typeof openClawTaskListArraySchema>
): boolean {
    return hasUniqueArrayItems(tasks.map(({ id }) => id));
}

const openClawTaskListOutputObjectSchema = v.strictObject({
    nextCursor: v.optional(
        canonicalNonnegativeSafeIntegerStringSchema("OpenClaw task cursor is invalid")
    ),
    tasks: v.pipe(
        openClawTaskListArraySchema,
        v.check(openClawTasksHaveUniqueIds, "OpenClaw task ids must be unique")
    ),
});

export function openClawTaskListOutputFitsBudget(
    output: v.InferOutput<typeof openClawTaskListOutputObjectSchema>
): boolean {
    return utf8ByteLength(JSON.stringify(output)) <= openClawTaskResponseMaximumBytes;
}

export const openClawTaskListOutputSchema = v.pipe(
    openClawTaskListOutputObjectSchema,
    v.check(
        openClawTaskListOutputFitsBudget,
        "OpenClaw task page exceeds its response budget"
    )
);

export const openClawTaskGetInputSchema = v.strictObject({
    taskId: openClawTaskIdSchema,
});
export const openClawTaskGetOutputSchema = v.strictObject({
    task: openClawTaskDetailSchema,
});

export const openClawTaskCancelInputSchema = v.strictObject({
    reason: v.optional(
        boundedNonBlankTextSchema(500, "OpenClaw task cancellation reason is invalid")
    ),
    taskId: openClawTaskIdSchema,
});
const openClawTaskCancelOutputObjectSchema = v.strictObject({
    cancelled: v.boolean("OpenClaw task cancellation result is invalid"),
    found: v.boolean("OpenClaw task lookup result is invalid"),
    reason: v.optional(
        boundedNonBlankTextSchema(500, "OpenClaw task cancellation reason is invalid")
    ),
    task: v.optional(openClawTaskSummarySchema),
});

export function openClawTaskCancelledResultWasFound(
    output: v.InferOutput<typeof openClawTaskCancelOutputObjectSchema>
): boolean {
    return output.cancelled === false || output.found;
}

export function openClawTaskCancelSnapshotMatchesFound(
    output: v.InferOutput<typeof openClawTaskCancelOutputObjectSchema>
): boolean {
    return output.found === (output.task !== undefined);
}

export const openClawTaskCancelOutputSchema = v.pipe(
    openClawTaskCancelOutputObjectSchema,
    v.check(
        openClawTaskCancelledResultWasFound,
        "A cancelled OpenClaw task must have been found"
    ),
    v.check(
        openClawTaskCancelSnapshotMatchesFound,
        "OpenClaw task cancellation lookup and task snapshot disagree"
    )
);

export type OpenClawTaskSummary = v.InferOutput<typeof openClawTaskSummarySchema>;
export type OpenClawTaskDetail = v.InferOutput<typeof openClawTaskDetailSchema>;
export type OpenClawTaskListInput = v.InferOutput<typeof openClawTaskListInputSchema>;
export type OpenClawTaskListOutput = v.InferOutput<typeof openClawTaskListOutputSchema>;
export type OpenClawTaskGetInput = v.InferOutput<typeof openClawTaskGetInputSchema>;
export type OpenClawTaskGetOutput = v.InferOutput<typeof openClawTaskGetOutputSchema>;
export type OpenClawTaskCancelInput = v.InferOutput<typeof openClawTaskCancelInputSchema>;
export type OpenClawTaskCancelOutput = v.InferOutput<
    typeof openClawTaskCancelOutputSchema
>;

const taskReadAccess = {
    capabilities: ["openclaw-tasks:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const taskWriteAccess = {
    capabilities: ["openclaw-tasks:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;
const taskQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const taskMutationTransport = {
    batching: "forbidden",
    handler: "long-lived",
    requestBody: "default",
} as const;

export const openClawTaskProcedureContracts = [
    {
        access: taskReadAccess,
        domain: "openClawTasks",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: openClawTaskListInputSchema,
        inputSchemaId: "openClawTasks.list.input",
        kind: "query",
        name: "openClawTasks.list",
        output: openClawTaskListOutputSchema,
        outputSchemaId: "openClawTasks.list.output",
        summary: "Lists bounded prompt-free OpenClaw background-task summaries.",
        transport: taskQueryTransport,
    },
    {
        access: taskReadAccess,
        domain: "openClawTasks",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: openClawTaskGetInputSchema,
        inputSchemaId: "openClawTasks.get.input",
        kind: "query",
        name: "openClawTasks.get",
        output: openClawTaskGetOutputSchema,
        outputSchemaId: "openClawTasks.get.output",
        summary: "Reads one task detail with its source-bounded prompt.",
        transport: taskQueryTransport,
    },
    {
        access: taskWriteAccess,
        domain: "openClawTasks",
        errorReasons: ["operation_outcome_unknown"],
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: openClawTaskCancelInputSchema,
        inputSchemaId: "openClawTasks.cancel.input",
        kind: "mutation",
        name: "openClawTasks.cancel",
        output: openClawTaskCancelOutputSchema,
        outputSchemaId: "openClawTasks.cancel.output",
        summary: "Requests cancellation by exact OpenClaw task id.",
        transport: taskMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];
