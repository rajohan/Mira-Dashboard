import type { TrackedOperation } from "./operationTrackerContextValue.ts";

const storedOperationMaximum = 64;
const trackedOperationStorageKey = "mira-dashboard:operations:v2";
export const trackedOperationsStorageChangedEvent =
    "mira-dashboard:operations-storage-changed";

interface StoredOperation {
    readonly jobRunId: string;
    readonly label: string;
    readonly operationKey?: string;
    readonly terminal: boolean;
}

interface StoredOperationState {
    readonly authenticationIdentity?: string;
    readonly operations: readonly StoredOperation[];
}

function readStoredState(): StoredOperationState | undefined {
    try {
        const value = JSON.parse(
            globalThis.sessionStorage.getItem(trackedOperationStorageKey) ?? "null"
        ) as unknown;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return undefined;
        }
        const state = value as Partial<StoredOperationState>;
        if (
            !Array.isArray(state.operations) ||
            state.operations.length > storedOperationMaximum ||
            (state.authenticationIdentity !== undefined &&
                (typeof state.authenticationIdentity !== "string" ||
                    state.authenticationIdentity.length === 0 ||
                    state.authenticationIdentity.length > 256))
        ) {
            return undefined;
        }
        return state as StoredOperationState;
    } catch {
        return undefined;
    }
}

function dispatchTrackedOperationsStorageChanged(): void {
    if (
        typeof globalThis.dispatchEvent === "function" &&
        typeof globalThis.Event === "function"
    ) {
        globalThis.dispatchEvent(new Event(trackedOperationsStorageChangedEvent));
    }
}

/** Clears persisted operation state across an authentication boundary. */
export function clearTrackedOperations(): void {
    try {
        globalThis.sessionStorage.removeItem(trackedOperationStorageKey);
    } catch {
        // Browser storage may be unavailable; mounted state is still cleared below.
    }
    dispatchTrackedOperationsStorageChanged();
}

/**
 * Claims restored operations for the first resolved identity and clears on a real change.
 * @param authenticationIdentity Stable authenticated browser cache identity.
 */
export function reconcileTrackedOperationsIdentity(authenticationIdentity: string): void {
    const state = readStoredState();
    if (state?.authenticationIdentity === authenticationIdentity) {
        dispatchTrackedOperationsStorageChanged();
        return;
    }
    const storedOperationsExist = (state?.operations.length ?? 0) > 0;
    try {
        globalThis.sessionStorage.setItem(
            trackedOperationStorageKey,
            JSON.stringify({
                authenticationIdentity,
                operations: [],
            } satisfies StoredOperationState)
        );
    } catch {
        // Mounted state is still cleared below when identities actually differ.
    }
    if (state?.authenticationIdentity !== undefined || storedOperationsExist) {
        dispatchTrackedOperationsStorageChanged();
    }
}

export function readStoredOperations(): readonly TrackedOperation[] {
    try {
        const state = readStoredState();
        if (state === undefined) return [];
        return state.operations.flatMap((candidate): readonly TrackedOperation[] => {
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
        const authenticationIdentity = readStoredState()?.authenticationIdentity;
        globalThis.sessionStorage.setItem(
            trackedOperationStorageKey,
            JSON.stringify({
                ...(authenticationIdentity === undefined
                    ? {}
                    : { authenticationIdentity }),
                operations: operations.map(
                    ({ jobRunId, label, operationKey, terminal }) => ({
                        jobRunId,
                        label,
                        ...(operationKey === undefined ? {} : { operationKey }),
                        terminal,
                    })
                ),
            } satisfies StoredOperationState)
        );
    } catch {
        // Job detail remains authoritative when browser storage is unavailable.
    }
}
