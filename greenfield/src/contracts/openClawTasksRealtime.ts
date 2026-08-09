import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { realtimeEventRetentionLabel, type RealtimeTopicDefinition } from "./realtime.ts";
import type { RealtimeEventContract } from "./registry.ts";

export const openClawTasksRealtimeTopic = "openclaw.tasks" as const;

/** Payload-free invalidation: provider task content is fetched only through list/get. */
export const openClawTasksSnapshotRequiredPayloadSchema = v.strictObject({
    kind: v.literal("snapshot-required"),
});

export const openClawTasksRealtimeTopicDefinition = {
    capability: "openclaw-tasks:read",
    entityTypes: ["openclaw-task"],
    operations: ["snapshot-required"],
    payload: openClawTasksSnapshotRequiredPayloadSchema,
    topic: openClawTasksRealtimeTopic,
} as const satisfies RealtimeTopicDefinition;

export const openClawTasksRealtimeEventContract = {
    payload: openClawTasksSnapshotRequiredPayloadSchema,
    payloadSchemaId: "openclaw.tasks.realtime.payload",
    retention: realtimeEventRetentionLabel,
    snapshotProcedure: "openClawTasks.list",
    summary:
        "Invalidates the bounded OpenClaw task list without persisting provider task payloads.",
    topic: openClawTasksRealtimeTopic,
} as const satisfies RealtimeEventContract;

export const openClawTasksRealtimeRoutingSchema = v.strictObject({
    entityType: v.literal("openclaw-task"),
    operation: v.literal("snapshot-required"),
    topic: v.literal(openClawTasksRealtimeTopic),
});

export const openClawTasksRealtimeChangeSchema = v.strictObject({
    entityId: v.literal("current"),
    entityType: v.literal("openclaw-task"),
    occurredAtMs: timestampMillisecondsSchema(
        "OpenClaw task realtime timestamp is invalid"
    ),
    operation: v.literal("snapshot-required"),
    payload: openClawTasksSnapshotRequiredPayloadSchema,
    topic: v.literal(openClawTasksRealtimeTopic),
});
