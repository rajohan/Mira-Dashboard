import { Data, Effect } from "effect";

import {
    miraMainSessionKey,
    taskNotificationIdempotencyKey,
    taskNotificationLeaseMilliseconds,
    taskNotificationSendTimeoutMilliseconds,
    type ClaimedTaskNotification,
    type TaskNotificationChatSender,
    type TaskNotificationQueue,
} from "../shared/taskNotifications.ts";

const initialRetryDelayMilliseconds = 5000;
const maximumRetryDelayMilliseconds = 5 * 60 * 1000;
const maximumRetryExponent = 6;
const idlePollDelayMilliseconds = 1000;

export class TaskNotificationQueueError extends Data.TaggedError(
    "TaskNotificationQueueError"
)<{ readonly cause: unknown; readonly operation: "claim" | "deliver" | "retry" }> {}

export class TaskNotificationLeaseLostError extends Data.TaggedError(
    "TaskNotificationLeaseLostError"
)<{ readonly eventId: string; readonly operation: "deliver" | "retry" }> {}

class TaskNotificationSendError extends Data.TaggedError("TaskNotificationSendError")<{
    readonly cause: unknown;
}> {}

export interface TaskNotificationBatchReport {
    readonly claimed: number;
    readonly delivered: number;
    readonly retried: number;
}

export interface TaskNotificationWorkerDependencies {
    readonly nowMs?: () => number;
    readonly queue: TaskNotificationQueue;
    readonly sender: TaskNotificationChatSender;
    readonly workerId: string;
}

/**
 * Computes capped exponential retry delay from the already-incremented attempt count.
 * @param attemptCount Positive delivery attempt count.
 * @returns Retry delay in milliseconds.
 */
export function taskNotificationRetryDelayMs(attemptCount: number): number {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
        throw new RangeError("Task notification attempt count is invalid");
    }
    const exponent = Math.min(attemptCount - 1, maximumRetryExponent);
    return Math.min(
        initialRetryDelayMilliseconds * 2 ** exponent,
        maximumRetryDelayMilliseconds
    );
}

function queueEffect<T>(
    operation: "claim" | "deliver" | "retry",
    run: () => Promise<T>
): Effect.Effect<T, TaskNotificationQueueError> {
    return Effect.tryPromise({
        catch: (cause) => new TaskNotificationQueueError({ cause, operation }),
        try: run,
    });
}

function sendEffect(
    sender: TaskNotificationChatSender,
    notification: ClaimedTaskNotification
): Effect.Effect<void, TaskNotificationSendError> {
    return Effect.tryPromise({
        catch: (cause) => new TaskNotificationSendError({ cause }),
        try: (signal) =>
            sender.send(
                {
                    idempotencyKey: taskNotificationIdempotencyKey(notification.eventId),
                    message: notification.message,
                    sessionKey: miraMainSessionKey,
                },
                signal
            ),
    });
}

function settleClaim(
    dependencies: Required<Pick<TaskNotificationWorkerDependencies, "nowMs">> &
        TaskNotificationWorkerDependencies,
    notification: ClaimedTaskNotification
): Effect.Effect<
    "delivered" | "retried",
    TaskNotificationLeaseLostError | TaskNotificationQueueError
> {
    return Effect.uninterruptibleMask((restore) => {
        const markDelivered = Effect.gen(function* () {
            const settledAtMs = dependencies.nowMs();
            const acknowledged = yield* queueEffect("deliver", () =>
                dependencies.queue.markDelivered({
                    deliveredAtMs: settledAtMs,
                    eventId: notification.eventId,
                    workerId: dependencies.workerId,
                })
            );
            if (!acknowledged) {
                return yield* new TaskNotificationLeaseLostError({
                    eventId: notification.eventId,
                    operation: "deliver",
                });
            }
            return "delivered" as const;
        });
        const retryLater = Effect.gen(function* () {
            const settledAtMs = dependencies.nowMs();
            const released = yield* queueEffect("retry", () =>
                dependencies.queue.retryLater({
                    availableAtMs:
                        settledAtMs +
                        taskNotificationRetryDelayMs(notification.attemptCount),
                    eventId: notification.eventId,
                    settledAtMs,
                    workerId: dependencies.workerId,
                })
            );
            if (!released) {
                return yield* new TaskNotificationLeaseLostError({
                    eventId: notification.eventId,
                    operation: "retry",
                });
            }
            return "retried" as const;
        });
        return restore(
            sendEffect(dependencies.sender, notification).pipe(
                Effect.timeoutOrElse({
                    duration: taskNotificationSendTimeoutMilliseconds,
                    orElse: () =>
                        Effect.fail(
                            new TaskNotificationSendError({
                                cause: new DOMException(
                                    "Task notification send timed out",
                                    "TimeoutError"
                                ),
                            })
                        ),
                })
            )
        ).pipe(
            Effect.matchEffect({
                onFailure: () => retryLater,
                onSuccess: () => markDelivered,
            }),
            Effect.onInterrupt(() => retryLater.pipe(Effect.asVoid))
        );
    });
}

/**
 * Claims and sequentially settles one ordered notification batch.
 * Gateway idempotency closes the crash window between send and durable acknowledgement.
 * @param dependencies Queue, sender, worker identity, and replaceable clock.
 * @returns Counts for the completed pass.
 */
export function processTaskNotificationBatch(
    dependencies: TaskNotificationWorkerDependencies
): Effect.Effect<
    TaskNotificationBatchReport,
    TaskNotificationLeaseLostError | TaskNotificationQueueError
> {
    const resolvedDependencies = {
        ...dependencies,
        nowMs: dependencies.nowMs ?? Date.now,
    };
    return Effect.gen(function* () {
        const claimedAtMs = resolvedDependencies.nowMs();
        const notifications = yield* queueEffect("claim", () =>
            dependencies.queue.claim({
                leaseExpiresAtMs: claimedAtMs + taskNotificationLeaseMilliseconds,
                nowMs: claimedAtMs,
                workerId: dependencies.workerId,
            })
        );
        let delivered = 0;
        let retried = 0;
        for (const notification of notifications) {
            const outcome = yield* settleClaim(resolvedDependencies, notification);
            if (outcome === "delivered") delivered += 1;
            else retried += 1;
        }
        return Object.freeze({
            claimed: notifications.length,
            delivered,
            retried,
        });
    });
}

/**
 * Runs the long-lived worker loop with bounded idle polling and safe claim settlement.
 * @returns Nonterminating Effect interrupted by the owning worker runtime.
 */
export function taskNotificationWorkerLoop(
    dependencies: TaskNotificationWorkerDependencies
): Effect.Effect<never, TaskNotificationLeaseLostError | TaskNotificationQueueError> {
    return processTaskNotificationBatch(dependencies).pipe(
        Effect.flatMap((report) =>
            report.claimed === 0 ? Effect.sleep(idlePollDelayMilliseconds) : Effect.void
        ),
        Effect.forever
    );
}
