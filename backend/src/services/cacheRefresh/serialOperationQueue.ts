/** Serializes heavyweight operations while allowing failures to release the queue. */
export class SerialOperationQueue {
    private tail: Promise<void> = Promise.resolve();

    private async observe(result: Promise<unknown>): Promise<void> {
        try {
            await result;
        } catch {
            // A failed operation must not block later queue entries.
        }
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        const result = (async () => {
            await previous;
            return operation();
        })();
        this.tail = this.observe(result);
        return result;
    }
}
