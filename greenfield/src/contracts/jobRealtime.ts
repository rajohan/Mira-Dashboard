import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { jobRunIdSchema, scheduleIdSchema } from "./jobModel.ts";
import { realtimeEventRetentionLabel, type RealtimeTopicDefinition } from "./realtime.ts";
import type { RealtimeEventContract } from "./registry.ts";

/** Durable job and schedule invalidation topics. */
export const jobRealtimeTopics = Object.freeze({
    runs: "jobs.runs",
    schedules: "schedules.records",
});

const jobRunEntityType = "job-run";
const jobQueueEntityType = "job-queue";
const scheduleEntityType = "schedule";
const jobRunOperations = ["created", "updated"] as const;
const jobQueueOperations = ["snapshot-required"] as const;
const scheduleOperations = ["created", "updated"] as const;

const jobRunRoutingEntries = {
    entityType: v.literal(jobRunEntityType),
    operation: v.picklist(jobRunOperations),
    topic: v.literal(jobRealtimeTopics.runs),
};
const jobQueueRoutingEntries = {
    entityType: v.literal(jobQueueEntityType),
    operation: v.picklist(jobQueueOperations),
    topic: v.literal(jobRealtimeTopics.runs),
};
const scheduleRoutingEntries = {
    entityType: v.literal(scheduleEntityType),
    operation: v.picklist(scheduleOperations),
    topic: v.literal(jobRealtimeTopics.schedules),
};

/** Producer routing that keeps run, queue-summary, and schedule events distinct. */
export const jobRealtimeRoutingSchema = v.variant("entityType", [
    v.strictObject(jobRunRoutingEntries),
    v.strictObject(jobQueueRoutingEntries),
    v.strictObject(scheduleRoutingEntries),
]);

/** Compact invalidation payload shared by job and schedule consumers. */
export const jobChangePayloadSchema = v.strictObject({
    id: v.union([jobRunIdSchema, scheduleIdSchema]),
});

/** Topic-specific capability, entity, operation, and payload policies. */
export const jobRealtimeTopicDefinitions = [
    {
        capability: "jobs:read",
        entityTypes: [jobQueueEntityType, jobRunEntityType],
        operations: [...jobQueueOperations, ...jobRunOperations],
        payload: jobChangePayloadSchema,
        topic: jobRealtimeTopics.runs,
    },
    {
        capability: "jobs:read",
        entityTypes: [scheduleEntityType],
        operations: scheduleOperations,
        payload: jobChangePayloadSchema,
        topic: jobRealtimeTopics.schedules,
    },
] as const satisfies readonly RealtimeTopicDefinition[];

/** Standalone durable-job invalidations and their authoritative snapshots. */
export const jobRealtimeEventContracts = [
    {
        payload: jobChangePayloadSchema,
        payloadSchemaId: "jobs.runs.realtime.payload",
        retention: realtimeEventRetentionLabel,
        snapshotProcedure: "jobs.listRuns",
        summary: "Invalidates durable run rows and exact queue state.",
        topic: jobRealtimeTopics.runs,
    },
    {
        payload: jobChangePayloadSchema,
        payloadSchemaId: "schedules.records.realtime.payload",
        retention: realtimeEventRetentionLabel,
        snapshotProcedure: "schedules.list",
        summary: "Invalidates the code-owned Dashboard schedule directory.",
        topic: jobRealtimeTopics.schedules,
    },
] as const satisfies readonly RealtimeEventContract[];

/**
 * Finds one exact durable-job topic policy.
 * @param topic Candidate durable topic.
 * @returns Its registered definition, when present.
 */
export function findJobRealtimeTopicDefinition(topic: string) {
    return jobRealtimeTopicDefinitions.find((definition) => definition.topic === topic);
}

const jobRealtimeTimestampSchema = timestampMillisecondsSchema(
    "Job realtime timestamp is invalid"
);

/**
 * @param event Compact durable-job invalidation envelope.
 * @returns Whether its routing and payload identities name the same entity.
 */
export function jobRealtimeIdentityMatches(event: {
    readonly entityId: string;
    readonly payload: { readonly id: string };
}): boolean {
    return event.payload.id === event.entityId;
}

const jobRunRealtimeChangeObjectSchema = v.strictObject({
    entityId: jobRunIdSchema,
    entityType: jobRunRoutingEntries.entityType,
    occurredAtMs: jobRealtimeTimestampSchema,
    operation: jobRunRoutingEntries.operation,
    payload: jobChangePayloadSchema,
    topic: jobRunRoutingEntries.topic,
});
const jobQueueRealtimeChangeObjectSchema = v.strictObject({
    entityId: scheduleIdSchema,
    entityType: jobQueueRoutingEntries.entityType,
    occurredAtMs: jobRealtimeTimestampSchema,
    operation: jobQueueRoutingEntries.operation,
    payload: jobChangePayloadSchema,
    topic: jobQueueRoutingEntries.topic,
});
const scheduleRealtimeChangeObjectSchema = v.strictObject({
    entityId: scheduleIdSchema,
    entityType: scheduleRoutingEntries.entityType,
    occurredAtMs: jobRealtimeTimestampSchema,
    operation: scheduleRoutingEntries.operation,
    payload: jobChangePayloadSchema,
    topic: scheduleRoutingEntries.topic,
});

/** Topic-specific client change schemas built from the producer routing policy. */
export const jobRealtimeChangeSchemas = [
    v.pipe(
        jobRunRealtimeChangeObjectSchema,
        v.check<
            v.InferOutput<typeof jobRunRealtimeChangeObjectSchema>,
            "Job realtime entity identity is inconsistent"
        >(jobRealtimeIdentityMatches, "Job realtime entity identity is inconsistent")
    ),
    v.pipe(
        jobQueueRealtimeChangeObjectSchema,
        v.check<
            v.InferOutput<typeof jobQueueRealtimeChangeObjectSchema>,
            "Job realtime entity identity is inconsistent"
        >(jobRealtimeIdentityMatches, "Job realtime entity identity is inconsistent")
    ),
    v.pipe(
        scheduleRealtimeChangeObjectSchema,
        v.check<
            v.InferOutput<typeof scheduleRealtimeChangeObjectSchema>,
            "Job realtime entity identity is inconsistent"
        >(jobRealtimeIdentityMatches, "Job realtime entity identity is inconsistent")
    ),
] as const;
