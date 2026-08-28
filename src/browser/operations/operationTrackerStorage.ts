import type { TrackedOperation } from "./operationTrackerContextValue.ts";

const storedOperationMaximum = 64;
const trackedOperationStorageKey = "mira-dashboard:operations:v1";
export const trackedOperationsClearedEvent = "mira-dashboard:operations-cleared";

interface StoredOperation {
    readonly jobRunId: string;
    readonly label: string;
    readonly operationKey?: string;
    readonly terminal: boolean;
}

/** Clears persisted operation state across an authentication boundary. */
export function clearTrackedOperations(): void {
    try {
        globalThis.sessionStorage.removeItem(trackedOperationStorageKey);
    } catch {
        // Browser storage may be unavailable; mounted state is still cleared below.
    }
    if (
        typeof globalThis.dispatchEvent === "function" &&
        typeof globalThis.Event === "function"
    ) {
        globalThis.dispatchEvent(new Event(trackedOperationsClearedEvent));
    }
}

export function readStoredOperations(): readonly TrackedOperation[] {
    try {
        const value = JSON.parse(
            globalThis.sessionStorage.getItem(trackedOperationStorageKey) ?? "[]"
        ) as unknown;
        if (!Array.isArray(value) || value.length > storedOperationMaximum) return [];
        return value.flatMap((candidate): readonly TrackedOperation[] => {
            if (candidate === null || typeof candidate !== "object") return [];
            const operation = candidate as Partial<StoredOperation>;
            if (
                typeof operation.jobRunId !== "string" ||
                operation.jobRunId.length > 128 ||
                typeof operation.label !== "string" ||
                operation.label.length === 0 ||
                operation.label.length > 200 ||
                typeof operation.terminal !== "boolean" ||
                (operation.operationKey !== undefined &&
                    (typeof operation.operationKey !== "string" ||
                        operation.operationKey.length === 0 ||
                        operation.operationKey.length > 160))
            ) {
                return [];
            }
            return [
                {
                    jobRunId: operation.jobRunId,
                    label: operation.label,
                    ...(operation.operationKey === undefined
                        ? {}
                        : { operationKey: operation.operationKey }),
                    terminal: operation.terminal,
                },
            ];
        });
    } catch {
        return [];
    }
}

export function storeOperations(operations: readonly TrackedOperation[]): void {
    try {
        globalThis.sessionStorage.setItem(
            trackedOperationStorageKey,
            JSON.stringify(
                operations.map(({ jobRunId, label, operationKey, terminal }) => ({
                    jobRunId,
                    label,
                    ...(operationKey === undefined ? {} : { operationKey }),
                    terminal,
                }))
            )
        );
    } catch {
        // Job detail remains authoritative when browser storage is unavailable.
    }
}
