import {
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";

/** Process-level memory observed by one evidence sample. */
export interface ProcessMemorySnapshot {
    rssBytes: number;
    unsafeFootprintBytes: number | null;
}

/** Controlled periodic sampler used only by the capped evidence. */
export interface ProcessMemorySampler {
    sample(): ProcessMemorySnapshot;
    stop(): ProcessMemorySnapshot;
}

const processMemorySampleIntervalSchema = positiveSafeIntegerSchema(
    "Process memory sample interval must be a positive integer"
);

/**
 * Reads both resident-set size and Bun's private-memory estimate.
 * @returns Process memory values in bytes.
 */
export function readProcessMemorySnapshot(): ProcessMemorySnapshot {
    return {
        rssBytes: process.memoryUsage.rss(),
        unsafeFootprintBytes: Bun.unsafe.memoryFootprint() ?? null,
    };
}

/**
 * Keeps the largest value from every sampled process-memory dimension.
 * @param current Existing maximum.
 * @param sample Newly observed sample.
 * @returns Dimension-wise maximum memory.
 */
export function maximumProcessMemory(
    current: ProcessMemorySnapshot,
    sample: ProcessMemorySnapshot
): ProcessMemorySnapshot {
    return {
        rssBytes: Math.max(current.rssBytes, sample.rssBytes),
        unsafeFootprintBytes:
            current.unsafeFootprintBytes === null || sample.unsafeFootprintBytes === null
                ? null
                : Math.max(current.unsafeFootprintBytes, sample.unsafeFootprintBytes),
    };
}

/**
 * Samples process memory periodically while also allowing explicit checkpoints.
 * @param initial Warm-baseline sample.
 * @param intervalMs Fixed sampling interval.
 * @param readSnapshot Injectable synchronous reader for deterministic tests.
 * @returns A sampler whose stop operation returns the dimension-wise high-water mark.
 */
export function startProcessMemorySampler(
    initial: ProcessMemorySnapshot,
    intervalMs: number,
    readSnapshot: () => ProcessMemorySnapshot = readProcessMemorySnapshot
): ProcessMemorySampler {
    parseSchemaWithRangeError(processMemorySampleIntervalSchema, intervalMs);
    let failure: unknown;
    let peak = initial;
    let stopped = false;

    const takeSample = (): void => {
        if (stopped || failure !== undefined) return;
        try {
            peak = maximumProcessMemory(peak, readSnapshot());
        } catch (error) {
            failure = error;
            clearInterval(interval);
        }
    };
    const readPeak = (): ProcessMemorySnapshot => {
        if (failure !== undefined) {
            throw new Error("Process memory sampling failed", { cause: failure });
        }
        return peak;
    };

    const interval = setInterval(takeSample, intervalMs);

    return {
        sample(): ProcessMemorySnapshot {
            if (stopped) {
                throw new Error("Process memory sampler is already stopped");
            }
            takeSample();
            return readPeak();
        },
        stop(): ProcessMemorySnapshot {
            if (!stopped) {
                takeSample();
                stopped = true;
                clearInterval(interval);
            }
            return readPeak();
        },
    };
}
