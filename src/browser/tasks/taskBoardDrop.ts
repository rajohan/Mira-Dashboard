import type { TaskSummary } from "../../contracts/taskModel.ts";
import type { MoveTaskInput } from "../../contracts/tasks.ts";
import { taskStatusDefinitions } from "./taskPresentation.ts";

/**
 * Maps a completed status-column drop to the versioned task mutation contract.
 * @param tasks Current task summaries rendered by the board.
 * @param sourceId Drag source identifier supplied by dnd-kit.
 * @param targetId Drop target identifier supplied by dnd-kit.
 * @returns A move request only when the task changes status.
 */
export function taskMoveInputForDrop(
    tasks: readonly TaskSummary[],
    sourceId: string | number | undefined,
    targetId: string | number | undefined
): MoveTaskInput | undefined {
    const task = tasks.find((candidate) => `task:${candidate.id}` === sourceId);
    const target = taskStatusDefinitions.find(
        ({ status }) => `task-column:${status}` === targetId
    );
    if (task === undefined || target === undefined || task.status === target.status) {
        return;
    }
    return {
        expectedVersion: task.version,
        id: task.id,
        status: target.status,
    };
}
