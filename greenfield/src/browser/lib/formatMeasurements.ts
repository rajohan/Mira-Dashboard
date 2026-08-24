const binaryByteUnits = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
const bitRateUnits = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s", "Tbit/s"] as const;

function compactDecimal(value: number, maximumDigits: number): string {
    return value
        .toFixed(maximumDigits)
        .replace(/\.0+$/u, "")
        .replace(/(?<decimal>\.\d*?)0+$/u, "$<decimal>");
}

/**
 * @param bytes - Validated nonnegative byte count.
 * @returns Compact binary byte capacity.
 */
export function formatByteCount(bytes: number): string {
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < binaryByteUnits.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${binaryByteUnits[unitIndex]}`;
}

/**
 * @param bitsPerSecond - Validated nonnegative bit rate.
 * @returns Compact decimal bit rate.
 */
export function formatBitsPerSecond(bitsPerSecond: number): string {
    let value = bitsPerSecond;
    let unitIndex = 0;
    while (value >= 1000 && unitIndex < bitRateUnits.length - 1) {
        value /= 1000;
        unitIndex += 1;
    }
    let digits = 2;
    if (value >= 100) digits = 0;
    else if (value >= 10) digits = 1;
    return `${compactDecimal(value, digits)} ${bitRateUnits[unitIndex]}`;
}

/**
 * @param percent - Validated percentage.
 * @returns Stable compact percentage retaining at most one decimal.
 */
export function formatPercent(percent: number): string {
    return `${compactDecimal(percent, 1)}%`;
}

/**
 * @param load - Validated load value.
 * @returns Stable compact load value retaining at most two decimals.
 */
export function formatLoadValue(load: number): string {
    return compactDecimal(load, 2);
}

/**
 * @param seconds - Validated nonnegative uptime in seconds.
 * @returns Human-readable bounded uptime without wall-clock dependence.
 */
export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
