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
import { getPriority } from "../utils/taskUtils";

const ASSIGNMENT_FILTERS = [
    { value: "all", label: "All" },
    { value: TASK_ASSIGNEES.mira.id, label: TASK_ASSIGNEES.mira.label },
    { value: TASK_ASSIGNEES.raymond.id, label: TASK_ASSIGNEES.raymond.label },
] as const;

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
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<ColumnId | null>(null);
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
    const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<number | null>(null);
    const [pendingDeleteUpdateId, setPendingDeleteUpdateId] = useState<number | null>(
        null
    );

    const { data: taskUpdates = [] } = useTaskUpdates(selectedTask?.number ?? null);

    const filteredTasks = tasks.filter((task) => {
        const matchesFilter =
            filter === "all" ||
            task.assignees.some((a) => (a.login || a.name) === filter);
        const normalizedSearch = search.toLowerCase();
        const matchesSearch =
            search === "" ||
            task.title.toLowerCase().includes(normalizedSearch) ||
            task.number.toString().includes(search) ||
            task.automation?.cronJobId.toLowerCase().includes(normalizedSearch) ||
            task.automation?.jobName?.toLowerCase().includes(normalizedSearch);
        return matchesFilter && matchesSearch;
    });

    const tasksByColumn: Record<ColumnId, Task[]> = {
        todo: [],
        "in-progress": [],
        blocked: [],
        done: [],
    };

    for (const col of COLUMN_CONFIG) {
        tasksByColumn[col.id] = filteredTasks
            .filter((task) => col.filter(task))
            .sort((a, b) => {
                const rank = { high: 0, medium: 1, low: 2 };
                const priorityDiff =
                    rank[getPriority(a.labels)] - rank[getPriority(b.labels)];
                if (priorityDiff !== 0) {
                    return priorityDiff;
                }

                return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
            });
    }

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string);
    };

    const resolveColumnFromOverId = (overIdValue: string): ColumnId | null => {
        const directColumn = getColumnId(overIdValue);
        if (directColumn) {
            return directColumn;
        }

        const overTask = tasks.find((task) => String(task.number) === overIdValue);
        if (!overTask) {
            return null;
        }

        return getColumnId(overTask);
    };

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

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);
        setOverId(null);

        if (!over) return;

        const taskId = String(active.id);
        const columnId = resolveColumnFromOverId(String(over.id));

        if (columnId) {
            const column = COLUMN_CONFIG.find((c) => c.id === columnId);
            if (column) {
                const task = tasks.find((t) => t.number.toString() === taskId);
                if (task && !task.labels.some((l) => l.name === column.label)) {
                    try {
                        await moveTask.mutateAsync({
                            number: Number.parseInt(taskId),
                            columnLabel: column.label,
                        });
                    } catch (error_) {
                        console.error("Failed to move task:", error_);
                    }
                }
            }
        }
    };

    const handleTaskClick = (task: Task) => {
        setSelectedTask(task);
    };

    const handleMoveTask = async (column: ColumnId) => {
        if (!selectedTask) return;
        const col = COLUMN_CONFIG.find((c) => c.id === column);
        if (col) {
            const updated = await moveTask.mutateAsync({
                number: selectedTask.number,
                columnLabel: col.label,
            });
            setSelectedTask(updated);
        }
    };

    const handleAssignTask = async (assignee: TaskAssigneeId) => {
        if (!selectedTask) return;
        const updated = await assignTask.mutateAsync({
            number: selectedTask.number,
            assignee,
        });
        setSelectedTask(updated);
    };

    const handleDeleteTask = async () => {
        if (!selectedTask) return;
        setPendingDeleteTaskId(selectedTask.number);
    };

    const confirmDeleteTask = async () => {
        if (!pendingDeleteTaskId) return;
        await deleteTask.mutateAsync({ number: pendingDeleteTaskId });
        setPendingDeleteTaskId(null);
        setSelectedTask(null);
    };

    const handleUpdateTask = async (updates: {
        title?: string;
        body?: string;
        labels?: string[];
        automation?: Pick<
            TaskAutomation,
            "cronJobId" | "scheduleSummary" | "sessionTarget"
        > | null;
    }) => {
        if (!selectedTask) {
            throw new Error("No selected task");
        }

        const updated = await updateTask.mutateAsync({
            number: selectedTask.number,
            updates,
        });
        setSelectedTask(updated);
        return updated;
    };

    const handleAddTaskUpdate = async (messageMd: string) => {
        if (!selectedTask) return;

        await createTaskUpdate.mutateAsync({
            taskId: selectedTask.number,
            author: TASK_ASSIGNEES.raymond.id,
            messageMd,
        });
    };

    const handleEditTaskUpdate = async (updateId: number, messageMd: string) => {
        if (!selectedTask) return;

        await updateTaskUpdate.mutateAsync({
            taskId: selectedTask.number,
            updateId,
            author: TASK_ASSIGNEES.raymond.id,
            messageMd,
        });
    };

    const handleDeleteTaskUpdate = async (updateId: number) => {
        setPendingDeleteUpdateId(updateId);
    };

    const confirmDeleteTaskUpdate = async () => {
        if (!selectedTask || !pendingDeleteUpdateId) return;

        await deleteTaskUpdate.mutateAsync({
            taskId: selectedTask.number,
            updateId: pendingDeleteUpdateId,
        });
        setPendingDeleteUpdateId(null);
    };

    const activeTask = activeId
        ? tasks.find((t) => t.number.toString() === activeId)
        : null;

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState size="lg" />}
            error={error?.message ?? null}
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

                    <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-4 lg:flex-row lg:overflow-x-auto">
                        {COLUMN_CONFIG.map((column) => (
                            <TaskColumn
                                key={column.id}
                                id={column.id}
                                tasks={tasksByColumn[column.id] || []}
                                isOver={overId === column.id}
                                onTaskClick={handleTaskClick}
                            />
                        ))}
                    </div>

                    {selectedTask && (
                        <TaskDetailModal
                            task={selectedTask}
                            onClose={() => setSelectedTask(null)}
                            onMove={handleMoveTask}
                            onAssign={handleAssignTask}
                            onDelete={handleDeleteTask}
                            onUpdate={handleUpdateTask}
                            updates={taskUpdates}
                            onAddUpdate={handleAddTaskUpdate}
                            onEditUpdate={handleEditTaskUpdate}
                            onDeleteUpdate={handleDeleteTaskUpdate}
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

                    <ConfirmModal
                        isOpen={pendingDeleteTaskId !== null}
                        title="Delete task"
                        message={`Are you sure you want to delete task #${pendingDeleteTaskId ?? ""}?`}
                        confirmLabel="Delete"
                        danger
                        onCancel={() => setPendingDeleteTaskId(null)}
                        onConfirm={() => {
                            void confirmDeleteTask();
                        }}
                    />

                    <ConfirmModal
                        isOpen={pendingDeleteUpdateId !== null}
                        title="Delete progress update"
                        message="Are you sure you want to delete this progress update?"
                        confirmLabel="Delete"
                        danger
                        onCancel={() => setPendingDeleteUpdateId(null)}
                        onConfirm={() => {
                            void confirmDeleteTaskUpdate();
                        }}
                    />
                </div>
            </DndContext>
        </PageState>
    );
}
