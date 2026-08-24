/**
 * Awaits one expected rejected promise without relying on matcher-specific thenables.
 * @param promise Operation that must reject with an Error.
 * @returns The observed Error after the operation has settled.
 */
export async function rejectionError(promise: PromiseLike<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof Error) return error;
        throw new Error("Expected the promise to reject with an Error", {
            cause: error,
        });
    }
    throw new Error("Expected the promise to reject");
}
