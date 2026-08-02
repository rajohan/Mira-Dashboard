import type {
    ChatPersistenceMetrics,
    ChatReplayMetrics,
    ChatRuntimeMetrics,
} from "../../../../contracts/metrics.ts";

const WRITE_RATE_WINDOW_MS = 60_000;
const MAX_WRITE_RATE_SAMPLES = 10_000;

interface OpenClawChatReplayGauge {
    currentBytes: number;
    events: number;
    maxBytes: number;
    runs: number;
    sessions: number;
}

function safeTimestamp(now: () => number): number {
    try {
        const timestamp = now();
        return Number.isFinite(timestamp) ? timestamp : Date.now();
    } catch {
        return Date.now();
    }
}

/** Records process-local replay and snapshot-store behavior without chat content. */
export class OpenClawChatRuntimeMetricsRecorder {
    readonly #now: () => number;
    readonly #writeTimestamps: number[] = [];
    #memoryEvictions = 0;
    #peakBytes = 0;
    #sessionEvictions = 0;
    #writeAttempts = 0;
    #writeFailures = 0;
    #writes = 0;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    #pruneWriteTimestamps(now: number): void {
        const cutoff = now - WRITE_RATE_WINDOW_MS;
        const firstRetainedIndex = this.#writeTimestamps.findIndex(
            (timestamp) => timestamp >= cutoff
        );
        if (firstRetainedIndex === -1) {
            this.#writeTimestamps.length = 0;
        } else if (firstRetainedIndex > 0) {
            this.#writeTimestamps.splice(0, firstRetainedIndex);
        }
        if (this.#writeTimestamps.length > MAX_WRITE_RATE_SAMPLES) {
            this.#writeTimestamps.splice(
                0,
                this.#writeTimestamps.length - MAX_WRITE_RATE_SAMPLES
            );
        }
    }

    /**
     * Samples replay bytes before and after retention enforcement.
     * @param currentBytes Current serialized replay bytes.
     */
    observeReplayBytes(currentBytes: number): void {
        this.#peakBytes = Math.max(this.#peakBytes, currentBytes);
    }

    /**
     * Counts a limit-driven process-memory eviction.
     * @param reason Limit that triggered the eviction.
     */
    recordEviction(reason: "memory" | "session"): void {
        if (reason === "memory") {
            this.#memoryEvictions += 1;
        } else {
            this.#sessionEvictions += 1;
        }
    }

    /**
     * Records one attempted mutating snapshot-store call.
     * @param succeeded Whether the store mutation completed.
     */
    recordPersistenceWrite(succeeded: boolean): void {
        this.#writeAttempts += 1;
        if (!succeeded) {
            this.#writeFailures += 1;
            return;
        }
        this.#writes += 1;
        const now = safeTimestamp(this.#now);
        this.#writeTimestamps.push(now);
        this.#pruneWriteTimestamps(now);
    }

    /**
     * Returns bounded replay and write-rate metrics for the authenticated API.
     * @param replay Current process-local replay gauges.
     * @returns Replay and persistence metrics.
     */
    snapshot(
        replay: OpenClawChatReplayGauge
    ): Pick<ChatRuntimeMetrics, "persistence" | "replay"> {
        const now = safeTimestamp(this.#now);
        this.#pruneWriteTimestamps(now);
        const persistence: ChatPersistenceMetrics = {
            writeAttempts: this.#writeAttempts,
            writeFailures: this.#writeFailures,
            writes: this.#writes,
            writesPerMinute: this.#writeTimestamps.length,
        };
        const replayMetrics: ChatReplayMetrics = {
            ...replay,
            memoryEvictions: this.#memoryEvictions,
            peakBytes: Math.max(this.#peakBytes, replay.currentBytes),
            sessionEvictions: this.#sessionEvictions,
        };
        return { persistence, replay: replayMetrics };
    }
}
