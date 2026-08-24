import * as v from "valibot";

import {
    type SystemApplicationMetrics,
    type SystemHostMetrics,
    type SystemMetrics,
    systemApplicationMetricsSchema,
    systemHostMetricsSchema,
    systemMetricsSchema,
} from "../../../contracts/system.ts";
import type { SystemApplicationMetricsReader } from "./applicationMetricsCollector.ts";
import {
    createSystemHttpProcedureMetrics,
    type SystemHttpProcedureMetricObservation,
    type SystemHttpProcedureMetrics,
} from "./httpProcedureMetrics.ts";
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
    /** One-time composition hook; request code receives no provider-specific readers. */
    configureApplicationReader?(reader: SystemApplicationMetricsReader): void;
    recordHttpRequest?(observation: SystemHttpProcedureMetricObservation): void;
    read(): Promise<SystemMetrics>;
}

export interface SystemMetricsRuntimeServiceOptions {
    readonly applicationReader?: SystemApplicationMetricsReader;
    readonly httpMetrics?: SystemHttpProcedureMetrics;
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

function unavailableApplicationMetrics(): Omit<SystemApplicationMetrics, "http"> {
    return {
        cache: { state: "unavailable" },
        chat: { state: "unavailable" },
        gateway: { state: "unavailable" },
        jobs: { state: "unavailable" },
        operations: { state: "unavailable" },
        realtime: { state: "unavailable" },
        sqlite: { state: "unavailable" },
        web: { state: "unavailable" },
    };
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
    let applicationReader = options.applicationReader;
    let applicationReaderConfigured = applicationReader !== undefined;
    const httpMetrics = options.httpMetrics ?? createSystemHttpProcedureMetrics();

    const readApplication = async (): Promise<unknown> => {
        if (applicationReader === undefined) return unavailableApplicationMetrics();
        try {
            return await applicationReader();
        } catch {
            return unavailableApplicationMetrics();
        }
    };

    const safeHttpSnapshot = (): SystemApplicationMetrics["http"] => {
        try {
            return v.parse(
                systemApplicationMetricsSchema.entries.http,
                httpMetrics.snapshot()
            );
        } catch {
            return createSystemHttpProcedureMetrics().snapshot();
        }
    };

    const applicationComponentNames = [
        "cache",
        "chat",
        "gateway",
        "jobs",
        "operations",
        "realtime",
        "sqlite",
        "web",
    ] as const;

    function containInvalidApplicationComponents(
        host: SystemHostMetrics,
        candidate: unknown
    ): SystemApplicationMetrics {
        const candidateRecord =
            typeof candidate === "object" && candidate !== null
                ? (candidate as Readonly<Record<string, unknown>>)
                : {};
        let application: SystemApplicationMetrics = {
            ...unavailableApplicationMetrics(),
            http: safeHttpSnapshot(),
        };
        for (const component of applicationComponentNames) {
            const nextApplication = {
                ...application,
                [component]: candidateRecord[component],
            };
            const parsed = v.safeParse(systemMetricsSchema, {
                ...host,
                application: nextApplication,
            });
            if (parsed.success) {
                application = parsed.output.application;
            }
        }
        return application;
    }

    const load = async (): Promise<SystemMetrics> => {
        try {
            const [application, hostCandidate] = await Promise.all([
                readApplication(),
                sample(),
            ]);
            const host = v.parse(systemHostMetricsSchema, hostCandidate);
            if (host.freshness !== "fresh") {
                throw new TypeError("System metrics sampler returned a stale snapshot");
            }
            const fresh = v.parse(systemMetricsSchema, {
                ...host,
                application: containInvalidApplicationComponents(host, application),
            });
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
        configureApplicationReader(reader: SystemApplicationMetricsReader) {
            if (applicationReaderConfigured) {
                throw new Error(
                    "System application metrics reader is already configured"
                );
            }
            applicationReader = reader;
            applicationReaderConfigured = true;
        },
        recordHttpRequest(observation: SystemHttpProcedureMetricObservation) {
            httpMetrics.record(observation);
        },
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
