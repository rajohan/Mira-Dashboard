import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import type { RealtimeTopicDefinition } from "./realtime.ts";
import { taskIdSchema } from "./taskModel.ts";

/** Durable topic carrying compact task cache invalidations. */
export const taskRealtimeTopic = "tasks.records";

const taskEntityType = "task";
const taskOperations = ["created", "deleted", "updated"] as const;

/** Producer routing metadata accepted by task-domain outbox writes. */
export const taskRealtimeRoutingSchema = v.strictObject({
    entityType: v.literal(taskEntityType),
    operation: v.picklist(taskOperations),
    topic: v.literal(taskRealtimeTopic),
});

/** Compact task change payload used to refetch or remove one cache row. */
export const taskChangePayloadSchema = v.strictObject({ id: taskIdSchema });

/** Topic-specific capability, entity, operation, and payload policy. */
export const taskRealtimeTopicDefinition = {
    capability: "tasks:read",
    entityTypes: [taskEntityType],
    operations: taskOperations,
    payload: taskChangePayloadSchema,
    topic: taskRealtimeTopic,
} as const satisfies RealtimeTopicDefinition;

/** Client-visible validated task change event. */
export const taskRealtimeChangeSchema = v.strictObject({
    entityId: taskIdSchema,
    entityType: v.literal(taskEntityType),
    occurredAtMs: timestampMillisecondsSchema("Task realtime timestamp is invalid"),
    operation: v.picklist(taskOperations),
    payload: taskChangePayloadSchema,
    topic: v.literal(taskRealtimeTopic),
});
