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
