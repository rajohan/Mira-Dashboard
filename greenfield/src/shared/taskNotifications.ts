import * as v from "valibot";

import { utf8ByteLength } from "./encoding.ts";
import { boundedControlSafeTextSchema, lowercaseUuidV7Schema } from "./validation.ts";

/** Maximum encoded bytes retained for one redacted task chat notification. */
export const taskNotificationMessageMaximumBytes = 2 * 1024;

/** Maximum number of ordered task notifications claimed in one worker pass. */
export const taskNotificationClaimMaximum = 1;

/** Lease held while one worker sends a claimed chat notification. */
export const taskNotificationLeaseMilliseconds = 30_000;

/** Deadline reserved for the abortable Gateway send within one live lease. */
export const taskNotificationSendTimeoutMilliseconds = 10_000;

/** Stable canonical target for Mira's main OpenClaw conversation. */
export const miraMainSessionKey = "agent:main:main";

export const taskNotificationMessageSchema = v.pipe(
    boundedControlSafeTextSchema(
        taskNotificationMessageMaximumBytes,
        "Task notification message is invalid"
    ),
    v.check(
        (message) => utf8ByteLength(message) <= taskNotificationMessageMaximumBytes,
        "Task notification message exceeds its encoded byte budget"
    )
);

export const taskNotificationEventIdSchema = lowercaseUuidV7Schema(
    "Task notification event id is invalid"
);

/** One validated delivery claimed by a worker after its attempt count increments. */
export interface ClaimedTaskNotification {
    readonly attemptCount: number;
    readonly eventId: string;
    readonly message: string;
}

/** Durable queue operations required by the task-notification worker. */
export interface TaskNotificationQueue {
    claim(input: {
        readonly leaseExpiresAtMs: number;
        readonly nowMs: number;
        readonly workerId: string;
    }): Promise<readonly ClaimedTaskNotification[]>;
    markDelivered(input: {
        readonly deliveredAtMs: number;
        readonly eventId: string;
        readonly workerId: string;
    }): Promise<boolean>;
    retryLater(input: {
        readonly availableAtMs: number;
        readonly eventId: string;
        readonly settledAtMs: number;
        readonly workerId: string;
    }): Promise<boolean>;
}

/** Narrow persistent-Gateway port used only for one idempotent chat send. */
export interface TaskNotificationChatSender {
    send(
        input: {
            readonly idempotencyKey: string;
            readonly message: string;
            readonly sessionKey: typeof miraMainSessionKey;
        },
        signal: AbortSignal
    ): Promise<void>;
}

/**
 * Derives the stable Gateway idempotency key from the authoritative task event.
 * @param eventId Validated task event identity.
 * @returns Stable notification request identity reused after ambiguous failures.
 */
export function taskNotificationIdempotencyKey(eventId: string): string {
    return `tasks-notify-${v.parse(taskNotificationEventIdSchema, eventId)}`;
}
