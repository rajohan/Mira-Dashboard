import type { CoalescedSnapshotMetrics } from "../../../contracts/metrics.ts";

interface CoalescedSnapshotOptions<T> {
    freshForMs: number;
    load: () => Promise<T>;
    name: string;
    now?: () => number;
    retryAfterMs?: number;
    staleForMs: number;
}

interface SnapshotEntry<T> {
    inFlight?: Promise<T>;
    lastFailure?: { error: unknown };
    loadedAt?: number;
    nextRetryAt?: number;
    value?: T;
}

interface MutableSnapshotMetrics {
    activeLoads: number;
    coalescedHits: number;
    failures: number;
    freshHits: number;
    lastLoadMs: number;
    loads: number;
    requests: number;
    staleHits: number;
    totalLoadMs: number;
}

const snapshotRegistry = new Map<
    string,
    {
        metrics: MutableSnapshotMetrics;
        name: string;
        reset: () => void;
    }
>();

function emptyMetrics(): MutableSnapshotMetrics {
    return {
        activeLoads: 0,
        coalescedHits: 0,
        failures: 0,
        freshHits: 0,
        lastLoadMs: 0,
        loads: 0,
        requests: 0,
        staleHits: 0,
        totalLoadMs: 0,
    };
}

function positiveDuration(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive finite number`);
    }
    return value;
}

/**
 * Shares one read-only producer across callers and keeps a bounded stale value
 * available while the next snapshot is refreshed.
 */
export class CoalescedSnapshot<T> {
    #entry: SnapshotEntry<T> = {};
    #metricsGeneration = 0;
    readonly #freshForMs: number;
    readonly #load: () => Promise<T>;
    readonly #metrics = emptyMetrics();
    readonly #name: string;
    readonly #now: () => number;
    readonly #retryAfterMs: number;
    readonly #staleForMs: number;

    constructor(options: CoalescedSnapshotOptions<T>) {
        const name = options.name.trim();
        if (!name) throw new TypeError("Snapshot name is required");
        this.#name = name;
        this.#freshForMs = positiveDuration(options.freshForMs, "freshForMs");
        this.#staleForMs = positiveDuration(options.staleForMs, "staleForMs");
        if (this.#staleForMs < this.#freshForMs) {
            throw new TypeError("staleForMs must be greater than or equal to freshForMs");
        }
        this.#retryAfterMs = positiveDuration(
            options.retryAfterMs ?? options.freshForMs,
            "retryAfterMs"
        );
        this.#load = options.load;
        this.#now = options.now ?? Date.now;
        snapshotRegistry.set(name, {
            metrics: this.#metrics,
            name,
            reset: () => this.reset(),
        });
    }

    #startLoad(entry: SnapshotEntry<T>): Promise<T> {
        const startedAt = this.#now();
        const metricsGeneration = this.#metricsGeneration;
        this.#metrics.activeLoads += 1;
        this.#metrics.loads += 1;

        const load = async () => {
            try {
                const value = await this.#load();
                if (this.#entry === entry) {
                    entry.lastFailure = undefined;
                    entry.loadedAt = this.#now();
                    entry.nextRetryAt = undefined;
                    entry.value = value;
                }
                return value;
            } catch (error) {
                if (this.#metricsGeneration === metricsGeneration) {
                    this.#metrics.failures += 1;
                }
                if (this.#entry === entry) {
                    entry.lastFailure = { error };
                    entry.nextRetryAt = this.#now() + this.#retryAfterMs;
                }
                throw error;
            }
        };
        const inFlight = load();
        entry.inFlight = inFlight;
        const recordSettlement = async () => {
            try {
                await inFlight;
            } catch {
                // The reader or background refresh handler observes the load error.
            } finally {
                const elapsedMs = Math.max(0, this.#now() - startedAt);
                if (this.#metricsGeneration === metricsGeneration) {
                    this.#metrics.activeLoads = Math.max(
                        0,
                        this.#metrics.activeLoads - 1
                    );
                    this.#metrics.lastLoadMs = elapsedMs;
                    this.#metrics.totalLoadMs += elapsedMs;
                }
                if (this.#entry === entry && entry.inFlight === inFlight) {
                    entry.inFlight = undefined;
                }
            }
        };
        void recordSettlement();
        return inFlight;
    }

    /** Returns the shared snapshot for this fixed read path. */
    async read(): Promise<T> {
        this.#metrics.requests += 1;
        const entry = this.#entry;
        const now = this.#now();
        const age =
            entry.value === undefined || entry.loadedAt === undefined
                ? Infinity
                : Math.max(0, now - entry.loadedAt);

        if (age <= this.#freshForMs && entry.value !== undefined) {
            this.#metrics.freshHits += 1;
            return entry.value;
        }

        if (age <= this.#staleForMs && entry.value !== undefined) {
            this.#metrics.staleHits += 1;
            if (entry.inFlight) {
                this.#metrics.coalescedHits += 1;
            } else if ((entry.nextRetryAt ?? 0) <= now) {
                const refresh = this.#startLoad(entry);
                void refresh.catch((error: unknown) => {
                    console.warn(
                        `[PollingSnapshot:${this.#name}] Background refresh failed`,
                        error
                    );
                });
            }
            return entry.value;
        }

        if (entry.inFlight) {
            this.#metrics.coalescedHits += 1;
            return await entry.inFlight;
        }

        if ((entry.nextRetryAt ?? 0) > now && entry.lastFailure) {
            throw entry.lastFailure.error;
        }

        return await this.#startLoad(entry);
    }

    /** Invalidates the visible value and detaches any older in-flight producer. */
    invalidate(): void {
        this.#entry = {};
    }

    /** Clears cached values and counters. Intended for deterministic tests. */
    reset(): void {
        this.invalidate();
        this.#metricsGeneration += 1;
        Object.assign(this.#metrics, emptyMetrics());
    }
}

/** Returns process-local coalescing telemetry without cached payloads or keys. */
export function getCoalescedSnapshotMetrics(): CoalescedSnapshotMetrics[] {
    return snapshotRegistry
        .values()
        .map(({ metrics, name }) => ({
            activeLoads: metrics.activeLoads,
            averageLoadMs:
                metrics.loads === 0
                    ? 0
                    : Math.round((metrics.totalLoadMs / metrics.loads) * 100) / 100,
            coalescedHits: metrics.coalescedHits,
            failures: metrics.failures,
            freshHits: metrics.freshHits,
            lastLoadMs: metrics.lastLoadMs,
            loads: metrics.loads,
            name,
            requests: metrics.requests,
            staleHits: metrics.staleHits,
        }))
        .toArray()
        .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Resets every registered snapshot between tests. */
export function resetCoalescedSnapshotsForTests(): void {
    for (const snapshot of snapshotRegistry.values()) snapshot.reset();
}
