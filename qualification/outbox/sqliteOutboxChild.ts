import { Data, Effect } from "effect";
import * as v from "valibot";

import {
    sqliteOutboxMaximumBatchSize,
    sqliteOutboxMaximumDrainNonemptyPolls,
    type SqliteOutboxChildStatus,
} from "./sqliteOutboxProtocol.ts";
import {
    appendQualificationOutboxBatch,
    claimQualificationOutboxBatch,
    deliverQualificationOutboxClaims,
    openQualificationOutboxDatabase,
    retryQualificationSqliteOperation,
} from "./sqliteOutboxStore.ts";

const pathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const identifierSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/u));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const timestampSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const boundedBatchSchema = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(sqliteOutboxMaximumBatchSize)
);

const produceCommandSchema = v.strictObject({
    count: boundedBatchSchema,
    createdAt: timestampSchema,
    databasePath: pathSchema,
    kind: v.literal("produce"),
    producerId: identifierSchema,
    statusPath: pathSchema,
});
const claimAndHoldCommandSchema = v.strictObject({
    databasePath: pathSchema,
    kind: v.literal("claim-and-hold"),
    leaseUntil: timestampSchema,
    limit: boundedBatchSchema,
    now: timestampSchema,
    statusPath: pathSchema,
    workerId: identifierSchema,
});
const drainCommandSchema = v.strictObject({
    batchSize: boundedBatchSchema,
    databasePath: pathSchema,
    kind: v.literal("drain"),
    leaseDuration: positiveIntegerSchema,
    now: timestampSchema,
    statusPath: pathSchema,
    workerId: identifierSchema,
});
const childCommandSchema = v.variant("kind", [
    produceCommandSchema,
    claimAndHoldCommandSchema,
    drainCommandSchema,
]);

type ChildCommand = v.InferOutput<typeof childCommandSchema>;

class QualificationChildArgumentError extends Data.TaggedError(
    "QualificationChildArgumentError"
)<{
    readonly message: string;
}> {}

class QualificationChildStatusWriteError extends Data.TaggedError(
    "QualificationChildStatusWriteError"
)<{
    readonly cause: unknown;
}> {}

class QualificationOutboxPollingExhaustedError extends Data.TaggedError(
    "QualificationOutboxPollingExhaustedError"
)<{
    readonly maximumPolls: number;
}> {}

function parseInteger(value: string | undefined): number {
    if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
    return Number(value);
}

function parseCommand(arguments_: readonly string[]): ChildCommand {
    const [kind, databasePath, statusPath, identifier, first, second, third] = arguments_;
    switch (kind) {
        case "produce": {
            return v.parse(produceCommandSchema, {
                count: parseInteger(first),
                createdAt: parseInteger(second),
                databasePath,
                kind,
                producerId: identifier,
                statusPath,
            });
        }
        case "claim-and-hold": {
            const command = v.parse(claimAndHoldCommandSchema, {
                databasePath,
                kind,
                leaseUntil: parseInteger(second),
                limit: parseInteger(third),
                now: parseInteger(first),
                statusPath,
                workerId: identifier,
            });
            if (command.leaseUntil <= command.now) {
                throw new QualificationChildArgumentError({
                    message: "Claim lease must expire after its logical claim time",
                });
            }
            return command;
        }
        case "drain": {
            return v.parse(drainCommandSchema, {
                batchSize: parseInteger(third),
                databasePath,
                kind,
                leaseDuration: parseInteger(second),
                now: parseInteger(first),
                statusPath,
                workerId: identifier,
            });
        }
        default: {
            throw new QualificationChildArgumentError({
                message: "Unrecognized SQLite outbox qualification child command",
            });
        }
    }
}

function writeStatus(
    statusPath: string,
    status: SqliteOutboxChildStatus
): Effect.Effect<void, QualificationChildStatusWriteError> {
    return Effect.tryPromise({
        catch: (cause) => new QualificationChildStatusWriteError({ cause }),
        try: () => Bun.write(statusPath, `${JSON.stringify(status)}\n`),
    }).pipe(Effect.asVoid);
}

function runDrainCommand(
    database: ReturnType<typeof openQualificationOutboxDatabase>,
    command: Extract<ChildCommand, { kind: "drain" }>
) {
    const maximumPolls = sqliteOutboxMaximumDrainNonemptyPolls + 1;
    return Effect.gen(function* () {
        let claimedCount = 0;
        let deliveredCount = 0;
        for (let poll = 0; poll < maximumPolls; poll += 1) {
            const claimedEventIds = yield* retryQualificationSqliteOperation(() =>
                claimQualificationOutboxBatch(
                    database,
                    command.workerId,
                    command.now,
                    command.now + command.leaseDuration,
                    command.batchSize
                )
            );
            claimedCount += claimedEventIds.length;
            if (claimedEventIds.length === 0) {
                return { claimedCount, deliveredCount };
            }
            const deliveredEventIds = yield* retryQualificationSqliteOperation(() =>
                deliverQualificationOutboxClaims(database, command.workerId, command.now)
            );
            deliveredCount += deliveredEventIds.length;
            yield* Effect.sleep("1 millis");
        }
        return yield* Effect.fail(
            new QualificationOutboxPollingExhaustedError({ maximumPolls })
        );
    });
}

function childProgram(command: ChildCommand) {
    return Effect.scoped(
        Effect.gen(function* () {
            const database = yield* Effect.acquireRelease(
                Effect.sync(() => openQualificationOutboxDatabase(command.databasePath)),
                (acquiredDatabase) => Effect.sync(() => acquiredDatabase.close(true))
            );

            switch (command.kind) {
                case "produce": {
                    const batch = yield* retryQualificationSqliteOperation(() =>
                        appendQualificationOutboxBatch(
                            database,
                            command.producerId,
                            command.count,
                            command.createdAt
                        )
                    );
                    yield* writeStatus(command.statusPath, {
                        count: batch.eventIds.length,
                        eventIds: [...batch.eventIds],
                        kind: "produced",
                        producerId: command.producerId,
                    });
                    return;
                }
                case "claim-and-hold": {
                    const eventIds = yield* retryQualificationSqliteOperation(() =>
                        claimQualificationOutboxBatch(
                            database,
                            command.workerId,
                            command.now,
                            command.leaseUntil,
                            command.limit
                        )
                    );
                    yield* writeStatus(command.statusPath, {
                        eventIds: [...eventIds],
                        kind: "claimed",
                        workerId: command.workerId,
                    });
                    return yield* Effect.never;
                }
                case "drain": {
                    const result = yield* runDrainCommand(database, command);
                    yield* writeStatus(command.statusPath, {
                        ...result,
                        kind: "drained",
                        workerId: command.workerId,
                    });
                }
            }
        })
    );
}

try {
    const command = parseCommand(process.argv.slice(2));
    await Effect.runPromise(childProgram(command));
} catch {
    process.stderr.write("SQLite outbox qualification child failed\n");
    process.exitCode = 1;
}
