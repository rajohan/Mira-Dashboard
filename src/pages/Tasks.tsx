import {
    DndContext,
    type DragEndEvent,
    type DragOverEvent,
    DragOverlay,
    type DragStartEvent,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
    COLUMN_CONFIG,
    getColumnId,
    NewTaskModal,
    TaskColumn,
    TaskDetailModal,
    TaskOverlay,
} from "../components/features/tasks";
import { Button } from "../components/ui/Button";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { RefreshButton } from "../components/ui/RefreshButton";
import { SearchInput } from "../components/ui/SearchInput";
import { TASK_ASSIGNEES, type TaskAssigneeId } from "../constants/taskActors";
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
} from "../hooks";
import type { ColumnId, Task, TaskAutomation } from "../types/task";
import {
    getPriority,
    getTaskUpdatedAtMs,
    taskMatchesSearch,
} from "../utils/taskUtilities";

const ASSIGNMENT_FILTERS = [
    { value: "all", label: "All" },
    { value: TASK_ASSIGNEES.mira.id, label: TASK_ASSIGNEES.mira.label },
    { value: TASK_ASSIGNEES.raymond.id, label: TASK_ASSIGNEES.raymond.label },
] as const;

/** Renders the tasks UI. */
export function Tasks() {
    const { data: tasks = [], isLoading, error, refetch } = useTasks();
    const moveTask = useMoveTask();
    const createTask = useCreateTask();
    const assignTask = useAssignTask();
    const deleteTask = useDeleteTask();
    const updateTask = useUpdateTask();
    const createTaskUpdate = useCreateTaskUpdate();
    const updateTaskUpdate = useUpdateTaskUpdate();
    const deleteTaskUpdate = useDeleteTaskUpdate();

    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"all" | TaskAssigneeId>("all");
    const [activeId, setActiveId] = useState<string | undefined>(undefined);
    const [overId, setOverId] = useState<ColumnId | undefined>(undefined);
    const [selectedTask, setSelectedTask] = useState<Task | undefined>(undefined);
    const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
    const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<number | undefined>(
        undefined
    );
    const [pendingDeleteUpdate, setPendingDeleteUpdate] = useState<
        | undefined
        | {
              taskId: number;
              updateId: number;
          }
    >(undefined);

    const { data: taskUpdates = [] } = useTaskUpdates(selectedTask?.number ?? undefined);

    const filteredTasks = tasks.filter((task) => {
        const matchesFilter =
            filter === "all" ||
            task.assignees.some((a) => (a.login || a.name) === filter);
        const matchesSearch = taskMatchesSearch(task, search);
        return matchesFilter && matchesSearch;
    });
    const hasActiveFilters = search.trim().length > 0 || filter !== "all";

    const tasksByColumn: Record<ColumnId, Task[]> = {
        todo: [],
        "in-progress": [],
        blocked: [],
        done: [],
    };

    for (const col of COLUMN_CONFIG) {
        tasksByColumn[col.id] = filteredTasks
            .filter((task) => Reflect.apply(col.filter, undefined, [task]) as boolean)
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

    /** Performs resolve column from over ID. */
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
    const handleDeleteTask = async (task: Task) => {
        setPendingDeleteTaskId(task.number);
    };

    /** Performs confirm delete task. */
    const confirmDeleteTask = async (taskId: number) => {
        try {
            await deleteTask.mutateAsync({ number: taskId });
            setPendingDeleteTaskId(undefined);
            setSelectedTask(undefined);
        } catch (error_) {
            console.error("Failed to delete task:", error_);
        }
    };

    /** Responds to update task events. */
    const handleUpdateTask = async (
        task: Task,
        updates: {
            title?: string;
            body?: string;
            labels?: string[];
            automation?:
                | Pick<TaskAutomation, "cronJobId" | "scheduleSummary" | "sessionTarget">
                | undefined;
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
            author: TASK_ASSIGNEES.raymond.id,
            messageMd,
        });
    };

    /** Responds to delete task update events. */
    const handleDeleteTaskUpdate = async (task: Task, updateId: number) => {
        setPendingDeleteUpdate({ taskId: task.number, updateId });
    };

    /** Performs confirm delete task update. */
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
            error={error?.message ?? undefined}
            errorView={
                <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6">
                    <p className="text-red-400">{error?.message}</p>
                    <RefreshButton onClick={() => void refetch()} label="Retry" />
                </div>
            }
        >
            <DndContext
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
            >
                <div className="flex h-full min-h-0 flex-col p-3 sm:p-4 lg:p-6">
                    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:gap-4">
                            <SearchInput
                                value={search}
                                onChange={setSearch}
                                placeholder="Search tasks..."
                                clearLabel="Clear task search"
                            />
                            <FilterButtonGroup
                                options={ASSIGNMENT_FILTERS}
                                value={filter}
                                onChange={setFilter}
                            />
                        </div>

                        <div className="grid grid-cols-[1fr_auto] items-center gap-2 sm:flex sm:justify-end">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => setIsNewTaskOpen(true)}
                                className="w-full sm:w-auto"
                            >
                                <Plus className="h-4 w-4" />
                                New Task
                            </Button>
                            <RefreshButton
                                onClick={() => void refetch()}
                                isLoading={isLoading}
                                label=""
                                variant="secondary"
                            />
                        </div>
                    </div>

                    {filteredTasks.length === 0 && (
                        <div className="border-primary-700 bg-primary-800/60 mb-4 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                                <p className="text-primary-100 text-sm font-medium">
                                    {hasActiveFilters
                                        ? "No tasks match the current filters."
                                        : "No tasks yet."}
                                </p>
                                <p className="text-primary-300 mt-1 text-xs">
                                    {hasActiveFilters
                                        ? "Clear search and assignee filters to return to the full board."
                                        : "Create a task when there is new work to track."}
                                </p>
                            </div>
                            {hasActiveFilters && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setSearch("");
                                        setFilter("all");
                                    }}
                                    className="w-full sm:w-auto"
                                >
                                    Clear filters
                                </Button>
                            )}
                        </div>
                    )}

                    <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-4 lg:flex-row lg:overflow-x-auto">
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
