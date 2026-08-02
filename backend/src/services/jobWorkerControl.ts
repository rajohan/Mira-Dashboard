import { database } from "../database/connection.ts";

export interface JobWorkerClaimsState {
    paused: boolean;
    updatedAt: string;
}

interface JobWorkerControlRow {
    claims_paused: number;
    updated_at: string;
}

/**
 * Reads the shared operator claim state used by both the web and worker
 * processes.
 * @returns Current persistent claim state.
 */
export function getJobWorkerClaimsState(): JobWorkerClaimsState {
    const row = database
        .prepare(
            `SELECT claims_paused, updated_at
             FROM job_worker_control
             WHERE id = 1`
        )
        .get() as JobWorkerControlRow | undefined;
    if (!row) {
        throw new Error("Job worker control state is unavailable");
    }
    return {
        paused: row.claims_paused === 1,
        updatedAt: row.updated_at,
    };
}

/**
 * Persists whether the worker may claim another queued execution. Active work
 * remains cooperative and is not cancelled.
 * @param paused Whether new claims must remain paused.
 * @param updatedAt State transition timestamp.
 * @returns Updated persistent claim state.
 */
export function setJobWorkerClaimsPaused(
    paused: boolean,
    updatedAt = new Date().toISOString()
): JobWorkerClaimsState {
    const result = database
        .prepare(
            `UPDATE job_worker_control
             SET claims_paused = ?, updated_at = ?
             WHERE id = 1`
        )
        .run(paused ? 1 : 0, updatedAt);
    if (result.changes !== 1) {
        throw new Error("Job worker control state update failed");
    }
    return { paused, updatedAt };
}
