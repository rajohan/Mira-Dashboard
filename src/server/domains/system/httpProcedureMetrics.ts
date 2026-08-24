import * as v from "valibot";

import {
    type SystemApplicationMetrics,
    systemApplicationMetricsSchema,
    systemHttpMetricOverflowProcedure,
    systemHttpMetricProcedureNames,
} from "../../../contracts/system.ts";

type SystemHttpMetrics = SystemApplicationMetrics["http"];
type SystemHttpMetricProcedure = SystemHttpMetrics["procedures"][number]["procedure"];

export interface SystemHttpProcedureMetricObservation {
    readonly durationMs: number;
    readonly procedures: readonly string[];
    readonly status: number;
}

export interface SystemHttpProcedureMetrics {
    record(observation: SystemHttpProcedureMetricObservation): void;
    snapshot(): SystemHttpMetrics;
}

interface MutableSystemHttpMetricRow {
    errorCount: number;
    maximumDurationMs: number;
    readonly procedure: SystemHttpMetricProcedure;
    requestCount: number;
    totalDurationMs: number;
}

const fixedProcedures = new Set<string>(systemHttpMetricProcedureNames);
const expectedProcedures = [
    ...systemHttpMetricProcedureNames,
    systemHttpMetricOverflowProcedure,
] as const;

function boundedIncrement(value: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function boundedDuration(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

/**
 * Extracts decoded tRPC procedure names without retaining arbitrary URL text.
 * @param url Parsed request URL.
 * @returns Unique decoded procedure names, or the fixed overflow bucket on malformed input.
 */
export function systemHttpMetricProceduresFromUrl(url: URL): readonly string[] {
    const prefix = "/trpc/";
    if (!url.pathname.startsWith(prefix)) return [];
    try {
        const encoded = url.pathname.slice(prefix.length);
        const decoded = decodeURIComponent(encoded);
        const candidates =
            url.searchParams.get("batch") === "1" ? decoded.split(",") : [decoded];
        return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
    } catch {
        return [systemHttpMetricOverflowProcedure];
    }
}

/**
 * Creates process-local bounded counters for a fixed procedure allowlist plus overflow.
 * @returns Bounded recorder and immutable snapshot reader.
 */
export function createSystemHttpProcedureMetrics(): SystemHttpProcedureMetrics {
    const rows = new Map<SystemHttpMetricProcedure, MutableSystemHttpMetricRow>(
        expectedProcedures.map((procedure) => [
            procedure,
            {
                errorCount: 0,
                maximumDurationMs: 0,
                procedure,
                requestCount: 0,
                totalDurationMs: 0,
            },
        ])
    );
    return Object.freeze({
        record(observation: SystemHttpProcedureMetricObservation) {
            const durationMs = boundedDuration(observation.durationMs);
            const buckets = new Set<SystemHttpMetricProcedure>();
            for (const procedure of observation.procedures) {
                buckets.add(
                    fixedProcedures.has(procedure)
                        ? (procedure as SystemHttpMetricProcedure)
                        : systemHttpMetricOverflowProcedure
                );
            }
            for (const bucket of buckets) {
                const row = rows.get(bucket)!;
                row.requestCount = boundedIncrement(row.requestCount);
                if (observation.status >= 400) {
                    row.errorCount = boundedIncrement(row.errorCount);
                }
                row.maximumDurationMs = Math.max(row.maximumDurationMs, durationMs);
                row.totalDurationMs = Math.min(
                    Number.MAX_SAFE_INTEGER,
                    row.totalDurationMs + durationMs
                );
            }
        },
        snapshot() {
            return v.parse(systemApplicationMetricsSchema.entries.http, {
                procedures: expectedProcedures.map((procedure) => ({
                    ...rows.get(procedure)!,
                })),
                state: "observed",
            });
        },
    });
}
