import {
    DndContext,
    type DragEndEvent,
    type DragOverEvent,
    DragOverlay,
    type DragStartEvent,
} from "@dnd-kit/core";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/Button";
import {
    TaskColumn,
    TaskDetailModal,
    TaskOverlay,
    NewTaskModal,
    COLUMN_CONFIG,
    getColumnId,
} from "../components/features/tasks";
import { useTasks, useMoveTask, useCreateTask } from "../hooks";

import type { Task, ColumnId } from "../types/task";

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
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
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
                    } catch (err) {
                        console.error("Failed to move task:", err);
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

    const activeTask = activeId ? tasks.find((t) => t.number.toString() === activeId) : null;

    if (isLoading) {
        return (
            <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-6">
                <RefreshCw className="h-6 w-6 animate-spin text-slate-400" />
            </div>
        );
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
        <DndContext onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
            <div className="flex h-full flex-col p-6">
                <div className="mb-4 flex items-center justify-between">
                    <h1 className="text-2xl font-bold">Tasks</h1>
                    <div className="flex items-center gap-2">
                        <Button variant="primary" size="sm" onClick={() => setIsNewTaskOpen(true)}>
                            <Plus className="h-4 w-4" />
                            New Task
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => refetch()}>
                            <RefreshCw className={"h-4 w-4 " + (isLoading ? "animate-spin" : "")} />
                        </Button>
                    </div>
                </div>

                <div className="mb-4 flex items-center gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Search tasks..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full rounded-lg border border-slate-600 bg-slate-700 py-2 pl-10 pr-4 text-sm text-slate-100 focus:border-accent-500 focus:outline-none"
                        />
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant={filter === "all" ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setFilter("all")}
                        >
                            All
                        </Button>
                        <Button
                            variant={filter === "mira-2026" ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setFilter("mira-2026")}
                        >
                            Mira
                        </Button>
                        <Button
                            variant={filter === "rajohan" ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setFilter("rajohan")}
                        >
                            Raymond
                        </Button>
                    </div>
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
                            await createTask.mutateAsync({ title, body: body || "", labels });
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