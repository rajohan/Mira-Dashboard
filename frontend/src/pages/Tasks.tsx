import {
    DndContext,
    type DragEndEvent,
    type DragOverEvent,
    DragOverlay,
    type DragStartEvent,
} from "@dnd-kit/core";
import { useState } from "react";

import {
    type ColumnId,
    type Task,
    TASK_ASSIGNEES,
    type TaskAssigneeId,
    type TaskAutomationInput,
} from "../../../contracts/tasks";
import { NewTaskModal } from "../components/features/tasks/NewTaskModal";
import {
    TaskBoardToolbar,
    type TaskAssigneeFilter,
    type TaskAutomationFilter,
} from "../components/features/tasks/TaskBoardToolbar";
import { TaskColumn } from "../components/features/tasks/TaskColumn";
import { TaskDetailModal } from "../components/features/tasks/TaskDetailModal";
import { TaskOverlay } from "../components/features/tasks/TaskOverlay";
import { Alert } from "../components/ui/Alert";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { RefreshButton } from "../components/ui/RefreshButton";
import {
    useAssignTask,
    useCreateTask,
    useCreateTaskUpdate,
    useDeleteTask,
    useDeleteTaskUpdate,
    useMoveTask,
    useTasks,
    useTaskUpdates,
    useUpdateTask,
    useUpdateTaskUpdate,
} from "../hooks/useTasks";
import { messageFromError } from "../lib/errorMessage";
import {
    COLUMN_CONFIG,
    getColumnId,
    getPriority,
    getTaskUpdatedAtMs,
    isTaskMatchSearch,
} from "../utils/taskUtilities";

/**
 * Renders the tasks UI.
 * @returns Rendered the tasks UI.
 */
