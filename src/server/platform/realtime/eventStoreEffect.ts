import { Duration, Effect, Predicate, Schedule, Schema } from "effect";
import * as v from "valibot";

export class RealtimeEventStoreBusyError extends Schema.TaggedErrorClass<RealtimeEventStoreBusyError>(
    "mira-dashboard/server/platform/realtime/RealtimeEventStoreBusyError"
)("RealtimeEventStoreBusyError", {
    cause: Schema.Defect(),
    code: Schema.String,
}) {}

export class RealtimeEventStoreUnavailableError extends Schema.TaggedErrorClass<RealtimeEventStoreUnavailableError>(
    "mira-dashboard/server/platform/realtime/RealtimeEventStoreUnavailableError"
)("RealtimeEventStoreUnavailableError", {
    cause: Schema.Defect(),
    code: Schema.String,
}) {}

export type RealtimeEventStoreOperationError =
    | RealtimeEventStoreBusyError
    | RealtimeEventStoreUnavailableError;

export interface RealtimeEventStoreRetryOptions {
    readonly maximumRetries: number;
    readonly retryBaseDelayMs: number;
    readonly retryMaximumDelayMs: number;
    readonly onAttemptFailure?: () => void;
    readonly onRetry?: () => void;
}

const sqliteErrorSchema = v.object({
    code: v.pipe(v.string(), v.startsWith("SQLITE_")),
});

function sqliteErrorCode(error: unknown): string | undefined {
    const result = v.safeParse(sqliteErrorSchema, error);
    return result.success ? result.output.code : undefined;
}

const isBusyError = Predicate.isTagged("RealtimeEventStoreBusyError");

function retrySchedule(
    options: RealtimeEventStoreRetryOptions
): Schedule.Schedule<Duration.Duration> {
    return Schedule.exponential(Duration.millis(options.retryBaseDelayMs)).pipe(
        Schedule.modifyDelay(({ duration }) => {
            const boundedDelayMs = Math.min(
                Duration.toMillis(duration),
                options.retryMaximumDelayMs
            );
            return Effect.succeed(Duration.millis(boundedDelayMs));
        }),
        Schedule.upTo({ times: options.maximumRetries }),
        Schedule.while(({ input }) => isBusyError(input)),
        Schedule.tap(() => Effect.sync(() => options.onRetry?.()))
    );
}

/**
 * Runs one synchronous SQLite read in Effect, retrying only SQLITE_BUSY variants.
 * Unknown failures remain defects and non-busy SQLite failures remain typed failures.
 * @param operation Synchronous SQLite read to attempt.
 * @param options Validated retry policy and optional metric hooks.
 * @returns An Effect that succeeds with the read result or fails with a classified store error.
 */
export const retryRealtimeEventStoreOperation = Effect.fn(
    "RealtimeEventStore.retryOperation"
)(function* <A>(
    operation: () => A,
    options: RealtimeEventStoreRetryOptions
): Effect.fn.Return<A, RealtimeEventStoreOperationError> {
    const attempt = Effect.suspend(() => {
        try {
            return Effect.succeed(operation());
        } catch (error) {
            options.onAttemptFailure?.();
            const code = sqliteErrorCode(error);
            if (code === undefined) {
                return Effect.die(error);
            }
            const failure: RealtimeEventStoreOperationError =
                code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_")
                    ? new RealtimeEventStoreBusyError({ cause: error, code })
                    : new RealtimeEventStoreUnavailableError({ cause: error, code });
            return Effect.fail(failure);
        }
    });

    return yield* attempt.pipe(Effect.retry({ schedule: retrySchedule(options) }));
});
