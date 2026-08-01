import type { AgentTaskHistoryItem } from "../../../../contracts/agents.ts";
import { database } from "../../database.ts";

const TASK_IDLE_TIMEOUT_MS = 30 * 60_000;

function nowIso(): string {
    return new Date().toISOString();
}

function timestampToIso(timestamp: number): string {
    return new Date(timestamp).toISOString();
}

export function closeStaleActiveTasks(): void {
    const cutoff = timestampToIso(Date.now() - TASK_IDLE_TIMEOUT_MS);
    database
        .prepare(
            `UPDATE agent_task_history
         SET status = 'completed_auto', completed_at = ?, last_activity_at = ?
         WHERE status = 'active' AND last_activity_at < ?`
        )
        .run(nowIso(), nowIso(), cutoff);
}

/**
 * Finds the most recent non-finished task in agent history for active-task inference.
 * @param agentId Agent identifier.
 * @returns Located the most recent non-finished task in agent history for active-task inference.
 */
export function getActiveHistoryTask(agentId: string): AgentTaskHistoryItem | undefined {
    const row = database
        .prepare(
            `SELECT id, agent_id, task, status, started_at, completed_at, last_activity_at
         FROM agent_task_history
         WHERE agent_id = ? AND status = 'active'
         ORDER BY started_at DESC
         LIMIT 1`
        )
        .get(agentId) as
        | undefined
        | {
              id: number;
              agent_id: string;
              task: string;
              status: string;
              started_at: string;
              completed_at: string | null | undefined;
              last_activity_at: string;
          };

    if (!row) {
        return undefined;
    }

    return {
        id: row.id,
        agentId: row.agent_id,
        task: row.task,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? undefined,
        lastActivityAt: row.last_activity_at,
    };
}

/**
 * Returns recently completed task-history entries for dashboard display.
 * @param limit Limit value.
 * @returns recently completed task-history entries for dashboard display.
 */
export function getLatestCompletedTasks(limit = 8): AgentTaskHistoryItem[] {
    const safeLimit = Number.isFinite(limit)
        ? Math.max(1, Math.min(100, Math.floor(limit)))
        : 8;
    const rows = database
        .prepare(
            `SELECT id, agent_id, task, status, started_at, completed_at, last_activity_at
         FROM agent_task_history
         WHERE status != 'active' AND completed_at IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT ?`
        )
        .all(safeLimit) as Array<{
        id: number;
        agent_id: string;
        task: string;
        status: string;
        started_at: string;
        completed_at: string | undefined;
        last_activity_at: string;
    }>;

    return rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        task: row.task,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        lastActivityAt: row.last_activity_at,
    }));
}

/**
 * Parses agents.yml into dashboard agent records while tolerating empty or malformed input.
 * @returns Parsed agents.yml into dashboard agent records while tolerating empty or malformed input.
 */
