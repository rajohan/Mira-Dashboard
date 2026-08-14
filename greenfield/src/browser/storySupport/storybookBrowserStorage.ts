/**
 * Clears browser-persistent state between stories in a reused test worker.
 * @returns Nothing after both storage areas are cleared, or throws every cleanup failure.
 */
export function resetStorybookBrowserStorage(): void {
    const failures: unknown[] = [];
    try {
        globalThis.localStorage.clear();
    } catch (error) {
        failures.push(error);
    }
    try {
        globalThis.sessionStorage.clear();
    } catch (error) {
        failures.push(error);
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, "Storybook browser storage cleanup failed");
    }
}

/**
 * Starts every story from empty browser-persistent state.
 * @returns Nothing after both storage areas are cleared.
 */
export function prepareStorybookBrowserStorage(): void {
    resetStorybookBrowserStorage();
}
