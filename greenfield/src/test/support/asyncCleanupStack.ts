import { Data, Effect } from "effect";

/** One asynchronous cleanup registered by an integration test. */
interface AsyncCleanupOperation {
    label: string;
    operation: (signal: AbortSignal) => Promise<void> | void;
}

export class AsyncCleanupDeadlineError extends Data.TaggedError(
    "AsyncCleanupDeadlineError"
)<{
    readonly label: string;
    readonly message: string;
    readonly timeoutMs: number;
}> {}

export class AsyncCleanupOperationError extends Data.TaggedError(
    "AsyncCleanupOperationError"
)<{
    readonly cause: unknown;
    readonly label: string;
    readonly message: string;
}> {}

function completeBeforeDeadline(
    cleanup: AsyncCleanupOperation,
    timeoutMs: number
): Effect.Effect<void, AsyncCleanupDeadlineError | AsyncCleanupOperationError> {
    return Effect.tryPromise({
        catch: (cause) =>
            new AsyncCleanupOperationError({
                cause,
                label: cleanup.label,
                message: `${cleanup.label} cleanup failed`,
            }),
        try: async (signal) => {
            await cleanup.operation(signal);
        },
    }).pipe(
        Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
                Effect.fail(
                    new AsyncCleanupDeadlineError({
                        label: cleanup.label,
                        message: `${cleanup.label} did not stop within ${timeoutMs} ms`,
                        timeoutMs,
                    })
                ),
        })
    );
}

function drainCleanupOperations(
    operations: readonly AsyncCleanupOperation[],
    timeoutMs: number
): Effect.Effect<void, AggregateError> {
    return Effect.uninterruptible(
        Effect.gen(function* () {
            const failures: (AsyncCleanupDeadlineError | AsyncCleanupOperationError)[] =
                [];

            for (const cleanup of operations) {
                yield* completeBeforeDeadline(cleanup, timeoutMs).pipe(
                    Effect.catch((error) =>
                        Effect.sync(() => {
                            failures.push(error);
                        })
                    )
                );
            }

            if (failures.length > 0) {
                return yield* Effect.fail(
                    new AggregateError(failures, "Integration resource cleanup failed")
                );
            }
        })
    );
}

/** Failure-safe last-in-first-out cleanup for integration resources. */
export class AsyncCleanupStack {
    readonly #operations: AsyncCleanupOperation[] = [];

    /**
     * Registers a resource cleanup immediately after acquisition.
     * @param label Diagnostic resource label.
     * @param operation Cleanup callback.
     */
    defer(label: string, operation: (signal: AbortSignal) => Promise<void> | void): void {
        this.#operations.push({ label, operation });
    }

    /**
     * Creates an Effect-native disposal for scoped integration orchestration.
     * @param timeoutMs Per-resource cleanup deadline in milliseconds.
     * @returns Uninterruptible LIFO drain with individually bounded operations.
     */
    disposeEffect(timeoutMs = 2000): Effect.Effect<void, AggregateError> {
        return Effect.suspend(() =>
            drainCleanupOperations(this.#operations.splice(0).toReversed(), timeoutMs)
        );
    }

    /**
     * Runs every registered cleanup even when an earlier cleanup fails.
     * @returns Promise that settles after the complete LIFO drain.
     */
    dispose(): Promise<void> {
        return Effect.runPromise(this.disposeEffect());
    }
}
