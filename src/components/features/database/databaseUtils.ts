/** Formats number for display. */
export function formatNumber(n: number): string {
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
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Performs truncate query. */
export function truncateQuery(query: string, max = 180) {
    if (query.length <= max) {
        return query;
    }
    return `${query.slice(0, max)}...`;
}
