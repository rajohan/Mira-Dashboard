import { DragDropProvider, DragOverlay } from "@dnd-kit/react";

import type { TaskStatus, TaskSummary } from "../../contracts/taskModel.ts";
import type { MoveTaskInput } from "../../contracts/tasks.ts";
import { taskMoveInputForDrop } from "./taskBoardDrop.ts";
import { TaskCardContent } from "./TaskCard.tsx";
import { TaskColumn } from "./TaskColumn.tsx";
import { taskStatusDefinitions } from "./taskPresentation.ts";

const taskPriorityRank = Object.freeze({ high: 0, low: 2, medium: 1 });

function compareTasks(left: TaskSummary, right: TaskSummary): number {
    if (left.status !== "done") {
        const priorityDifference =
            taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
        if (priorityDifference !== 0) return priorityDifference;
    }
    const timeDifference = right.updatedAtMs - left.updatedAtMs;
    return timeDifference === 0 ? right.id.localeCompare(left.id) : timeDifference;
}

interface TaskBoardProps {
    readonly disabled: boolean;
    readonly onMoveTask: (input: MoveTaskInput) => void;
    readonly onSelectTask: (taskId: string) => void;
    readonly tasks: readonly TaskSummary[];
}

/** @returns Four-column task board with accessible dnd-kit movement. */
export function TaskBoard({ disabled, onMoveTask, onSelectTask, tasks }: TaskBoardProps) {
    const tasksByStatus = Object.fromEntries(
        taskStatusDefinitions.map(({ status }) => [
            status,
            tasks.filter((task) => task.status === status).toSorted(compareTasks),
        ])
    ) as Record<TaskStatus, TaskSummary[]>;

    return (
        <DragDropProvider
            onDragEnd={({ canceled, operation }) => {
                if (canceled) return;
                const input = taskMoveInputForDrop(
                    tasks,
                    operation.source?.id,
                    operation.target?.id
                );
                if (input !== undefined) onMoveTask(input);
            }}
        >
            <div className="grid gap-4 lg:min-h-136 lg:grid-cols-4">
                {taskStatusDefinitions.map(({ status }) => (
                    <TaskColumn
                        disabled={disabled}
                        key={status}
                        onSelectTask={onSelectTask}
                        status={status}
                        tasks={tasksByStatus[status]}
                    />
                ))}
            </div>
            <DragOverlay>
                {(source) => {
                    const task = tasks.find(
                        (candidate) => `task:${candidate.id}` === source.id
                    );
                    return task === undefined ? null : (
                        <TaskCardContent overlay task={task} />
                    );
                }}
            </DragOverlay>
        </DragDropProvider>
    );
}
