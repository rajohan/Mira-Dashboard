/**
 * Awaits an operation and returns its rejection for explicit assertions.
 * @param operation Asynchronous operation expected to reject.
 * @returns Captured rejection.
 */
export async function captureRejection(
    operation: () => Promise<unknown>
): Promise<unknown> {
    try {
        await operation();
    } catch (error) {
        return error;
    }
    throw new Error("Expected operation to reject");
}
