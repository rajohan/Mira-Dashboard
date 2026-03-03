import {
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    type DragOverEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
    AlertCircle,
    CheckCircle2,
    Circle,
    ExternalLink,
    GripVertical,
    Loader2,
    RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

interface Task {
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login?: string; name?: string }>;
    createdAt: string;
    updatedAt: string;
    url: string;
}

type ColumnId = "todo" | "in-progress" | "blocked" | "done";

const COLUMN_CONFIG: Record<
    ColumnId,
    { title: string; icon: React.ReactNode; filter: (t: Task) => boolean }
> = {
    todo: {
        title: "To Do",
        icon: <Circle className="h-4 w-4 text-slate-400" />,
        filter: (t) =>
            t.state === "OPEN" &&
            !t.labels.some((l) => l.name === "blocked") &&
            !t.labels.some((l) => l.name === "in-progress"),
    },
    "in-progress": {
        title: "In Progress",
        icon: <Loader2 className="h-4 w-4 text-blue-400" />,
        filter: (t) =>
            t.state === "OPEN" && t.labels.some((l) => l.name === "in-progress"),
    },
    blocked: {
        title: "Blocked",
        icon: <AlertCircle className="h-4 w-4 text-red-400" />,
        filter: (t) => t.state === "OPEN" && t.labels.some((l) => l.name === "blocked"),
    },
    done: {
        title: "Done",
        icon: <CheckCircle2 className="h-4 w-4 text-green-400" />,
        filter: (t) => t.state === "CLOSED",
    },
};

function TaskCard({ task, isDragging }: { task: Task; isDragging?: boolean }) {
    const { attributes, listeners, setNodeRef, transform } = useSortable({
        id: `task-${task.number}`,
    });

    const style = transform
        ? {
              transform: CSS.Translate.toString(transform),
              zIndex: isDragging ? 50 : undefined,
          }
        : undefined;

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            className={
                "group flex items-center gap-2 border-b border-slate-700/50 px-4 py-3 transition-colors last:border-b-0 hover:bg-slate-800/50 " +
                (isDragging
                    ? "cursor-grabbing bg-slate-800 opacity-80"
                    : "cursor-pointer")
            }
            onClick={() => window.open(task.url, "_blank")}
        >
            <button
                {...listeners}
                className="flex-shrink-0 cursor-grab text-slate-500 opacity-0 transition-opacity hover:text-slate-300 group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <GripVertical className="h-4 w-4" />
            </button>
            <div className="flex-shrink-0">
                {task.state === "CLOSED" ? (
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                ) : task.labels.some((l) => l.name === "blocked") ? (
                    <AlertCircle className="h-5 w-5 text-red-400" />
                ) : task.labels.some((l) => l.name === "in-progress") ? (
                    <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                ) : (
                    <Circle className="h-5 w-5 text-slate-400" />
                )}
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">
                    #{task.number}: {task.title}
                </p>
                <div className="mt-1 flex items-center gap-2">
                    {task.labels.slice(0, 3).map((label) => (
                        <span
                            key={label.name}
                            className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
                        >
                            {label.name}
                        </span>
                    ))}
                    {task.assignees.length > 0 && (
                        <span className="text-xs text-slate-500">
                            @{task.assignees[0].login || task.assignees[0].name}
                        </span>
                    )}
                </div>
            </div>
            <ExternalLink className="h-4 w-4 flex-shrink-0 text-slate-500" />
        </div>
    );
}

function TaskOverlay({ task }: { task: Task }) {
    return (
        <div className="flex items-center gap-2 rounded-lg border border-accent-500/50 bg-slate-800 px-4 py-3 shadow-xl">
            <GripVertical className="h-4 w-4 flex-shrink-0 text-slate-500" />
            <div className="flex-shrink-0">
                {task.state === "CLOSED" ? (
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                ) : task.labels.some((l) => l.name === "blocked") ? (
                    <AlertCircle className="h-5 w-5 text-red-400" />
                ) : task.labels.some((l) => l.name === "in-progress") ? (
                    <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                ) : (
                    <Circle className="h-5 w-5 text-slate-400" />
                )}
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">
                    #{task.number}: {task.title}
                </p>
            </div>
        </div>
    );
}

