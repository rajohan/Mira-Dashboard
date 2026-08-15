import { useDroppable } from "@dnd-kit/react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import type { TaskStatus, TaskSummary } from "../../contracts/taskModel.ts";
import { cn } from "../lib/classNames.ts";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { taskStatusDefinitions } from "./taskPresentation.ts";

interface TaskColumnProps {
    readonly cronJobsById: ReadonlyMap<string, OpenClawCronJob>;
    readonly disabled: boolean;
    readonly onSelectTask: (taskId: string) => void;
    readonly status: TaskStatus;
    readonly tasks: readonly TaskSummary[];
}

/** @returns One task-board status column and its droppable card region. */
export function TaskColumn({
    cronJobsById,
    disabled,
    onSelectTask,
    status,
    tasks,
}: TaskColumnProps) {
    const definition = taskStatusDefinitions.find(
        (candidate) => candidate.status === status
    );
    const { isDropTarget, ref } = useDroppable({
        accept: "task-card",
        id: `task-column:${status}`,
        type: "task-column",
    });
    if (definition === undefined) return null;

    return (
        <section className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
            <header className="mb-2 flex items-center gap-2 px-0.5">
                <span
                    aria-hidden="true"
                    className={cn("size-2 rounded-full", definition.dotClassName)}
                />
                <Heading level={2} size="subsection">
                    {definition.title}
                </Heading>
                <span className="bg-primary-700/60 text-primary-400 rounded px-1.5 py-0.5 text-xs">
                    {tasks.length}
                </span>
            </header>
            <div
                className={cn(
                    "border-primary-700/60 bg-primary-800/30 flex min-h-32 flex-col gap-2 rounded-lg border-2 border-dashed p-2 transition-colors lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-y-contain",
                    isDropTarget && "border-accent-400 bg-accent-500/5"
                )}
                ref={ref}
            >
                {tasks.length === 0 ? (
                    <Text className="m-auto py-8 text-center" size="sm" tone="muted">
                        {definition.emptyLabel}
                    </Text>
                ) : (
                    tasks.map((task) => (
                        <TaskCard
                            automationJob={
                                task.automation === undefined
                                    ? undefined
                                    : cronJobsById.get(task.automation.cronJobId)
                            }
                            disabled={disabled}
                            key={task.id}
                            onSelect={onSelectTask}
                            task={task}
                        />
                    ))
                )}
            </div>
        </section>
    );
}
