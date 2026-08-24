import {
    DragDropProvider,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
} from "@dnd-kit/react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import type { TaskStatus, TaskSummary } from "../../contracts/taskModel.ts";
import type { MoveTaskInput } from "../../contracts/tasks.ts";
import type { InfiniteScrollContinuation } from "../ui/InfiniteScrollTrigger.tsx";
import { taskMoveInputForDrop } from "./taskBoardDrop.ts";
import { TaskCardContent } from "./TaskCard.tsx";
import { TaskColumn } from "./TaskColumn.tsx";
import { taskStatusDefinitions } from "./taskPresentation.ts";

const taskPriorityRank = Object.freeze({ high: 0, low: 2, medium: 1 });

const taskBoardSensors = [
    PointerSensor.configure({
        activationConstraints(event, source) {
            const defaults = PointerSensor.defaults.activationConstraints;
            const constraints =
                typeof defaults === "function" ? defaults(event, source) : defaults;

            // The installed pointer sensor's final mouse constraint is distance.
            // Retaining only it keeps clicks immediate while requiring movement to drag.
            return event.pointerType === "mouse" ? constraints?.slice(-1) : constraints;
        },
    }),
    KeyboardSensor.configure({
        keyboardCodes: {
            ...KeyboardSensor.defaults.keyboardCodes,
            start: ["Space"],
        },
    }),
];

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
    readonly cronJobsById: ReadonlyMap<string, OpenClawCronJob>;
    readonly disabled: boolean;
    readonly onMoveTask: (input: MoveTaskInput) => void;
    readonly onSelectTask: (taskId: string) => void;
    readonly pagination?: InfiniteScrollContinuation;
    readonly tasks: readonly TaskSummary[];
}

/** @returns Four-column task board with accessible dnd-kit movement. */
export function TaskBoard({
    cronJobsById,
    disabled,
    onMoveTask,
    onSelectTask,
    pagination,
    tasks,
}: TaskBoardProps) {
    const tasksByStatus = Object.fromEntries(
        taskStatusDefinitions.map(({ status }) => [
            status,
            tasks.filter((task) => task.status === status).toSorted(compareTasks),
        ])
    ) as Record<TaskStatus, TaskSummary[]>;
    let continuationStatus: TaskStatus | undefined;
    for (const { status } of taskStatusDefinitions) {
        if (
            continuationStatus === undefined ||
            tasksByStatus[status].length > tasksByStatus[continuationStatus].length
        ) {
            continuationStatus = status;
        }
    }

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
            sensors={taskBoardSensors}
        >
            <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-2 xl:grid-cols-4">
                {taskStatusDefinitions.map(({ status }) => (
                    <TaskColumn
                        cronJobsById={cronJobsById}
                        disabled={disabled}
                        key={status}
                        onSelectTask={onSelectTask}
                        pagination={
                            status === continuationStatus ? pagination : undefined
                        }
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
                        <TaskCardContent
                            automationJob={
                                task.automation === undefined
                                    ? undefined
                                    : cronJobsById.get(task.automation.cronJobId)
                            }
                            overlay
                            task={task}
                        />
                    );
                }}
            </DragOverlay>
        </DragDropProvider>
    );
}
