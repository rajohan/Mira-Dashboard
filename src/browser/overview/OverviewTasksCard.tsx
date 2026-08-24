import { ListTodo } from "lucide-react";
import { useId } from "react";

import type { TaskStatus, TaskSummary } from "../../contracts/taskModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import {
    taskAssigneeLabel,
    taskPriorityBadgeVariant,
    taskStatusDefinitions,
} from "../tasks/taskPresentation.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";

const activeTaskDefinitions = taskStatusDefinitions.filter(
    ({ status }) => status !== "done"
);

export interface OverviewTasksCardProps {
    readonly hasMore: boolean;
    readonly tasks: readonly TaskSummary[];
}

function statusCount(tasks: readonly TaskSummary[], status: TaskStatus): number {
    return tasks.filter((task) => task.status === status).length;
}

/**
 * Renders one disclosed newest-unfinished-task window without claiming global totals.
 * @param properties Validated unfinished-task rows and continuation state.
 * @returns Read-only task overview with an exact task-board route link.
 */
export function OverviewTasksCard({ hasMore, tasks }: OverviewTasksCardProps) {
    const headingId = useId();
    const latestHeadingId = useId();
    const latest = tasks[0];
    const latestStatus = activeTaskDefinitions.find(
        ({ status }) => status === latest?.status
    );

    return (
        <Card aria-labelledby={headingId} className="h-full">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2">
                    <ListTodo aria-hidden="true" className="text-accent-300 size-5" />
                    <Heading id={headingId} level={2} size="subsection">
                        Unfinished tasks
                    </Heading>
                </div>
                <ActionLink size="sm" to="/tasks" variant="secondary">
                    View tasks
                </ActionLink>
            </div>

            <dl className="mt-5 grid grid-cols-3 gap-3">
                {activeTaskDefinitions.map(({ dotClassName, status, title }) => (
                    <div
                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                        key={status}
                    >
                        <dt className="text-primary-400 flex items-center gap-2 text-xs">
                            <span
                                aria-hidden="true"
                                className={`${dotClassName} size-2 rounded-full`}
                            />
                            {title}
                        </dt>
                        <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                            {statusCount(tasks, status)}
                        </dd>
                    </div>
                ))}
            </dl>

            {latest === undefined ? (
                <div className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4">
                    <Text>No unfinished tasks.</Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        Completed tasks remain available on the task board.
                    </Text>
                </div>
            ) : (
                <section
                    aria-labelledby={latestHeadingId}
                    className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        {latestStatus !== undefined && (
                            <Badge>{latestStatus.title}</Badge>
                        )}
                        <Badge variant={taskPriorityBadgeVariant(latest.priority)}>
                            {latest.priority} priority
                        </Badge>
                        <Badge>{taskAssigneeLabel(latest.assignee)}</Badge>
                    </div>
                    <Heading
                        className="mt-3 line-clamp-2 wrap-break-word"
                        id={latestHeadingId}
                        level={3}
                    >
                        {latest.title}
                    </Heading>
                    <time
                        className="text-primary-400 mt-3 block text-xs"
                        dateTime={new Date(latest.updatedAtMs).toISOString()}
                    >
                        Updated {formatDashboardDateTime(latest.updatedAtMs)}
                    </time>
                </section>
            )}

            {hasMore && (
                <Text className="mt-3" size="sm" tone="muted">
                    Older unfinished tasks are available on the task board.
                </Text>
            )}
        </Card>
    );
}
