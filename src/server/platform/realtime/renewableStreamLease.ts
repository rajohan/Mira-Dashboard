import {
    differenceInMilliseconds,
    minutesToMilliseconds,
    secondsToMilliseconds,
    toDate,
} from "date-fns";
import { Clock, Duration, Effect, Fiber, Schema, Stream } from "effect";

const maximumLeaseWaitMs = minutesToMilliseconds(5);
const renewalTimeoutMs = secondsToMilliseconds(5);
const nanosecondsPerMillisecond = 1_000_000n;

/** Generic lease renewed before a protected stream may emit after its deadline. */
export interface RenewableStreamLease {
    readonly expiresAtMs: number;
    renew(signal: AbortSignal): Promise<RenewableStreamLease>;
}

/** Typed operational failure when a lease provider does not answer in time. */
export class RenewableStreamLeaseTimeoutError extends Schema.TaggedErrorClass<RenewableStreamLeaseTimeoutError>(
    "mira-dashboard/server/platform/realtime/RenewableStreamLeaseTimeoutError"
)("RenewableStreamLeaseTimeoutError", {
    message: Schema.String,
}) {}

/** Typed invariant failure when a provider returns an already expired lease. */
export class RenewableStreamLeaseInvalidError extends Schema.TaggedErrorClass<RenewableStreamLeaseInvalidError>(
    "mira-dashboard/server/platform/realtime/RenewableStreamLeaseInvalidError"
)("RenewableStreamLeaseInvalidError", {
    message: Schema.String,
}) {}

export type RenewableStreamLeaseError =
    | RenewableStreamLeaseInvalidError
    | RenewableStreamLeaseTimeoutError;

const renewableStreamLeaseErrorSchema = Schema.Union([
    RenewableStreamLeaseInvalidError,
    RenewableStreamLeaseTimeoutError,
]);

/** Runtime guard for typed lease failures crossing the Effect/iterator boundary. */
export const isRenewableStreamLeaseError = Schema.is(renewableStreamLeaseErrorSchema);

interface ActiveStreamLease {
    readonly deadlineNanos: bigint;
    readonly lease: RenewableStreamLease;
}

function activateLease(
    lease: RenewableStreamLease,
    requireFuture: boolean
): Effect.Effect<ActiveStreamLease, RenewableStreamLeaseInvalidError> {
    return Effect.gen(function* () {
        const currentMonotonicNanos = yield* Clock.monotonicTimeNanos;
        const currentTimeMs = yield* Clock.currentTimeMillis;
        const remainingMs = differenceInMilliseconds(
            toDate(lease.expiresAtMs),
            toDate(currentTimeMs)
        );
        if (requireFuture && remainingMs <= 0) {
            return yield* Effect.fail(
                new RenewableStreamLeaseInvalidError({
                    message: "Realtime authentication renewal returned an expired lease",
                })
            );
        }
        const boundedRemainingMs = Math.max(0, Math.min(remainingMs, maximumLeaseWaitMs));
        return Object.freeze({
            deadlineNanos:
                currentMonotonicNanos +
                BigInt(boundedRemainingMs) * nanosecondsPerMillisecond,
            lease,
        });
    });
}

function renewLease(
    active: ActiveStreamLease
): Effect.Effect<ActiveStreamLease, unknown> {
    return Effect.tryPromise({
        catch: (error) => error,
        try: (signal) => active.lease.renew(signal),
    }).pipe(
        Effect.timeoutOrElse({
            duration: renewalTimeoutMs,
            orElse: () =>
                Effect.fail(
                    new RenewableStreamLeaseTimeoutError({
                        message: "Realtime authentication renewal timed out",
                    })
                ),
        }),
        Effect.flatMap((lease) => activateLease(lease, true))
    );
}

/**
 * Gates individual Effect Stream elements with one monotonically timed lease.
 * A pending upstream pull stays in one child fiber across any number of renewals.
 * @param source Scoped upstream stream.
 * @param initialLease Initial validated domain lease.
 * @returns The source stream with renewal, interruption, and timeout in its scope.
 */
export function withRenewableStreamLease<A, E, R>(
    source: Stream.Stream<A, E, R>,
    initialLease: RenewableStreamLease
): Stream.Stream<A, unknown, R> {
    return Stream.transformPull(Stream.rechunk(source, 1), (pull) =>
        Effect.gen(function* () {
            let active = yield* activateLease(initialLease, false);

            return Effect.suspend(() =>
                Effect.gen(function* () {
                    const beforePull = yield* Clock.monotonicTimeNanos;
                    if (beforePull >= active.deadlineNanos) {
                        active = yield* renewLease(active);
                    }
                    const pullFiber = yield* Effect.forkChild(pull);

                    while (true) {
                        const beforeWait = yield* Clock.monotonicTimeNanos;
                        if (beforeWait >= active.deadlineNanos) {
                            active = yield* renewLease(active);
                            continue;
                        }

                        const remainingLeaseDuration = Duration.nanos(
                            active.deadlineNanos - beforeWait
                        );
                        const leaseExpiration = Effect.sleep(remainingLeaseDuration).pipe(
                            Effect.as({ kind: "lease-expired" } as const)
                        );
                        const outcome = yield* Fiber.await(pullFiber).pipe(
                            Effect.map((exit) => ({ exit, kind: "pull" }) as const),
                            Effect.raceFirst(leaseExpiration)
                        );

                        if (outcome.kind === "lease-expired") {
                            active = yield* renewLease(active);
                            continue;
                        }

                        const completedAt = yield* Clock.monotonicTimeNanos;
                        if (completedAt >= active.deadlineNanos) {
                            active = yield* renewLease(active);
                        }
                        return yield* outcome.exit;
                    }
                })
            );
        })
    );
}
