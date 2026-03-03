import {
    DndContext,
    type DragEndEvent,
    type DragOverEvent,
    DragOverlay,
    type DragStartEvent,
} from "@dnd-kit/core";
import { Plus, RefreshCw, Search } from "lucide-react";
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
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { LoadingState } from "../components/ui/LoadingState";
import { PageHeader } from "../components/ui/PageHeader";
import { useCreateTask, useMoveTask, useTasks } from "../hooks";
import type { ColumnId, Task } from "../types/task";

const ASSIGNMENT_FILTERS = [
    { value: "all", label: "All" },
    { value: "mira-2026", label: "Mira" },
    { value: "rajohan", label: "Raymond" },
] as const;

export function Tasks() {
    const { data: tasks = [], isLoading, error, refetch } = useTasks();
    const moveTask = useMoveTask();
    const createTask = useCreateTask();

    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"all" | "mira-2026" | "rajohan">("all");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<ColumnId | null>(null);
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);

    const filteredTasks = tasks.filter((task) => {
        const matchesFilter =
            filter === "all" ||
            task.assignees.some((a) => (a.login || a.name) === filter);
        const matchesSearch =
            search === "" ||
            task.title.toLowerCase().includes(search.toLowerCase()) ||
            task.number.toString().includes(search);
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
            .sort(
                (a, b) =>
                    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            );
    }

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string);
    };

    const handleDragOver = (event: DragOverEvent) => {
        const { over } = event;
        if (over) {
            const columnId = getColumnId(over.id as string);
            if (columnId) {
                setOverId(columnId);
            }
        }
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);
        setOverId(null);

        if (!over) return;

        const taskId = active.id as string;
        const columnId = getColumnId(over.id as string);

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
            await moveTask.mutateAsync({
                number: selectedTask.number,
                columnLabel: col.label,
            });
        }
    };

    const activeTask = activeId
        ? tasks.find((t) => t.number.toString() === activeId)
        : null;

    if (isLoading) {
        return <LoadingState size="lg" />;
    }

    if (error) {
        return (
            <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
                <p className="text-red-400">{error.message}</p>
                <Button variant="secondary" onClick={() => refetch()}>
                    <RefreshCw className="h-4 w-4" />
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <DndContext
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
        >
            <div className="flex h-full flex-col p-6">
                <PageHeader
                    title="Tasks"
                    actions={
                        <>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => setIsNewTaskOpen(true)}
                            >
                                <Plus className="h-4 w-4" />
                                New Task
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => refetch()}
                            >
                                <RefreshCw
                                    className={
                                        "h-4 w-4 " + (isLoading ? "animate-spin" : "")
                                    }
                                />
                            </Button>
                        </>
                    }
                />

                <div className="mb-4 flex items-center gap-4">
                    <div className="relative max-w-md flex-1">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Search tasks..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full rounded-lg border border-slate-600 bg-slate-700 py-2 pl-10 pr-4 text-sm text-slate-100 focus:border-accent-500 focus:outline-none"
                        />
                    </div>
                    <FilterButtonGroup
                        options={ASSIGNMENT_FILTERS}
                        value={filter}
                        onChange={setFilter}
                    />
                </div>

                <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
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
                    />
                )}

                {isNewTaskOpen && (
                    <NewTaskModal
                        isOpen={isNewTaskOpen}
                        onClose={() => setIsNewTaskOpen(false)}
                        onSubmit={async (title, body, priority) => {
                            const labels = [];
                            if (priority) labels.push(`priority-${priority}`);
                            await createTask.mutateAsync({
                                title,
                                body: body || "",
                                labels,
                            });
                            setIsNewTaskOpen(false);
                        }}
                    />
                )}

                <DragOverlay>
                    {activeTask && <TaskOverlay task={activeTask} />}
                </DragOverlay>
            </div>
        </DndContext>
    );
}
