import { addMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    jobChangePayloadSchema,
    jobRealtimeRoutingSchema,
    jobRealtimeTopics,
} from "../../../contracts/jobRealtime.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { auditEventInsertSchema } from "../../database/validation/auditEvents.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import { defaultRealtimeRetentionMilliseconds } from "../realtime/retention.ts";
import type { JobMutationSideEffects } from "./repository.ts";

export type JobAuditEventInsert = v.InferOutput<typeof auditEventInsertSchema>;
export type JobRealtimeEventInsert = v.InferOutput<typeof realtimeEventInsertSchema>;

/** Redacted durable actor identity used for jobs-domain audit rows. */
export interface JobAuditActor {
    readonly authenticatorId: string | null;
    readonly id: string;
    readonly kind: "automation" | "system" | "user";
}

export type JobRealtimeTarget =
    | { readonly id: string; readonly kind: "queue" }
    | {
          readonly id: string;
          readonly kind: "run";
          readonly operation: "created" | "updated";
      }
    | {
          readonly id: string;
          readonly kind: "schedule";
          readonly operation: "created" | "updated";
      };

export interface CreateJobMutationSideEffectsInput {
    readonly action: string;
    readonly actor: JobAuditActor;
    readonly auditId: string;
    readonly metadata?: JsonObject;
    readonly occurredAt: Date;
    readonly outcome: "accepted" | "cancelled" | "failed" | "succeeded";
    readonly realtime?: JobRealtimeTarget;
    readonly realtimeRetentionMs?: number;
    readonly requestId?: string;
    readonly targetId: string;
    readonly targetType: "job-run" | "job-worker" | "schedule";
}

/** Realtime-only invalidation input for durable mutations that are their own history. */
export interface CreateJobRealtimeSideEffectsInput {
    readonly occurredAt: Date;
    readonly realtime: JobRealtimeTarget;
    readonly realtimeRetentionMs?: number;
}

function createJobRealtimeEvent(
    target: JobRealtimeTarget,
    occurredAt: Date,
    retentionMs: number
): JobRealtimeEventInsert {
    const routing = (() => {
        if (target.kind === "run") {
            return {
                entityType: "job-run" as const,
                operation: target.operation,
                topic: jobRealtimeTopics.runs,
            };
        }
        if (target.kind === "schedule") {
            return {
                entityType: "schedule" as const,
                operation: target.operation,
                topic: jobRealtimeTopics.schedules,
            };
        }
        return {
            entityType: "job-queue" as const,
            operation: "snapshot-required" as const,
            topic: jobRealtimeTopics.runs,
        };
    })();
    v.parse(jobRealtimeRoutingSchema, routing);
    const payload = v.parse(jobChangePayloadSchema, { id: target.id });
    return v.parse(realtimeEventInsertSchema, {
        entityId: target.id,
        entityType: routing.entityType,
        expiresAt: addMilliseconds(occurredAt, retentionMs),
        occurredAt,
        operation: routing.operation,
        payloadJson: JSON.stringify(payload),
        topic: routing.topic,
    });
}

/**
 * Builds a compact realtime invalidation without duplicating a durable domain event in
 * the security audit log.
 * @param input Committed transition time and affected jobs-domain target.
 * @returns Frozen realtime-only side effects for the surrounding transaction.
 */
export function createJobRealtimeSideEffects(
    input: CreateJobRealtimeSideEffectsInput
): JobMutationSideEffects {
    return Object.freeze({
        auditEvents: Object.freeze([]),
        realtimeEvents: Object.freeze([
            createJobRealtimeEvent(
                input.realtime,
                input.occurredAt,
                input.realtimeRetentionMs ?? defaultRealtimeRetentionMilliseconds
            ),
        ]),
    });
}

/**
 * Builds validated rows that a repository appends in the same transaction as state.
 * @param input Redacted audit and compact invalidation description.
 * @returns Immutable side-effect rows for one atomic mutation.
 */
export function createJobMutationSideEffects(
    input: CreateJobMutationSideEffectsInput
): JobMutationSideEffects {
    const auditEvent = v.parse(auditEventInsertSchema, {
        action: input.action,
        actorId: input.actor.id,
        actorKind: input.actor.kind,
        authenticatorId: input.actor.authenticatorId,
        id: input.auditId,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        occurredAt: input.occurredAt,
        outcome: input.outcome,
        requestId: input.requestId ?? null,
        targetId: input.targetId,
        targetType: input.targetType,
    });
    const realtimeEvents =
        input.realtime === undefined
            ? []
            : createJobRealtimeSideEffects({
                  occurredAt: input.occurredAt,
                  realtime: input.realtime,
                  ...(input.realtimeRetentionMs === undefined
                      ? {}
                      : { realtimeRetentionMs: input.realtimeRetentionMs }),
              }).realtimeEvents;
    return Object.freeze({
        auditEvents: Object.freeze([auditEvent]),
        realtimeEvents: Object.freeze(realtimeEvents),
    });
}
