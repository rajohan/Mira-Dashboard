/**
 * Captures one expected Promise rejection for direct identity assertions in tests.
 * @param work Asynchronous operation expected to reject.
 * @returns The captured rejection reason.
 */
export async function captureFailure(work: () => PromiseLike<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected asynchronous operation to fail");
}

/**
 * Creates a pending promise that rejects with an abort signal's reason.
 * @param signal Cancellation signal owned by the operation under test.
 * @param message Fallback error message when the signal has no Error reason.
 * @returns Promise that rejects immediately or when the signal aborts.
 */
export function rejectOnAbort<TResult = never>(
    signal: AbortSignal,
    message: string
): Promise<TResult> {
    return new Promise<TResult>((_resolve, reject) => {
        const rejectWithAbortReason = (): void => {
            const reason: unknown = signal.reason;
            reject(
                reason instanceof Error ? reason : new Error(message, { cause: reason })
            );
        };
        if (signal.aborted) {
            rejectWithAbortReason();
            return;
        }
        signal.addEventListener("abort", rejectWithAbortReason, { once: true });
    });
}

/**
 * Bounds an asynchronous test operation and clears its timer after settlement.
 * @param operation Promise under test.
 * @param timeoutMs Maximum wait in milliseconds.
 * @param message Targeted failure message when the deadline wins.
 * @returns The operation result.
 */
export async function withTestTimeout<TResult>(
    operation: PromiseLike<TResult>,
    timeoutMs: number,
    message: string
): Promise<TResult> {
    const deadline = Promise.withResolvers<never>();
    const timeout = setTimeout(() => deadline.reject(new Error(message)), timeoutMs);
    try {
        return await Promise.race([Promise.resolve(operation), deadline.promise]);
    } finally {
        clearTimeout(timeout);
    }
}
