import { createContext, use } from "react";

import type { JobRunSummary } from "../../contracts/jobModel.ts";

export const activeManualOperationRunsQueryKey = [
    "operations",
    "active-manual-runs",
] as const;

/**
 * @param actionKey Durable worker action identity.
 * @returns The UI identity shared by one durable worker action across devices.
 */
export function operationKeyForJobAction(actionKey: string): string {
    return `job:${actionKey}`;
}

export interface TrackedOperation {
    readonly jobRunId: string;
    readonly label: string;
    readonly operationKey?: string;
    readonly onTerminal?: () => Promise<void> | void;
    readonly summary?: JobRunSummary;
    readonly terminal: boolean;
}

export type NewTrackedOperation = Omit<TrackedOperation, "terminal">;

export interface OperationTrackerValue {
    readonly dismiss: (jobRunId: string) => void;
    readonly operations: readonly TrackedOperation[];
    readonly operationIsActive: (operationKey: string) => boolean;
    readonly settle: (jobRunId: string) => void;
    readonly track: (operation: NewTrackedOperation) => void;
}

const unavailableOperationTracker = Object.freeze({
    dismiss: () => {},
    operationIsActive: () => false,
    operations: Object.freeze([]),
    settle: () => {},
    track: () => {},
} satisfies OperationTrackerValue);

export const OperationTrackerContext = createContext<OperationTrackerValue>(
    unavailableOperationTracker
);

/** @returns The authenticated session operation tracker. */
export function useOperationTracker(): OperationTrackerValue {
    return use(OperationTrackerContext);
}
