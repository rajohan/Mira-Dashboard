/** Named refresh tiers shared by recurring read-only UI queries. */
export const refreshPolicy = {
    active: 5000,
    background: 30_000,
    live: 2000,
    static: 60_000,
} as const;

/**
 * Returns whether browser-driven polling or reconnect work should run now.
 * @returns Whether browser-driven polling or reconnect work should run now.
 */
export function isBrowserPollingAllowed(): boolean {
    const isVisible =
        typeof document === "undefined" || document.visibilityState !== "hidden";
    const isOnline = typeof navigator === "undefined" || navigator.onLine;
    return isVisible && isOnline;
}
