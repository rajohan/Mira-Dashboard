import { useEffect, useRef, useState, type PropsWithChildren } from "react";

import {
    OperationTrackerContext,
    type NewTrackedOperation,
    type TrackedOperation,
} from "./operationTrackerContextValue.ts";
import {
    readStoredOperations,
    storeOperations,
    trackedOperationsStorageChangedEvent,
} from "./operationTrackerStorage.ts";

const trackedOperationMaximum = 12;

interface OperationTrackerProviderProps extends PropsWithChildren {
    readonly restoreStoredOperations?: boolean;
}

function capTerminalHistory(operations: readonly TrackedOperation[]) {
    const capped = [...operations];
    while (capped.length > trackedOperationMaximum) {
        const removableIndex = capped.findLastIndex(({ terminal }) => terminal);
        if (removableIndex === -1) break;
        capped.splice(removableIndex, 1);
    }
    return capped;
}

/** @returns Session-scoped durable job identities shared across route navigation. */
export function OperationTrackerProvider({
    children,
    restoreStoredOperations = false,
}: OperationTrackerProviderProps) {
    const [operations, setOperations] = useState<readonly TrackedOperation[]>(() =>
        restoreStoredOperations ? readStoredOperations() : []
    );
    const settledRunIds = useRef(new Set<string>());
    useEffect(() => {
        const synchronize = () => {
            settledRunIds.current.clear();
            setOperations(readStoredOperations());
        };
        globalThis.addEventListener(trackedOperationsStorageChangedEvent, synchronize);
        return () =>
            globalThis.removeEventListener(
                trackedOperationsStorageChangedEvent,
                synchronize
            );
    }, []);
    const dismiss = (jobRunId: string) => {
        setOperations((current) => {
            const next = current.filter((operation) => operation.jobRunId !== jobRunId);
            storeOperations(next);
            return next;
        });
    };
    const settle = (jobRunId: string) => {
        if (settledRunIds.current.has(jobRunId)) return;
        const operation = operations.find((candidate) => candidate.jobRunId === jobRunId);
        if (operation === undefined || operation.terminal) return;
        settledRunIds.current.add(jobRunId);
        const onTerminal = operation.onTerminal;
        setOperations((current) => {
            const operation = current.find(
                (candidate) => candidate.jobRunId === jobRunId
            );
            if (operation === undefined || operation.terminal) return current;
            const next = capTerminalHistory(
                current.map((candidate) =>
                    candidate.jobRunId === jobRunId
                        ? { ...candidate, terminal: true }
                        : candidate
                )
            );
            storeOperations(next);
            return next;
        });
        if (onTerminal !== undefined) {
            void Promise.resolve(onTerminal()).catch(() => {
                // The terminal job state remains authoritative; route data also has
                // its normal realtime/poll fallback after a best-effort refresh fails.
            });
        }
    };
    const track = (operation: NewTrackedOperation) => {
        setOperations((current) => {
            const existing = current.find(
                ({ jobRunId }) => jobRunId === operation.jobRunId
            );
            const next = capTerminalHistory([
                {
                    ...operation,
                    onTerminal: operation.onTerminal ?? existing?.onTerminal,
                    terminal:
                        settledRunIds.current.has(operation.jobRunId) ||
                        (existing?.terminal ?? false),
                },
                ...current.filter(({ jobRunId }) => jobRunId !== operation.jobRunId),
            ]);
            storeOperations(next);
            return next;
        });
    };
    const operationIsActive = (operationKey: string) =>
        operations.some(
            (operation) => !operation.terminal && operation.operationKey === operationKey
        );
    return (
        <OperationTrackerContext
            value={{ dismiss, operationIsActive, operations, settle, track }}
        >
            {children}
        </OperationTrackerContext>
    );
}
