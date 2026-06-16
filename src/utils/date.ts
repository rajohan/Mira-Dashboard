/** Returns the current timestamp as an ISO string. */
export function currentIsoString(): string {
    const date = new Date();
    return date.toISOString();
}

/** Returns an ISO string for a timestamp-like value. */
export function isoStringFromDate(value: number | string | Date): string {
    const date = new Date(value);
    return date.toISOString();
}

/** Returns milliseconds for a date string, or null when invalid. */
export function timestampFromDateString(value: string): number | null {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

/** Returns the current calendar year. */
export function currentYear(): number {
    const date = new Date();
    return date.getFullYear();
}
