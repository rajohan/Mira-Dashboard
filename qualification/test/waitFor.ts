/**
 * Polls a synchronous predicate until it succeeds or the deadline expires.
 * @param predicate Condition to wait for.
 * @param timeoutMs Maximum wait duration.
 * @returns A promise that resolves once the predicate succeeds.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
        if (performance.now() >= deadline) {
            throw new Error(`Condition was not met within ${timeoutMs} ms`);
        }
        await Bun.sleep(10);
    }
}
