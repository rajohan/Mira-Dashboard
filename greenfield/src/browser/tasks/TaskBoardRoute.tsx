import { useInfiniteQuery } from "@tanstack/react-query";
import { ListTodo, Plus } from "lucide-react";
import { useDeferredValue, useState } from "react";

import type { TaskSummary } from "../../contracts/taskModel.ts";
import type { ListTasksInput } from "../../contracts/tasks.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { NewTaskModal } from "./NewTaskModal.tsx";
import { TaskBoard } from "./TaskBoard.tsx";
import {
    type TaskAssigneeFilter,
    type TaskAutomationFilter,
    TaskBoardToolbar,
} from "./TaskBoardToolbar.tsx";
import { TaskDetailModal } from "./TaskDetailModal.tsx";
import { useTaskMutation } from "./taskMutations.ts";
import { taskListQueryOptions } from "./taskQueries.ts";
import { useTaskRealtimeInvalidation } from "./useTaskRealtimeInvalidation.ts";

function taskFilters(
    search: string,
    assignee: TaskAssigneeFilter,
    automation: TaskAutomationFilter
): ListTasksInput["filters"] {
    const normalizedSearch = search.trim();
    if (normalizedSearch.length === 0 && assignee === "all" && automation === "all") {
        return;
    }
    return {
        ...(assignee === "all" ? {} : { assignees: [assignee] }),
        ...(automation === "all" ? {} : { automation }),
        ...(normalizedSearch.length === 0 ? {} : { search: normalizedSearch }),
    };
}

function uniqueTasks(pages: readonly { readonly tasks: TaskSummary[] }[]): TaskSummary[] {
    const tasks = new Map<string, TaskSummary>();
    for (const page of pages) {
        for (const task of page.tasks) tasks.set(task.id, task);
    }
    return [...tasks.values()];
}

/** @returns Server-filtered task board with complete task mutation dialogs. */
export function TaskBoardRoute() {
    useTaskRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const [search, setSearch] = useState("");
    const [assignee, setAssignee] = useState<TaskAssigneeFilter>("all");
    const [automation, setAutomation] = useState<TaskAutomationFilter>("all");
    const [newTaskOpen, setNewTaskOpen] = useState(false);
    const [selectedTaskId, setSelectedTaskId] = useState<string>();
    const deferredSearch = useDeferredValue(search);
    const filters = taskFilters(deferredSearch, assignee, automation);
    const taskPages = useInfiniteQuery(taskListQueryOptions(client, filters));
    const moveTask = useTaskMutation("tasks.move");
    const tasks = uniqueTasks(taskPages.data?.pages ?? []);
    const hasFilters = filters !== undefined;

    return (
        <div>
            <PageHeader
                description="Track, assign, automate, and audit work across the operator and Mira."
                eyebrow="Work management"
                title="Tasks"
            />
            <div className="mt-6">
                <TaskBoardToolbar
                    assignee={assignee}
                    automation={automation}
                    busy={taskPages.isFetching || moveTask.isPending}
                    onAssigneeChange={setAssignee}
                    onAutomationChange={setAutomation}
                    onCreate={() => setNewTaskOpen(true)}
                    onRefresh={() => void taskPages.refetch()}
                    onSearchChange={setSearch}
                    search={search}
                />
            </div>
            <Alert
                className="mt-4"
                message={
                    moveTask.error === null
                        ? undefined
                        : dashboardBrowserFailureMessage(moveTask.error)
                }
            />
            {taskPages.isPending && (
                <LoadingState className="mt-10" label="Loading tasks…" />
            )}
            {taskPages.isError && (
                <div className="mt-6">
                    <Alert message={dashboardBrowserFailureMessage(taskPages.error)} />
                    <Button
                        className="mt-3"
                        onClick={() => void taskPages.refetch()}
                        variant="secondary"
                    >
                        Try again
                    </Button>
                </div>
            )}
            {taskPages.isSuccess && tasks.length === 0 && (
                <div className="mt-8">
                    <EmptyState
                        action={
                            hasFilters ? (
                                <Button
                                    onClick={() => {
                                        setSearch("");
                                        setAssignee("all");
                                        setAutomation("all");
                                    }}
                                    variant="secondary"
                                >
                                    Clear filters
                                </Button>
                            ) : (
                                <Button onClick={() => setNewTaskOpen(true)}>
                                    <Icon icon={Plus} size="sm" tone="inherit" />
                                    Create task
                                </Button>
                            )
                        }
                        description={
                            hasFilters
                                ? "Change the search or filters to return to the full board."
                                : "Create the first task when there is work to track."
                        }
                        icon={ListTodo}
                        title={hasFilters ? "No matching tasks" : "No tasks yet"}
                    />
                </div>
            )}
            {tasks.length > 0 && (
                <div className="mt-6">
                    <TaskBoard
                        disabled={moveTask.isPending}
                        onMoveTask={(input) => moveTask.mutate(input)}
                        onSelectTask={setSelectedTaskId}
                        tasks={tasks}
                    />
                    {taskPages.hasNextPage && (
                        <Button
                            busy={taskPages.isFetchingNextPage}
                            busyLabel="Loading…"
                            className="mt-5"
                            onClick={() => void taskPages.fetchNextPage()}
                            variant="secondary"
                        >
                            Load more tasks
                        </Button>
                    )}
                </div>
            )}
            <NewTaskModal
                onClose={() => setNewTaskOpen(false)}
                onCreated={(task) => {
                    setNewTaskOpen(false);
                    setSelectedTaskId(task.id);
                }}
                open={newTaskOpen}
            />
            {selectedTaskId !== undefined && (
                <TaskDetailModal
                    key={selectedTaskId}
                    onClose={() => setSelectedTaskId(undefined)}
                    taskId={selectedTaskId}
                />
            )}
        </div>
    );
}
