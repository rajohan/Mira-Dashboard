import type {
    ImmediateDatabaseWriteAdmission,
    MarkDatabaseTransactionStarted,
} from "../../database/immediateWriteAdmission.ts";

/** Immediate asynchronous admission used only by isolated single-connection tests. */
export const testImmediateDatabaseWriteAdmission: ImmediateDatabaseWriteAdmission =
    Object.freeze({
        run<T>(
            operation: (markTransactionStarted: MarkDatabaseTransactionStarted) => T
        ): Promise<T> {
            return Promise.resolve().then(() => operation(() => {}));
        },
    });

/**
 * Bound adapter for runtime-shaped test doubles that need immediate-write admission.
 * @param operation Synchronous transaction callback under test.
 * @returns The callback result through the asynchronous admission boundary.
 */
export function runTestImmediateDatabaseWrite<T>(
    operation: (markTransactionStarted: MarkDatabaseTransactionStarted) => T
): Promise<T> {
    return testImmediateDatabaseWriteAdmission.run(operation);
}
