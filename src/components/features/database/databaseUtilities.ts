import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";

/** Formats number for display. */
export function formatNumber(n: number): string {
    if (!Number.isFinite(n)) {
        return "0";
    }

    return n.toLocaleString("en-US");
}

/** Formats bytes for display. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 || value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Performs truncate query. */
export function truncateQuery(query: string, max = 180) {
    if (query.length <= max) {
        return query;
    }
    return `${query.slice(0, max)}...`;
}

type PostgresMaintenance = NonNullable<
    DatabaseOverviewResponse["overview"]["maintenance"]
>;

/** Returns actionable PostgreSQL maintenance reasons from the shared thresholds. */
export function postgresMaintenanceAttention(
    maintenance: PostgresMaintenance | undefined
): string[] {
    if (!maintenance) {
        return [];
    }

    const reasons: string[] = [];
    if (maintenance.requiresBloatReview) {
        reasons.push(
            `PostgreSQL may reclaim ~${formatBytes(maintenance.estimatedReclaimableBytes)} (${maintenance.estimatedReclaimablePercent.toFixed(1)}%). Review table bloat and compaction options`
        );
    }
    if (maintenance.highDeadTupleTableCount > 0) {
        reasons.push(
            `${formatNumber(maintenance.highDeadTupleTableCount)} large ${
                maintenance.highDeadTupleTableCount === 1
                    ? "table exceeds"
                    : "tables exceed"
            } the dead-tuple threshold. Review autovacuum`
        );
    }
    if (maintenance.slowQueryCount > 0) {
        reasons.push(
            `${formatNumber(maintenance.slowQueryCount)} ${
                maintenance.slowQueryCount === 1 ? "query averages" : "queries average"
            } at least 500 ms. Review query performance`
        );
    }
    if (maintenance.isBloatAssessmentIncomplete) {
        reasons.push(
            `Bloat could not be assessed for ${formatBytes(
                maintenance.unassessedPhysicalBytes
            )} across ${formatNumber(maintenance.unassessedTableCount)} ${
                maintenance.unassessedTableCount === 1 ? "table" : "tables"
            }`
        );
    }
    return reasons;
}
