import * as v from "valibot";

import { type SystemMetrics, systemMetricsSchema } from "../../../contracts/system.ts";
import {
    createSystemMetricsSampler,
    type SystemMetricsSampler,
} from "./systemMetricsCollector.ts";

/** Maximum age of a successful sample returned after a refresh failure. */
export const systemMetricsLastKnownGoodMs = 30_000;

/** Expected operational failure after no eligible metrics snapshot remains. */
export class SystemMetricsUnavailableError extends Error {
    public constructor(cause?: unknown) {
        super("System metrics are unavailable", { cause });
        this.name = "SystemMetricsUnavailableError";
    }
}

/** Request-safe process service for one coalesced demand-driven metrics snapshot. */
export interface SystemMetricsRuntimeService {
    read(): Promise<SystemMetrics>;
}

export interface SystemMetricsRuntimeServiceOptions {
    readonly nowMs?: () => number;
    readonly sample?: SystemMetricsSampler;
    readonly staleForMs?: number;
}

function validClockValue(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("System metrics clock is outside the safe integer range");
    }
    return value;
}

/**
 * Creates a single-flight metrics service with a bounded last-known-good window.
 * Successful reads always attempt a new sample; callers arriving together share it.
 * @param options Injectable sampler, clock, and stale window.
 * @returns One immutable request-safe metrics port.
 */
export function createSystemMetricsRuntimeService(
    options: SystemMetricsRuntimeServiceOptions = {}
): SystemMetricsRuntimeService {
    const nowMs = options.nowMs ?? Date.now;
    const sample = options.sample ?? createSystemMetricsSampler();
    const staleForMs = options.staleForMs ?? systemMetricsLastKnownGoodMs;
    if (!Number.isSafeInteger(staleForMs) || staleForMs < 0) {
        throw new RangeError("System metrics stale window is invalid");
    }

    let inFlight: Promise<SystemMetrics> | undefined;
    let lastKnownGood: SystemMetrics | undefined;

    const load = async (): Promise<SystemMetrics> => {
        try {
            const fresh = v.parse(systemMetricsSchema, await sample());
            if (fresh.freshness !== "fresh") {
                throw new TypeError("System metrics sampler returned a stale snapshot");
            }
            lastKnownGood = fresh;
            return fresh;
        } catch (error) {
            try {
                if (lastKnownGood !== undefined) {
                    const now = validClockValue(nowMs);
                    const ageMs = now - lastKnownGood.sampledAtMs;
                    if (ageMs >= 0 && ageMs <= staleForMs) {
                        return v.parse(systemMetricsSchema, {
                            ...lastKnownGood,
                            freshness: "stale",
                        });
                    }
                }
            } catch {
                throw new SystemMetricsUnavailableError(error);
            }
            throw new SystemMetricsUnavailableError(error);
        }
    };

    return Object.freeze({
        read() {
            if (inFlight !== undefined) return inFlight;
            const current = load();
            inFlight = current;
            const clear = () => {
                if (inFlight === current) inFlight = undefined;
            };
            void current.then(clear, clear);
            return current;
        },
    });
}
