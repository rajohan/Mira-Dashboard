import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ListTodo, Plus, RefreshCw } from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import type { TaskSummary } from "../../contracts/taskModel.ts";
import type { ListTasksInput } from "../../contracts/tasks.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import {
    accumulateOpenClawCronInventoryPages,
    openClawCronListQueryOptions,
} from "../openClawCron/openClawCronQueries.ts";
import { useOpenClawCronRealtimeInvalidation } from "../openClawCron/useOpenClawCronRealtimeInvalidation.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { NewTaskModal } from "./NewTaskModal.tsx";
import { TaskBoard } from "./TaskBoard.tsx";
import {
    type TaskAssigneeFilter,
    type TaskAutomationFilter,
    TaskBoardToolbar,
} from "./TaskBoardToolbar.tsx";
import { TaskDetailModal } from "./TaskDetailModal.tsx";
import { useTaskMutation } from "./taskMutations.ts";
import { taskLabelSuggestionsQueryOptions, taskListQueryOptions } from "./taskQueries.ts";
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

function linkedCronJobIds(tasks: readonly TaskSummary[]): readonly string[] {
    return [
        ...new Set(
            tasks.flatMap((task) =>
                task.automation === undefined ? [] : [task.automation.cronJobId]
            )
        ),
    ];
}

function cronJobsById(
    jobs: readonly OpenClawCronJob[]
): ReadonlyMap<string, OpenClawCronJob> {
    return new Map(jobs.map((job) => [job.id, job]));
}

/** @returns Server-filtered task board with complete task mutation dialogs. */
export function TaskBoardRoute() {
    useTaskRealtimeInvalidation();
    useOpenClawCronRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const [search, setSearch] = useState("");
    const [assignee, setAssignee] = useState<TaskAssigneeFilter>("all");
    const [automation, setAutomation] = useState<TaskAutomationFilter>("all");
    const [newTaskOpen, setNewTaskOpen] = useState(false);
    const [selectedTaskId, setSelectedTaskId] = useState<string>();
    const deferredSearch = useDeferredValue(search);
    const filters = taskFilters(deferredSearch, assignee, automation);
    const taskPages = useInfiniteQuery(taskListQueryOptions(client, filters));
    const taskPageRequest = useRef<Promise<unknown> | undefined>(undefined);
    const labelSuggestions = useQuery(taskLabelSuggestionsQueryOptions(client));
    const moveTask = useTaskMutation("tasks.move");
    const tasks = uniqueTasks(taskPages.data?.pages ?? []);
    const linkedJobIds = linkedCronJobIds(tasks);
    const cronInventory = useInfiniteQuery(
        openClawCronListQueryOptions(client, linkedJobIds.length > 0)
    );
    const cronInventoryAccumulation = accumulateOpenClawCronInventoryPages(
        cronInventory.data?.pages ?? []
    );
    const linkedCronJobsById = cronJobsById(cronInventoryAccumulation?.result.jobs ?? []);
    const linkedJobIsUnresolved = linkedJobIds.some((id) => !linkedCronJobsById.has(id));
    const shouldLoadMoreCronJobs =
        linkedJobIsUnresolved &&
        cronInventoryAccumulation?.stable === true &&
        cronInventory.hasNextPage === true &&
        !cronInventory.isFetchingNextPage;
    const fetchNextCronPage = cronInventory.fetchNextPage;
    useEffect(() => {
        if (!shouldLoadMoreCronJobs) return;
        void fetchNextCronPage();
    }, [fetchNextCronPage, shouldLoadMoreCronJobs]);
    const labels = labelSuggestions.data?.labels ?? [];
    const hasFilters = filters !== undefined;

    function loadMoreTaskPage(): void {
        if (taskPageRequest.current !== undefined) return;
        const request = taskPages.fetchNextPage();
        taskPageRequest.current = request;
        void request.finally(() => {
            if (taskPageRequest.current === request) taskPageRequest.current = undefined;
        });
    }

    return (
        <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">
            <Heading className="sr-only" level={1}>
                Tasks
            </Heading>
            <div>
                <TaskBoardToolbar
                    assignee={assignee}
                    automation={automation}
                    busy={moveTask.isPending}
                    onAssigneeChange={setAssignee}
                    onAutomationChange={setAutomation}
                    onCreate={() => setNewTaskOpen(true)}
                    onSearchChange={setSearch}
                    search={search}
                />
            </div>
            <Alert
                className="mt-4"
                message={
                    moveTask.error === null && labelSuggestions.error === null
                        ? undefined
                        : dashboardBrowserFailureMessage(
                              moveTask.error ?? labelSuggestions.error
                          )
                }
            />
            {taskPages.isPending && (
                <LoadingState className="mt-10" label="Loading tasks…" />
            )}
            {taskPages.isError && taskPages.data === undefined && (
                <Alert
                    action={
                        <Button
                            onClick={() => void taskPages.refetch()}
                            size="sm"
                            variant="secondary"
                        >
                            Try again
                        </Button>
                    }
                    className="mt-6"
                    message={dashboardBrowserFailureMessage(taskPages.error)}
                />
            )}
            {taskPages.error !== null &&
                taskPages.data !== undefined &&
                !taskPages.isFetchNextPageError && (
                    <Alert
                        action={
                            <Button
                                onClick={() => void taskPages.refetch()}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={RefreshCw} size="sm" tone="inherit" />
                                Try again
                            </Button>
                        }
                        className="mt-6"
                        message={dashboardBrowserFailureMessage(taskPages.error)}
                    />
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
                <div className="mt-6 flex flex-1 flex-col lg:min-h-0">
                    <TaskBoard
                        cronJobsById={linkedCronJobsById}
                        disabled={moveTask.isPending}
                        onMoveTask={(input) => moveTask.mutate(input)}
                        onSelectTask={setSelectedTaskId}
                        pagination={{
                            ...(taskPages.isFetchNextPageError && taskPages.error !== null
                                ? {
                                      error: dashboardBrowserFailureMessage(
                                          taskPages.error
                                      ),
                                  }
                                : {}),
                            hasMore: taskPages.hasNextPage,
                            loading: taskPages.isFetchingNextPage,
                            loadingLabel: "Loading more tasks…",
                            onLoadMore: loadMoreTaskPage,
                        }}
                        tasks={tasks}
                    />
                </div>
            )}
            <NewTaskModal
                availableLabels={labels}
                onClose={() => setNewTaskOpen(false)}
                onCreated={(task) => {
                    setNewTaskOpen(false);
                    setSelectedTaskId(task.id);
                }}
                open={newTaskOpen}
            />
            {selectedTaskId !== undefined && (
                <TaskDetailModal
                    availableLabels={labels}
                    key={selectedTaskId}
                    onClose={() => setSelectedTaskId(undefined)}
                    taskId={selectedTaskId}
                />
            )}
        </div>
    );
}
