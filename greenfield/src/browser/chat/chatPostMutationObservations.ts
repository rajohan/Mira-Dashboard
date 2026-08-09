import type {
    ChatCompanionStateOutput,
    ChatRuntimeOutput,
} from "../../contracts/chat.ts";
import type { ListGatewaySessionsResult } from "../../contracts/gatewaySessions.ts";
import type { OpenClawTaskSummary } from "../../contracts/openClawTasks.ts";
import type { ChatRuntimeBatch } from "./chatQueries.ts";

const terminalTaskStatuses = new Set<OpenClawTaskSummary["status"]>([
    "cancelled",
    "completed",
    "failed",
    "timed_out",
]);

/** Provider inventory watermark captured only after pre-action reads are cancelled. */
export interface ChatProviderObservationBoundary {
    readonly observedAtMs: number;
}

/** Runtime target watermark captured only after its pre-abort read is cancelled. */
export interface ChatRuntimeObservationBoundary {
    readonly runId: string;
    readonly runLastSequence: number;
    readonly sessionKey: string;
}

/** Task version captured only after active, finished, and exact reads are cancelled. */
export interface ChatTaskObservationBoundary {
    readonly taskUpdatedAtMs?: number;
}

/** Companion-reset state captured only after its exact pre-reset read is cancelled. */
export interface ChatCompanionResetObservationBoundary {
    readonly stateFingerprint?: string;
}

/**
 * Determines whether an explicitly initiated post-action inventory read is authoritative.
 * @param boundary The inventory watermark captured after pre-action cancellation.
 * @param observation The action-owned post-mutation inventory.
 * @returns Whether the observation is fresh and strictly newer than the boundary.
 */
export function chatProviderObservationIsNewer(
    boundary: ChatProviderObservationBoundary,
    observation: ListGatewaySessionsResult
): boolean {
    return (
        observation.source.freshness === "fresh" &&
        observation.source.observedAtMs > boundary.observedAtMs
    );
}

/**
 * Produces a semantic companion-state identity independent of cache timestamps.
 * @param state The validated companion state, when available.
 * @returns A stable exchange fingerprint, or `undefined` when state is unavailable.
 */
export function chatCompanionStateFingerprint(
    state: ChatCompanionStateOutput | undefined
): string | undefined {
    return state === undefined ? undefined : JSON.stringify(state.exchanges);
}

/**
 * Confirms an indeterminate reset when its action-owned post-reset read is empty.
 * Read ownership, rather than semantic inequality, distinguishes an unchanged
 * authoritative empty state from a delayed pre-action result.
 * @param _boundary The reset boundary documenting action ownership.
 * @param observation The action-owned post-reset companion state.
 * @returns Whether the authoritative state proves that no exchanges remain.
 */
export function chatCompanionResetObservationConfirmsReset(
    _boundary: ChatCompanionResetObservationBoundary,
    observation: ChatCompanionStateOutput
): boolean {
    return observation.exchanges.length === 0;
}

/**
 * Finds the highest target-run sequence carried by one explicit runtime read.
 * @param observation The validated runtime events and snapshots.
 * @param runId The exact run whose sequence must advance.
 * @returns The highest sequence for the target run, when present.
 */
function chatRuntimeTargetSequence(
    observation: Pick<ChatRuntimeOutput, "events" | "runs">,
    runId: string
): number | undefined {
    const sequences = [
        ...observation.events.flatMap(({ event }) =>
            event.runId === runId ? [event.sequence] : []
        ),
        ...observation.runs.flatMap((snapshot) =>
            snapshot.run.id === runId ? [snapshot.throughSequence] : []
        ),
    ];
    return sequences.length === 0 ? undefined : Math.max(...sequences);
}

/**
 * Determines whether one explicitly initiated post-abort runtime read advances
 * the exact target run beyond its pre-dispatch sequence.
 * @param boundary The exact target and sequence captured before dispatch.
 * @param observation The action-owned post-abort runtime batch.
 * @returns Whether the exact target advanced beyond the boundary.
 */
export function chatRuntimeObservationAdvancesRun(
    boundary: ChatRuntimeObservationBoundary,
    observation: ChatRuntimeBatch
): boolean {
    if (observation.sessionKey !== boundary.sessionKey) return false;
    const sequence = chatRuntimeTargetSequence(observation, boundary.runId);
    return sequence !== undefined && sequence > boundary.runLastSequence;
}

/**
 * Determines whether an explicitly initiated post-cancel task read proves a
 * terminal transition or a strictly newer provider version.
 * @param boundary The task version captured after pre-action cancellation.
 * @param task The exact task returned by the action-owned reconciliation read.
 * @returns Whether the task is terminal or strictly newer than the boundary.
 */
export function chatTaskObservationAdvances(
    boundary: ChatTaskObservationBoundary,
    task: OpenClawTaskSummary | undefined
): boolean {
    if (task === undefined) return false;
    if (terminalTaskStatuses.has(task.status)) return true;
    if (task.updatedAtMs === undefined) return false;
    return (
        boundary.taskUpdatedAtMs === undefined ||
        task.updatedAtMs > boundary.taskUpdatedAtMs
    );
}
