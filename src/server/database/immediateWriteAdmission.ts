/** Marks the exact point at which SQLite has admitted an immediate transaction. */
export type MarkDatabaseTransactionStarted = () => void;

/**
 * Process-owned asynchronous admission for synchronous SQLite write transactions.
 * Implementations may retry only before `markTransactionStarted` has been called.
 */
export interface ImmediateDatabaseWriteAdmission {
    run<T>(
        operation: (markTransactionStarted: MarkDatabaseTransactionStarted) => T
    ): Promise<T>;
}
