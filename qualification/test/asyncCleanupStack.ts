/** One asynchronous cleanup registered by a qualification test. */
interface AsyncCleanupOperation {
    label: string;
    operation: () => Promise<void> | void;
}

async function completeBeforeDeadline(
    cleanup: AsyncCleanupOperation,
    timeoutMs: number
): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
            () =>
                reject(new Error(`${cleanup.label} did not stop within ${timeoutMs} ms`)),
            timeoutMs
        );
    });

    try {
        await Promise.race([Promise.resolve().then(() => cleanup.operation()), deadline]);
    } finally {
        clearTimeout(timeout);
    }
}

/** Failure-safe last-in-first-out cleanup for qualification resources. */
export class AsyncCleanupStack {
    readonly #operations: AsyncCleanupOperation[] = [];

    /**
     * Registers a resource cleanup immediately after acquisition.
     * @param label Diagnostic resource label.
     * @param operation Cleanup callback.
     */
    defer(label: string, operation: () => Promise<void> | void): void {
        this.#operations.push({ label, operation });
    }

    /** Runs every registered cleanup even when an earlier cleanup fails. */
    async dispose(): Promise<void> {
        const failures: unknown[] = [];

        for (const cleanup of this.#operations.splice(0).toReversed()) {
            try {
                await completeBeforeDeadline(cleanup, 2000);
            } catch (error) {
                failures.push(error);
            }
        }

        if (failures.length > 0) {
            throw new AggregateError(failures, "Qualification resource cleanup failed");
        }
    }
}
