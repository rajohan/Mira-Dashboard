import { useDroppable } from "@dnd-kit/react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import type { TaskStatus, TaskSummary } from "../../contracts/taskModel.ts";
import { cn } from "../lib/classNames.ts";
import { Heading } from "../ui/Heading.tsx";
import type { InfiniteScrollContinuation } from "../ui/InfiniteScrollTrigger.tsx";
import { Text } from "../ui/Text.tsx";
import { VirtualizedList } from "../ui/VirtualizedList.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { taskStatusDefinitions } from "./taskPresentation.ts";

interface TaskColumnProps {
    readonly cronJobsById: ReadonlyMap<string, OpenClawCronJob>;
    readonly disabled: boolean;
    readonly onSelectTask: (taskId: string) => void;
    readonly pagination?: InfiniteScrollContinuation;
    readonly status: TaskStatus;
    readonly tasks: readonly TaskSummary[];
}

/** @returns One task-board status column and its droppable card region. */
export function TaskColumn({
    cronJobsById,
    disabled,
    onSelectTask,
    pagination,
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
            {tasks.length === 0 ? (
                <div
                    className={cn(
                        "border-primary-700/60 bg-primary-800/30 flex min-h-32 flex-col rounded-lg border-2 border-dashed p-2 transition-colors lg:min-h-0 lg:flex-1",
                        isDropTarget && "border-accent-400 bg-accent-500/5"
                    )}
                    ref={ref}
                >
                    <Text className="m-auto py-8 text-center" size="sm" tone="muted">
                        {definition.emptyLabel}
                    </Text>
                </div>
            ) : (
                <div
                    className={cn(
                        "border-primary-700/60 bg-primary-800/30 relative min-h-32 overflow-hidden rounded-lg border-2 border-dashed transition-colors lg:min-h-0 lg:flex-1",
                        isDropTarget && "border-accent-400 bg-accent-500/5"
                    )}
                    ref={ref}
                >
                    <VirtualizedList
                        className="h-full max-h-none overscroll-y-contain p-2"
                        estimateSize={() => 148}
                        getKey={(task) => task.id}
                        itemClassName="pb-2"
                        items={tasks}
                        label={`${definition.title} tasks`}
                        pagination={pagination}
                        renderItem={(task) => (
                            <TaskCard
                                automationJob={
                                    task.automation === undefined
                                        ? undefined
                                        : cronJobsById.get(task.automation.cronJobId)
                                }
                                disabled={disabled}
                                onSelect={onSelectTask}
                                task={task}
                            />
                        )}
                    />
                </div>
            )}
        </section>
    );
}