export function Tasks() {
    const { data: tasksData, isLoading, error, refetch } = useTasks();
    const tasks = tasksData ?? [];
    const moveTask = useMoveTask();
    const createTask = useCreateTask();
    const assignTask = useAssignTask();
    const deleteTask = useDeleteTask();
    const updateTask = useUpdateTask();
    const createTaskUpdate = useCreateTaskUpdate();
    const updateTaskUpdate = useUpdateTaskUpdate();
    const deleteTaskUpdate = useDeleteTaskUpdate();

    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<TaskAssigneeFilter>("all");
    const [automationFilter, setAutomationFilter] = useState<TaskAutomationFilter>("all");
    const [activeId, setActiveId] = useState<string | undefined>();
    const [overId, setOverId] = useState<ColumnId | undefined>();
    const [selectedTask, setSelectedTask] = useState<Task | undefined>();
    const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
    const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<number | undefined>();
    const [pendingDeleteUpdate, setPendingDeleteUpdate] = useState<
        | undefined
        | {
              taskId: number;
              updateId: number;
          }
    >();

    const { data: taskUpdates = [] } = useTaskUpdates(selectedTask?.number ?? undefined);

    const filteredTasks = tasks.filter((task) => {
        const isMatchesFilter =
            filter === "all" ||
            task.assignees.some((a) => (a.login || a.name) === filter);
        const isAutomationFilterMatch =
            automationFilter === "all" ||
            (automationFilter === "recurring" && task.automation?.recurring === true) ||
            (automationFilter === "manual" && task.automation?.recurring !== true);
        const isMatchesSearch = isTaskMatchSearch(task, search);
        return isMatchesFilter && isAutomationFilterMatch && isMatchesSearch;
    });
    const hasActiveFilters =
        search.trim().length > 0 || filter !== "all" || automationFilter !== "all";

    const tasksByColumn: Record<ColumnId, Task[]> = {
        todo: [],
        "in-progress": [],
        blocked: [],
        done: [],
    };

    for (const col of COLUMN_CONFIG) {
        tasksByColumn[col.id] = filteredTasks
            .filter((taskItem) => col.acceptsTask(taskItem))
            .toSorted((a, b) => {
                const updatedDiff = getTaskUpdatedAtMs(b) - getTaskUpdatedAtMs(a);

                if (col.id === "done") {
                    return updatedDiff || b.number - a.number;
                }

                const rank = { high: 0, medium: 1, low: 2 };
                const priorityDiff =
                    rank[getPriority(a.labels)] - rank[getPriority(b.labels)];
                if (priorityDiff !== 0) {
                    return priorityDiff;
                }

                return updatedDiff || b.number - a.number;
            });
    }

    /** Responds to drag start events. */
    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string);
    };

    /**
     * Performs resolve column from over ID.
     * @param overIdValue Over id value value.
     * @returns Resolve column from over ID result.
     */
    const resolveColumnFromOverId = (overIdValue: string): ColumnId | undefined => {
        const directColumn = getColumnId(overIdValue);
        if (directColumn) {
            return directColumn;
        }

        const overTask = tasks.find((task) => String(task.number) === overIdValue);
        if (!overTask) {
            return undefined;
        }

        return getColumnId(overTask);
    };

    /** Responds to drag over events. */
    const handleDragOver = (event: DragOverEvent) => {
        const { over } = event;
        if (!over) {
            return;
        }

        const columnId = resolveColumnFromOverId(String(over.id));
        if (columnId) {
            setOverId(columnId);
        }
    };

    /** Responds to drag end events. */
    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(undefined);
        setOverId(undefined);

        if (!over) return;

        const taskId = String(active.id);
        const columnId = resolveColumnFromOverId(String(over.id));

        if (!columnId) {
            return;
        }

        const column = COLUMN_CONFIG.find((c) => c.id === columnId)!;
        const task = tasks.find((t) => t.number.toString() === taskId);
        if (task && getColumnId(task) !== columnId) {
            try {
                await moveTask.mutateAsync({
                    number: Number.parseInt(taskId),
                    columnLabel: column.label,
                });
            } catch (error_) {
                console.error("Failed to move task:", error_);
            }
        }
    };

    /** Responds to task click events. */
    const handleTaskClick = (task: Task) => {
        setSelectedTask(task);
    };

    /** Responds to move task events. */
    const handleMoveTask = async (task: Task, column: ColumnId) => {
        const col = COLUMN_CONFIG.find((c) => c.id === column)!;
        const updated = await moveTask.mutateAsync({
            number: task.number,
            columnLabel: col.label,
        });
        setSelectedTask(updated);
    };

    /** Responds to assign task events. */
    const handleAssignTask = async (task: Task, assignee: TaskAssigneeId) => {
        const updated = await assignTask.mutateAsync({
            number: task.number,
            assignee,
        });
        setSelectedTask(updated);
    };

    /** Responds to delete task events. */
    const handleDeleteTask = (task: Task) => {
        setPendingDeleteTaskId(task.number);
    };

    /**
     * Performs confirm delete task.
     * @param taskId Task identifier.
     */
    const confirmDeleteTask = async (taskId: number) => {
        try {
            await deleteTask.mutateAsync({ number: taskId });
            setPendingDeleteTaskId(undefined);
            setSelectedTask(undefined);
        } catch (error_) {
            console.error("Failed to delete task:", error_);
        }
    };

    /**
     * Responds to update task events.
     * @returns Promise that resolves after handling update task.
     */
    const handleUpdateTask = async (
        task: Task,
        updates: {
            title?: string;
            body?: string;
            labels?: string[];
            automation?: TaskAutomationInput | null | undefined;
        }
    ) => {
        const updated = await updateTask.mutateAsync({
            number: task.number,
            updates,
        });
        setSelectedTask(updated);
        return updated;
    };

    /** Responds to add task update events. */
    const handleAddTaskUpdate = async (task: Task, messageMd: string) => {
        await createTaskUpdate.mutateAsync({
            taskId: task.number,
            author: TASK_ASSIGNEES.raymond.id,
            messageMd,
        });
    };

    /** Responds to edit task update events. */
    const handleEditTaskUpdate = async (
        task: Task,
        updateId: number,
        messageMd: string
    ) => {
        await updateTaskUpdate.mutateAsync({
            taskId: task.number,
            updateId,
            messageMd,
        });
    };

    /** Responds to delete task update events. */
    const handleDeleteTaskUpdate = (task: Task, updateId: number) => {
        setPendingDeleteUpdate({ taskId: task.number, updateId });
    };

    /**
     * Performs confirm delete task update.
     * @param pendingDelete Pending delete value.
     */
    const confirmDeleteTaskUpdate = async (pendingDelete: {
        taskId: number;
        updateId: number;
    }) => {
        try {
            await deleteTaskUpdate.mutateAsync({
                taskId: pendingDelete.taskId,
                updateId: pendingDelete.updateId,
            });
            setPendingDeleteUpdate(undefined);
        } catch (error_) {
            console.error("Failed to delete task update:", error_);
        }
    };

    const activeTask = activeId
        ? tasks.find((t) => t.number.toString() === activeId)
        : undefined;

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState size="lg" />}
            error={
                tasksData === undefined && error
                    ? messageFromError(error, "Failed to load tasks")
                    : undefined
            }
            errorView={
                <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6">
                    <p className="text-red-400">
                        {messageFromError(error, "Failed to load tasks")}
                    </p>
                    <RefreshButton onClick={() => void refetch()} label="Retry" />
                </div>
            }
        >
            <DndContext
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={(event) => {
                    void handleDragEnd(event);
                }}
            >
                <div className="flex h-full min-h-0 flex-col p-3 sm:p-4 lg:p-6">
                    {error && tasksData !== undefined && (
                        <Alert variant="warning" className="mb-4">
                            Task refresh failed. Showing the last loaded tasks.{" "}
                            {messageFromError(error, "Task refresh failed")}
                        </Alert>
                    )}

                    <TaskBoardToolbar
                        assigneeFilter={filter}
                        automationFilter={automationFilter}
                        hasActiveFilters={hasActiveFilters}
                        isEmpty={filteredTasks.length === 0}
                        isLoading={isLoading}
                        onAssigneeFilterChange={setFilter}
                        onAutomationFilterChange={setAutomationFilter}
                        onClearFilters={() => {
                            setSearch("");
                            setFilter("all");
                            setAutomationFilter("all");
                        }}
                        onCreateTask={() => setIsNewTaskOpen(true)}
                        onRefresh={() => void refetch()}
                        onSearchChange={setSearch}
                        search={search}
                    />

                    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4 lg:flex-row lg:overflow-x-auto lg:overflow-y-hidden">
                        {COLUMN_CONFIG.map((column) => (
                            <TaskColumn
                                key={column.id}
                                id={column.id}
                                tasks={tasksByColumn[column.id]}
                                isOver={overId === column.id}
                                onTaskClick={handleTaskClick}
                            />
                        ))}
                    </div>

                    {selectedTask && (
                        <TaskDetailModal
                            key={selectedTask.number}
                            task={selectedTask}
                            onClose={() => setSelectedTask(undefined)}
                            onMove={(column) => handleMoveTask(selectedTask, column)}
                            onAssign={(assignee) =>
                                handleAssignTask(selectedTask, assignee)
                            }
                            onDelete={() => handleDeleteTask(selectedTask)}
                            onUpdate={(updates) =>
                                handleUpdateTask(selectedTask, updates)
                            }
                            updates={taskUpdates}
                            onAddUpdate={(messageMd) =>
                                handleAddTaskUpdate(selectedTask, messageMd)
                            }
                            onEditUpdate={(updateId, messageMd) =>
                                handleEditTaskUpdate(selectedTask, updateId, messageMd)
                            }
                            onDeleteUpdate={(updateId) =>
                                handleDeleteTaskUpdate(selectedTask, updateId)
                            }
                        />
                    )}

                    {isNewTaskOpen && (
                        <NewTaskModal
                            isOpen={isNewTaskOpen}
                            onClose={() => setIsNewTaskOpen(false)}
                            onSubmit={async (
                                title,
                                body,
                                priority,
                                assignee,
                                automation
                            ) => {
                                const labels = [];
                                if (priority) labels.push(`priority-${priority}`);
                                await createTask.mutateAsync({
                                    title,
                                    body: body || "",
                                    labels,
                                    assignee: assignee || TASK_ASSIGNEES.mira.id,
                                    automation,
                                });
                                setIsNewTaskOpen(false);
                            }}
                        />
                    )}

                    <DragOverlay>
                        {activeTask && <TaskOverlay task={activeTask} />}
                    </DragOverlay>

                    {pendingDeleteTaskId !== undefined && (
                        <ConfirmModal
                            isOpen
                            title="Delete task"
                            message={`Are you sure you want to delete task #${pendingDeleteTaskId}?`}
                            confirmLabel="Delete"
                            confirmLoadingLabel="Deleting..."
                            loading={deleteTask.isPending}
                            danger
                            onCancel={() => setPendingDeleteTaskId(undefined)}
                            onConfirm={() => {
                                void confirmDeleteTask(pendingDeleteTaskId);
                            }}
                        />
                    )}

                    {pendingDeleteUpdate && (
                        <ConfirmModal
                            isOpen
                            title="Delete progress update"
                            message="Are you sure you want to delete this progress update?"
                            confirmLabel="Delete"
                            confirmLoadingLabel="Deleting..."
                            loading={deleteTaskUpdate.isPending}
                            danger
                            onCancel={() => setPendingDeleteUpdate(undefined)}
                            onConfirm={() => {
                                void confirmDeleteTaskUpdate(pendingDeleteUpdate);
                            }}
                        />
                    )}
                </div>
            </DndContext>
        </PageState>
    );
}
