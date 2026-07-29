import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface LogCorrelationContext {
    jobId?: string;
    requestId?: string;
    sessionId?: string;
}

const logContextStorage = new AsyncLocalStorage<LogCorrelationContext>();

/**
 * Runs work with additive correlation fields available to structured logs.
 * @returns Run with log context result.
 */
export function runWithLogContext<T>(
    context: LogCorrelationContext,
    operation: () => T
): T {
    return logContextStorage.run(
        { ...logContextStorage.getStore(), ...context },
        operation
    );
}

export function currentLogContext(): LogCorrelationContext | undefined {
    return logContextStorage.getStore();
}

/**
 * Produces a stable, non-reversible correlation value for sensitive identifiers.
 * @param namespace Namespace value.
 * @param value Value to process.
 * @returns Hashed log correlation result.
 */
export function hashedLogCorrelation(namespace: string, value: string): string {
    return createHash("sha256")
        .update(namespace)
        .update("\0")
        .update(value)
        .digest("hex")
        .slice(0, 16);
}
