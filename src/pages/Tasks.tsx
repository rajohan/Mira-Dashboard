import {
    DndContext,
    type DragEndEvent,
    type DragOverEvent,
    DragOverlay,
    type DragStartEvent,
} from "@dnd-kit/core";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { TaskColumn } from "../components/features/tasks/TaskColumn";
import { TaskDetailModal } from "../components/features/tasks/TaskDetailModal";
import { TaskOverlay } from "../components/features/tasks/TaskOverlay";
import { NewTaskModal } from "../components/features/tasks/NewTaskModal";
import { COLUMN_CONFIG, getColumnId } from "../components/features/tasks/taskUtils";

import type { Task, ColumnId } from "../types/task";

export function Tasks() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"all" | "mira-2026" | "rajohan">("all");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<ColumnId | null>(null);
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);

    const fetchTasks = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/exec", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    command: "gh",
                    args: [
                        "issue",
                        "list",
                        "--repo",
                        "rajohan/Mira-Workspace",
                        "--limit",
                        "50",
                        "--json",
                        "number,title,body,state,labels,assignees,createdAt,updatedAt,url",
                    ],
                }),
            });
            if (!res.ok) throw new Error("Failed to fetch tasks");
            const data = await res.json();
            setTasks(data.stdout ? JSON.parse(data.stdout) : []);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTasks();
    }, []);

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
        todo: filteredTasks.filter(COLUMN_CONFIG.todo.filter),
        "in-progress": filteredTasks.filter(COLUMN_CONFIG["in-progress"].filter),
        blocked: filteredTasks.filter(COLUMN_CONFIG.blocked.filter),
        done: filteredTasks.filter(COLUMN_CONFIG.done.filter),
    };

    const activeTask = activeId
        ? tasks.find((t) => `task-${t.number}` === activeId)
        : null;

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string);
    };

    const handleDragOver = (event: DragOverEvent) => {
        const { over } = event;
        if (over) {
            const columnId = over.id.toString() as ColumnId;
            if (COLUMN_CONFIG[columnId]) {
                setOverId(columnId);
            }
        } else {
            setOverId(null);
        }
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);
        setOverId(null);

        if (!over) return;

        const taskId = active.id.toString().replace("task-", "");
        const targetColumn = over.id.toString() as ColumnId;

        if (!COLUMN_CONFIG[targetColumn]) return;

        const task = tasks.find((t) => t.number.toString() === taskId);
        if (!task) return;

        const currentColumn = getColumnId(task);

        if (currentColumn === targetColumn) return;

        await moveTask(task, targetColumn);
    };

    const moveTask = async (task: Task, targetColumn: ColumnId) => {
        // Optimistic update
        setTasks((prev) =>
            prev.map((t) => {
                if (t.number !== task.number) return t;

                const newLabels = t.labels.filter(
                    (l) => l.name !== "blocked" && l.name !== "in-progress"
                );

                if (targetColumn === "in-progress") {
                    newLabels.push({ name: "in-progress" });
                } else if (targetColumn === "blocked") {
                    newLabels.push({ name: "blocked" });
                }

                return {
                    ...t,
                    labels: newLabels,
                    state: targetColumn === "done" ? "CLOSED" : "OPEN",
                };
            })
        );

        try {
            const labelToAdd =
                targetColumn === "in-progress"
                    ? "in-progress"
                    : targetColumn === "blocked"
                      ? "blocked"
                      : null;

            const currentColumn = getColumnId(task);

            const labelToRemove =
                currentColumn === "in-progress"
                    ? "in-progress"
                    : currentColumn === "blocked"
                      ? "blocked"
                      : null;

            if (labelToRemove) {
                await fetch("/api/exec", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        command: "gh",
                        args: [
                            "issue",
                            "edit",
                            task.number.toString(),
                            "--repo",
                            "rajohan/Mira-Workspace",
                            "--remove-label",
                            labelToRemove,
                        ],
                    }),
                });
            }

            if (labelToAdd) {
                await fetch("/api/exec", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        command: "gh",
                        args: [
                            "issue",
                            "edit",
                            task.number.toString(),
                            "--repo",
                            "rajohan/Mira-Workspace",
                            "--add-label",
                            labelToAdd,
                        ],
                    }),
                });
            }

            if (targetColumn === "done") {
                await fetch("/api/exec", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        command: "gh",
                        args: [
                            "issue",
                            "close",
                            task.number.toString(),
                            "--repo",
                            "rajohan/Mira-Workspace",
                        ],
                    }),
                });
            }

            if (currentColumn === "done" && targetColumn !== "done") {
                await fetch("/api/exec", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        command: "gh",
                        args: [
                            "issue",
                            "reopen",
                            task.number.toString(),
                            "--repo",
                            "rajohan/Mira-Workspace",
                        ],
                    }),
                });
            }
        } catch (error_) {
            console.error("Failed to update task:", error_);
            fetchTasks();
        }
    };

    const createTask = async (
        title: string,
        body?: string,
        priority?: "high" | "medium" | "low"
    ) => {
        const priorityLabel = priority ? `priority-${priority}` : null;
        const labels = priorityLabel ? [priorityLabel] : [];

        const args = [
            "issue",
            "create",
            "--repo",
            "rajohan/Mira-Workspace",
            "--title",
            title,
        ];

        if (body) {
            args.push("--body", body);
        }

        if (labels.length > 0) {
            args.push("--label", labels.join(","));
        }

        await fetch("/api/exec", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                command: "gh",
                args,
            }),
        });

        fetchTasks();
    };

    return (
        <div className="p-6">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold text-slate-100">Tasks</h1>
                <div className="flex items-center gap-4">
                    <Button variant="primary" onClick={() => setIsNewTaskOpen(true)}>
                        <Plus className="h-4 w-4" />
                        New Task
                    </Button>
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as typeof filter)}
                        className="rounded-lg border border-slate-600 bg-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:border-accent-500 focus:outline-none"
                    >
                        <option value="all">All Tasks</option>
                        <option value="mira-2026">Assigned to Mira</option>
                        <option value="rajohan">Assigned to Raymond</option>
                    </select>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Search..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-48 rounded-lg border border-slate-600 bg-slate-700 py-1.5 pl-9 pr-3 text-sm text-slate-100 focus:border-accent-500 focus:outline-none"
                        />
                    </div>
                    <Button variant="secondary" onClick={fetchTasks} disabled={loading}>
                        <RefreshCw
                            className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                        />
                    </Button>
                </div>
            </div>

            {error && (
                <Card className="mb-4 border-red-500/50 bg-red-500/10 p-4">
                    <p className="text-red-400">Error: {error}</p>
                </Card>
            )}

            <DndContext
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
            >
                <div className="flex gap-4 overflow-x-auto">
                    {(Object.keys(COLUMN_CONFIG) as ColumnId[]).map((columnId) => (
                        <TaskColumn
                            key={columnId}
                            id={columnId}
                            tasks={tasksByColumn[columnId]}
                            isOver={overId === columnId}
                            onTaskClick={setSelectedTask}
                        />
                    ))}
                </div>

                <DragOverlay>
                    {activeTask ? <TaskOverlay task={activeTask} /> : null}
                </DragOverlay>
            </DndContext>

            <TaskDetailModal
                task={selectedTask}
                onClose={() => setSelectedTask(null)}
                onMove={async (column) => {
                    if (selectedTask) {
                        await moveTask(selectedTask, column);
                        setSelectedTask(null);
                    }
                }}
            />

            <NewTaskModal
                isOpen={isNewTaskOpen}
                onClose={() => setIsNewTaskOpen(false)}
                onSubmit={createTask}
            />
        </div>
    );
}