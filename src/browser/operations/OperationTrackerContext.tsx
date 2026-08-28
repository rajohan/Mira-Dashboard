import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type PropsWithChildren } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { ListJobRunsResult } from "../../contracts/jobs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    activeManualOperationRunsQueryKey,
    OperationTrackerContext,
    operationKeyForJobAction,
    type NewTrackedOperation,
    type TrackedOperation,
} from "./operationTrackerContextValue.ts";
const trackedOperationMaximum = 12;

function capTerminalHistory(operations: readonly TrackedOperation[]) {
    const capped = [...operations];
    while (capped.length > trackedOperationMaximum) {
        const removableIndex = capped.findLastIndex(({ terminal }) => terminal);
        if (removableIndex === -1) break;
        capped.splice(removableIndex, 1);
    }
    return capped;
}

function AuthenticatedOperationTrackerProvider({ children }: PropsWithChildren) {
    const client = useDashboardTrpcClient();
    const [localOperations, setLocalOperations] = useState<readonly TrackedOperation[]>(
        []
    );
    const activeRuns = useQuery({
        queryFn: ({ signal }): Promise<ListJobRunsResult> =>
            client.query(
                "jobs.listRuns",
                {
                    filters: {
                        states: ["queued", "running"],
                        triggerTypes: ["manual"],
                    },
                    limit: 100,
                },
                { signal }
            ),
        queryKey: activeManualOperationRunsQueryKey,
        refetchInterval: 5000,
        staleTime: 0,
    });
    const settledRunIds = useRef(new Set<string>());
    const localIds = new Set(localOperations.map(({ jobRunId }) => jobRunId));
    const operations = [
        ...localOperations,
        ...(activeRuns.data?.runs ?? [])
            .filter(({ id }) => !localIds.has(id))
            .map((run) => ({
                jobRunId: run.id,
                label: run.displayName,
                operationKey: run.operationKey ?? operationKeyForJobAction(run.actionKey),
                summary: run,
                terminal: false,
            })),
    ];
    const dismiss = (jobRunId: string) => {
        setLocalOperations((current) =>
            current.filter((operation) => operation.jobRunId !== jobRunId)
        );
    };
    const settle = (jobRunId: string) => {
        if (settledRunIds.current.has(jobRunId)) return;
        const operation = localOperations.find(
            (candidate) => candidate.jobRunId === jobRunId
        );
        if (operation === undefined || operation.terminal) return;
        settledRunIds.current.add(jobRunId);
        const onTerminal = operation.onTerminal;
        setLocalOperations((current) => {
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
        setLocalOperations((current) => {
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

/** @returns Backend-backed manual operations plus local completion callbacks. */
export function OperationTrackerProvider({ children }: PropsWithChildren) {
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    return authentication?.state === "authenticated" ? (
        <AuthenticatedOperationTrackerProvider>
            {children}
        </AuthenticatedOperationTrackerProvider>
    ) : (
        children
    );
}
