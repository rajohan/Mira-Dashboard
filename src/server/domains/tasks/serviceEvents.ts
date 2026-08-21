import { addMilliseconds } from "date-fns";
import * as v from "valibot";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import {
    taskChangePayloadSchema,
    taskRealtimeRoutingSchema,
    taskRealtimeTopic,
} from "../../../contracts/taskRealtime.ts";
import { jsonObjectSchema, type JsonObject } from "../../../shared/json.ts";
import type { TaskEventInsert, TaskRepositoryUnitOfWork } from "./repositoryTypes.ts";

export interface TaskOperationActor {
    readonly id: string;
    readonly kind: "automation" | "user";
}

export type TaskEventType = TaskEventInsert["eventType"];
export type TaskRealtimeOperation = "created" | "deleted" | "updated";

/**
 * Converts an authenticated principal into the durable task actor identity.
 * @param principal Validated session or automation principal.
 * @returns Task-event author identity.
 */
export function taskOperationActor(
    principal: AuthenticatedPrincipal
): TaskOperationActor {
    return principal.kind === "automation"
        ? { id: principal.id, kind: "automation" }
        : { id: principal.id, kind: "user" };
}

function serializeTaskEventPayload(payload: JsonObject): string {
    return JSON.stringify(v.parse(jsonObjectSchema, payload));
}

/**
 * Appends one immutable, redacted task lifecycle event inside the caller transaction.
 * @returns Durable event identity reused by dependent transactional outbox records.
 */
export function appendTaskEvent(
    unit: TaskRepositoryUnitOfWork,
    input: {
        readonly actor: TaskOperationActor;
        readonly eventType: TaskEventType;
        readonly generateId: () => string;
        readonly occurredAt: Date;
        readonly payload: JsonObject;
        readonly taskId: string;
    }
): string {
    const eventId = input.generateId();
    unit.insertTaskEvent({
        actorId: input.actor.id,
        actorKind: input.actor.kind,
        createdAt: input.occurredAt,
        eventType: input.eventType,
        id: eventId,
        payloadJson: serializeTaskEventPayload(input.payload),
        taskId: input.taskId,
    });
    return eventId;
}

/** Appends one compact task invalidation to the durable realtime outbox. */
export function appendTaskRealtimeEvent(
    unit: TaskRepositoryUnitOfWork,
    input: {
        readonly operation: TaskRealtimeOperation;
        readonly occurredAt: Date;
        readonly retentionMs: number;
        readonly taskId: string;
    }
): void {
    v.parse(taskRealtimeRoutingSchema, {
        entityType: "task",
        operation: input.operation,
        topic: taskRealtimeTopic,
    });
    const payload = v.parse(taskChangePayloadSchema, { id: input.taskId });
    unit.insertRealtimeEvent({
        entityId: input.taskId,
        entityType: "task",
        expiresAt: addMilliseconds(input.occurredAt, input.retentionMs),
        occurredAt: input.occurredAt,
        operation: input.operation,
        payloadJson: JSON.stringify(payload),
        topic: taskRealtimeTopic,
    });
}
