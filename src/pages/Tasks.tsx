import {
    DndContext,
    type DragEndEvent,
    type DragOverEvent,
    DragOverlay,
    type DragStartEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { format, formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";
import { ExternalLink, GripVertical, Plus, RefreshCw, Search, X, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";

interface Task {
    number: number;
    title: string;
    body?: string;
    state: string;
    labels: Array<{ name: string; color?: string }>;
    assignees: Array<{ login?: string; name?: string; avatar_url?: string }>;
    createdAt: string;
    updatedAt: string;
    url: string;
}

type ColumnId = "todo" | "in-progress" | "blocked" | "done";

interface ColumnConfig {
    title: string;
    dotColor: string;
    filter: (t: Task) => boolean;
}

const COLUMN_CONFIG: Record<ColumnId, ColumnConfig> = {
    todo: {
        title: "New",
        dotColor: "bg-orange-500",
        filter: (t) =>
            t.state === "OPEN" &&
            !t.labels.some((l) => l.name === "blocked") &&
            !t.labels.some((l) => l.name === "in-progress"),
    },
    "in-progress": {
        title: "In Progress",
        dotColor: "bg-blue-500",
        filter: (t) =>
            t.state === "OPEN" && t.labels.some((l) => l.name === "in-progress"),
    },
    blocked: {
        title: "Blocked",
        dotColor: "bg-red-500",
        filter: (t) => t.state === "OPEN" && t.labels.some((l) => l.name === "blocked"),
    },
    done: {
        title: "Done",
        dotColor: "bg-green-500",
        filter: (t) => t.state === "CLOSED",
    },
};

const PRIORITY_COLORS: Record<string, string> = {
    high: "bg-red-500/20 text-red-400 border-red-500/30",
    medium: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    low: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

function getPriority(labels: Array<{ name: string }>): string {
    if (labels.some((l) => l.name === "priority-high" || l.name === "high"))
        return "high";
    if (labels.some((l) => l.name === "priority-medium" || l.name === "medium"))
        return "medium";
    return "low";
}

function TaskCard({
    task,
    isDragging,
    onClick,
}: {
    task: Task;
    isDragging?: boolean;
    onClick: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform } = useSortable({
        id: `task-${task.number}`,
    });

    const style = transform
        ? {
              transform: CSS.Translate.toString(transform),
              zIndex: isDragging ? 50 : undefined,
          }
        : undefined;

    const priority = getPriority(task.labels);
    const assignee = task.assignees[0];

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            className={
                "group relative cursor-pointer rounded-lg border border-slate-700 bg-slate-800 p-3 transition-all " +
                "hover:border-slate-600 " +
                (isDragging ? "cursor-grabbing border-accent-500 opacity-90" : "")
            }
            onClick={onClick}
        >
            <button
                {...listeners}
                className="absolute left-1.5 top-1/2 -translate-y-1/2 cursor-grab text-slate-600 opacity-0 transition-opacity hover:text-slate-400 group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <GripVertical className="h-4 w-4" />
            </button>

            <div className="ml-3">
                <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-xs text-slate-500">#{task.number}</span>
                    <span
                        className={
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                            PRIORITY_COLORS[priority]
                        }
                    >
                        {priority.toUpperCase()}
                    </span>
                </div>

                <h3 className="mb-1.5 line-clamp-2 text-sm font-medium text-slate-200">
                    {task.title}
                </h3>

                <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                        {formatDistanceToNow(new Date(task.updatedAt), {
                            addSuffix: true,
                            locale: enUS,
                        })}
                    </span>
                    {assignee && (
                        <div className="flex items-center gap-1">
                            {assignee.avatar_url ? (
                                <img
                                    src={assignee.avatar_url}
                                    alt={assignee.login || "Avatar"}
                                    className="h-5 w-5 rounded-full"
                                />
                            ) : (
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[10px] text-slate-300">
                                    {(assignee.login ||
                                        assignee.name ||
                                        "?")[0].toUpperCase()}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function TaskOverlay({ task }: { task: Task }) {
    const priority = getPriority(task.labels);

    return (
        <div className="w-72 rounded-lg border border-accent-500/50 bg-slate-800 p-3 shadow-xl">
            <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs text-slate-500">#{task.number}</span>
                <span
                    className={
                        "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                        PRIORITY_COLORS[priority]
                    }
                >
                    {priority.toUpperCase()}
                </span>
            </div>
            <h3 className="line-clamp-2 text-sm font-medium text-slate-200">
                {task.title}
            </h3>
        </div>
    );
}

function NewTaskModal({
    isOpen,
    onClose,
    onSubmit,
}: {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (title: string, body?: string, priority?: "high" | "medium" | "low") => Promise<void>;
}) {
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [priority, setPriority] = useState<"high" | "medium" | "low">("medium");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;

        setIsSubmitting(true);
        try {
            const trimmedBody = body.trim();
            await onSubmit(title.trim(), trimmedBody || undefined, priority);
            setTitle("");
            setBody("");
            setPriority("medium");
            onClose();
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg">
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-slate-100">New Task</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-200"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                        Title
                    </label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Task title..."
                        className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-500 focus:outline-none"
                        autoFocus
                    />
                </div>

                <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                        Description (optional)
                    </label>
                    <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        placeholder="Task description..."
                        rows={4}
                        className="w-full resize-none rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-500 focus:outline-none"
                    />
                </div>

                <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-300">
                        Priority
                    </label>
                    <div className="flex gap-2">
                        {(["low", "medium", "high"] as const).map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => setPriority(p)}
                                className={
                                    "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors " +
                                    (priority === p
                                        ? PRIORITY_COLORS[p] + " border-current"
                                        : "border-slate-600 bg-slate-700 text-slate-400 hover:bg-slate-600")
                                }
                            >
                                {p.charAt(0).toUpperCase() + p.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={!title.trim() || isSubmitting}
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Creating...
                            </>
                        ) : (
                            <>
                                <Plus className="h-4 w-4" />
                                Create Task
                            </>
                        )}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

function TaskDetailModal({
    task,
    onClose,
    onMove,
}: {
    task: Task;
    onClose: () => void;
    onMove: (column: ColumnId) => Promise<void>;
}) {
    const [isMoving, setIsMoving] = useState(false);

    const priority = getPriority(task.labels);
    const assignee = task.assignees[0];
    const currentColumn: ColumnId = task.labels.some((l) => l.name === "blocked")
        ? "blocked"
        : task.labels.some((l) => l.name === "in-progress")
          ? "in-progress"
          : task.state === "CLOSED"
            ? "done"
            : "todo";

    const handleMove = async (column: ColumnId) => {
        setIsMoving(true);
        await onMove(column);
        setIsMoving(false);
    };

    return (
        <Modal isOpen={!!task} onClose={onClose} size="2xl">
            <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between">
                    <div className="flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span
                                className={
                                    "rounded-full border px-2 py-0.5 text-xs font-medium " +
                                    (task.state === "CLOSED"
                                        ? "border-green-500/30 bg-green-500/20 text-green-400"
                                        : "border-blue-500/30 bg-blue-500/20 text-blue-400")
                                }
                            >
                                {task.state === "CLOSED"
                                    ? "DONE"
                                    : currentColumn.toUpperCase()}
                            </span>
                            <span
                                className={
                                    "rounded-full border px-2 py-0.5 text-xs font-medium " +
                                    PRIORITY_COLORS[priority]
                                }
                            >
                                {priority.toUpperCase()}
                            </span>
                            {task.labels
                                .filter(
                                    (l) =>
                                        !l.name.startsWith("priority-") &&
                                        l.name !== "blocked" &&
                                        l.name !== "in-progress"
                                )
                                .map((label) => (
                                    <span
                                        key={label.name}
                                        className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
                                    >
                                        {label.name}
                                    </span>
                                ))}
                        </div>
                        <h2 className="text-lg font-semibold text-slate-100">
                            #{task.number}: {task.title}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-200"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Metadata */}
                <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
                    {assignee && (
                        <div className="flex items-center gap-2">
                            {assignee.avatar_url ? (
                                <img
                                    src={assignee.avatar_url}
                                    alt={assignee.login || "Avatar"}
                                    className="h-5 w-5 rounded-full"
                                />
                            ) : (
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-xs text-slate-300">
                                    {(assignee.login ||
                                        assignee.name ||
                                        "?")[0].toUpperCase()}
                                </div>
                            )}
                            <span>@{assignee.login || assignee.name}</span>
                        </div>
                    )}
                    <span>
                        Created{" "}
                        {format(new Date(task.createdAt), "MMM d, yyyy", {
                            locale: enUS,
                        })}
                    </span>
                    <span>
                        Updated{" "}
                        {formatDistanceToNow(new Date(task.updatedAt), {
                            addSuffix: true,
                            locale: enUS,
                        })}
                    </span>
                </div>

                {/* Body */}
                {task.body && (
                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                        <h3 className="mb-2 text-sm font-semibold text-slate-300">
                            Description
                        </h3>
                        <p className="whitespace-pre-wrap text-sm text-slate-400">
                            {task.body}
                        </p>
                    </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-2">
                    {currentColumn !== "todo" && (
                        <Button
                            variant="secondary"
                            onClick={() => handleMove("todo")}
                            disabled={isMoving}
                        >
                            Move to New
                        </Button>
                    )}
                    {currentColumn !== "in-progress" && (
                        <Button
                            variant="secondary"
                            onClick={() => handleMove("in-progress")}
                            disabled={isMoving}
                        >
                            Move to In Progress
                        </Button>
                    )}
                    {currentColumn !== "blocked" && (
                        <Button
                            variant="secondary"
                            onClick={() => handleMove("blocked")}
                            disabled={isMoving}
                        >
                            Move to Blocked
                        </Button>
                    )}
                    {currentColumn !== "done" && (
                        <Button
                            variant="primary"
                            onClick={() => handleMove("done")}
                            disabled={isMoving}
                        >
                            Mark Done
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        onClick={() => window.open(task.url, "_blank")}
                        className="ml-auto"
                    >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open in GitHub
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function Column({
    id,
    tasks,
    isOver,
    onTaskClick,
}: {
    id: ColumnId;
    tasks: Task[];
    isOver: boolean;
    onTaskClick: (task: Task) => void;
}) {
    const config = COLUMN_CONFIG[id];

    return (
        <div className="flex min-w-[280px] flex-1 flex-col">
            <div className="mb-2 flex items-center gap-2">
                <div className={"h-2 w-2 rounded-full " + config.dotColor} />
                <h2 className="text-sm font-medium text-slate-300">{config.title}</h2>
                <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-400">
                    {tasks.length}
                </span>
            </div>
            <div
                data-column={id}
                className={
                    "flex min-h-[400px] flex-1 flex-col gap-2 rounded-lg border-2 border-dashed p-2 transition-colors " +
                    (isOver
                        ? "border-accent-500/50 bg-accent-500/5"
                        : "border-slate-700/50 bg-slate-800/30")
                }
            >
                {tasks.length > 0 ? (
                    tasks.map((task) => (
                        <TaskCard
                            key={task.number}
                            task={task}
                            onClick={() => onTaskClick(task)}
                        />
                    ))
                ) : (
                    <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
                        No tasks
                    </div>
                )}
            </div>
        </div>
    );
}

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

        const currentColumn: ColumnId = task.labels.some((l) => l.name === "blocked")
            ? "blocked"
            : task.labels.some((l) => l.name === "in-progress")
              ? "in-progress"
              : task.state === "CLOSED"
                ? "done"
                : "todo";

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

            const currentColumn: ColumnId = task.labels.some((l) => l.name === "blocked")
                ? "blocked"
                : task.labels.some((l) => l.name === "in-progress")
                  ? "in-progress"
                  : task.state === "CLOSED"
                    ? "done"
                    : "todo";

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
                        <Column
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

            {/* Task Detail Modal */}
            {selectedTask && (
                <TaskDetailModal
                    task={selectedTask}
                    onClose={() => setSelectedTask(null)}
                    onMove={async (column) => {
                        await moveTask(selectedTask, column);
                        setSelectedTask(null);
                    }}
                />
            )}

            {/* New Task Modal */}
            <NewTaskModal
                isOpen={isNewTaskOpen}
                onClose={() => setIsNewTaskOpen(false)}
                onSubmit={createTask}
            />
        </div>
    );
}