function Column({ id, tasks, isOver }: { id: ColumnId; tasks: Task[]; isOver: boolean }) {
    const config = COLUMN_CONFIG[id];

    return (
        <div
            className={
                "flex flex-col rounded-lg transition-colors " +
                (isOver ? "bg-accent-500/10" : "")
            }
        >
            <div className="mb-3 flex items-center gap-2">
                {config.icon}
                <h2 className="text-sm font-semibold text-slate-300">{config.title}</h2>
                <span className="text-xs text-slate-500">({tasks.length})</span>
            </div>
            <div
                data-column={id}
                className="flex-1 rounded-lg border border-slate-700/50 bg-slate-800/30"
            >
                {tasks.length > 0 ? (
                    tasks.map((task) => <TaskCard key={task.number} task={task} />)
                ) : (
                    <div className="p-4 text-center text-sm text-slate-500">No tasks</div>
                )}
            </div>
        </div>
    );
}

export function Tasks() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<"all" | "mira-2026" | "rajohan">("all");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<ColumnId | null>(null);

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
                        "number,title,state,labels,assignees,createdAt,updatedAt,url",
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
        if (filter === "all") return true;
        return task.assignees.some((a) => (a.login || a.name) === filter);
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
        const targetColumn = over.id as ColumnId;

        if (!COLUMN_CONFIG[targetColumn]) return;

        const task = tasks.find((t) => t.number.toString() === taskId);
        if (!task) return;

        // Determine current column
        const currentColumn: ColumnId = task.labels.some((l) => l.name === "blocked")
            ? "blocked"
            : task.labels.some((l) => l.name === "in-progress")
              ? "in-progress"
              : task.state === "CLOSED"
                ? "done"
                : "todo";

        if (currentColumn === targetColumn) return;

        // Optimistic update
        setTasks((prev) =>
            prev.map((t) => {
                if (t.number.toString() !== taskId) return t;

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

        // Call API to update task status
        try {
            const labelToAdd =
                targetColumn === "in-progress"
                    ? "in-progress"
                    : targetColumn === "blocked"
                      ? "blocked"
                      : null;

            const labelToRemove =
                currentColumn === "in-progress"
                    ? "in-progress"
                    : currentColumn === "blocked"
                      ? "blocked"
                      : null;

            // Remove old label if exists
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

            // Add new label if needed
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

            // Close issue if moved to done
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

            // Reopen issue if moved from done
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
            // Revert on error
            fetchTasks();
        }
    };

    return (
        <div className="space-y-6 p-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-slate-100">Tasks</h1>
                <div className="flex items-center gap-3">
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as typeof filter)}
                        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        <option value="all">All Tasks</option>
                        <option value="mira-2026">Assigned to Mira</option>
                        <option value="rajohan">Assigned to Raymond</option>
                    </select>
                    <Button variant="secondary" onClick={fetchTasks} disabled={loading}>
                        <RefreshCw
                            className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                        />
                    </Button>
                </div>
            </div>

            {error && (
                <Card className="border-red-800 bg-red-900/20 p-4">
                    <p className="text-red-400">Error: {error}</p>
                </Card>
            )}

            <DndContext
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
            >
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                    {(Object.keys(COLUMN_CONFIG) as ColumnId[]).map((columnId) => (
                        <Column
                            key={columnId}
                            id={columnId}
                            tasks={tasksByColumn[columnId]}
                            isOver={overId === columnId}
                        />
                    ))}
                </div>

                <DragOverlay>
                    {activeTask ? <TaskOverlay task={activeTask} /> : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
}
