import type { HttpRequestMetrics, HttpRouteMetrics } from "../../../contracts/metrics.ts";

interface MutableHttpRouteMetrics {
    errors: number;
    maxDurationMs: number;
    method: string;
    requests: number;
    route: string;
    statusCodes: Record<string, number>;
    totalDurationMs: number;
}

interface RecordHttpRequestMetric {
    durationMs: number;
    method: string;
    route: string;
    status: number;
}

const MAX_ROUTE_SERIES = 512;
const OVERFLOW_KEY = "OTHER *";
const routeMetrics = new Map<string, MutableHttpRouteMetrics>();

function roundedDuration(value: number): number {
    return Math.round(value * 100) / 100;
}

function newRouteMetrics(method: string, route: string): MutableHttpRouteMetrics {
    return {
        errors: 0,
        maxDurationMs: 0,
        method,
        requests: 0,
        route,
        statusCodes: Object.create(null) as Record<string, number>,
        totalDurationMs: 0,
    };
}

/** Records one completed request against its registered route pattern. */
export function recordHttpRequestMetric(metric: RecordHttpRequestMetric): void {
    const method = metric.method.trim().toUpperCase() || "UNKNOWN";
    const route = metric.route.trim() || "unknown";
    const requestedKey = `${method} ${route}`;
    const key =
        routeMetrics.has(requestedKey) || routeMetrics.size < MAX_ROUTE_SERIES
            ? requestedKey
            : OVERFLOW_KEY;
    const entry =
        routeMetrics.get(key) ??
        newRouteMetrics(
            key === OVERFLOW_KEY ? "OTHER" : method,
            key === OVERFLOW_KEY ? "*" : route
        );
    routeMetrics.set(key, entry);

    const durationMs = Number.isFinite(metric.durationMs)
        ? Math.max(0, metric.durationMs)
        : 0;
    const status = Number.isSafeInteger(metric.status) ? metric.status : 500;
    const statusKey = String(status);
    entry.requests += 1;
    entry.errors += status >= 400 ? 1 : 0;
    entry.totalDurationMs += durationMs;
    entry.maxDurationMs = Math.max(entry.maxDurationMs, durationMs);
    entry.statusCodes[statusKey] = (entry.statusCodes[statusKey] ?? 0) + 1;
}

/**
 * Returns low-cardinality route-pattern telemetry without URLs or payloads.
 * @returns low-cardinality route-pattern telemetry without URLs or payloads.
 */
export function getHttpRequestMetrics(): HttpRequestMetrics {
    let requests = 0;
    let errors = 0;
    let totalDurationMs = 0;
    let maxDurationMs = 0;
    const routes: HttpRouteMetrics[] = routeMetrics
        .values()
        .map((entry) => {
            requests += entry.requests;
            errors += entry.errors;
            totalDurationMs += entry.totalDurationMs;
            maxDurationMs = Math.max(maxDurationMs, entry.maxDurationMs);
            return {
                averageDurationMs:
                    entry.requests === 0
                        ? 0
                        : roundedDuration(entry.totalDurationMs / entry.requests),
                errors: entry.errors,
                maxDurationMs: roundedDuration(entry.maxDurationMs),
                method: entry.method,
                requests: entry.requests,
                route: entry.route,
                statusCodes: { ...entry.statusCodes },
            };
        })
        .toArray()
        .toSorted(
            (left, right) =>
                left.route.localeCompare(right.route) ||
                left.method.localeCompare(right.method)
        );

    return {
        averageDurationMs:
            requests === 0 ? 0 : roundedDuration(totalDurationMs / requests),
        errors,
        maxDurationMs: roundedDuration(maxDurationMs),
        requests,
        routes,
    };
}

/** Clears process-local counters between deterministic tests. */
export function resetHttpRequestMetrics(): void {
    routeMetrics.clear();
}
