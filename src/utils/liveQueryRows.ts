/** Returns live query rows defensively. */
export function liveQueryRows<T>(value: T[] | unknown): T[] {
    return Array.isArray(value) ? value : [];
}
