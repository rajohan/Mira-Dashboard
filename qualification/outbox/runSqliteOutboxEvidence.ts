import { Clock, Effect } from "effect";

import {
    sqliteOutboxQualification,
    summarizeOutboxLatencies,
} from "./sqliteOutboxQualification.ts";

const defaultSampleCount = 5;
const maximumSampleCount = 20;
const nanosecondsPerMillisecond = 1_000_000;

function parseSampleCount(value: string | undefined): number {
    if (value === undefined) return defaultSampleCount;
    if (!/^[1-9][0-9]*$/u.test(value)) {
        throw new Error("Outbox evidence sample count must be a positive integer");
    }
    const sampleCount = Number(value);
    if (!Number.isSafeInteger(sampleCount) || sampleCount > maximumSampleCount) {
        throw new Error(
            `Outbox evidence sample count must not exceed ${maximumSampleCount}`
        );
    }
    return sampleCount;
}

const sampleCount = parseSampleCount(process.argv[2]);
const evidence = Effect.gen(function* () {
    const convergenceSamplesMs = yield* Effect.forEach(
        Array.from({ length: sampleCount }),
        () =>
            Effect.gen(function* () {
                const startedAt = yield* Clock.monotonicTimeNanos;
                yield* sqliteOutboxQualification;
                const endedAt = yield* Clock.monotonicTimeNanos;
                return Number(endedAt - startedAt) / nanosecondsPerMillisecond;
            }),
        { concurrency: 1 }
    );
    return Object.freeze({
        bunVersion: Bun.version,
        metric: "producer-to-drained-and-restored-scenario-ms",
        samples: summarizeOutboxLatencies(convergenceSamplesMs),
        thresholdsEnforced: false,
    });
});

const result = await Effect.runPromise(evidence);
process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
