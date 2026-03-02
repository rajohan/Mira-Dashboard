import {
    AlertCircle,
    CheckCircle2,
    Circle,
    ExternalLink,
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

export function Tasks() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<"all" | "mira-2026" | "rajohan">("all");

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

    const todoTasks = filteredTasks.filter(
        (t) =>
            t.state === "OPEN" &&
            !t.labels.some((l) => l.name === "blocked") &&
            !t.labels.some((l) => l.name === "in-progress")
    );
    const inProgressTasks = filteredTasks.filter(
        (t) => t.state === "OPEN" && t.labels.some((l) => l.name === "in-progress")
    );
    const blockedTasks = filteredTasks.filter(
        (t) => t.state === "OPEN" && t.labels.some((l) => l.name === "blocked")
    );
    const doneTasks = filteredTasks.filter((t) => t.state === "CLOSED");

    const TaskRow = ({ task }: { task: Task }) => (
        <div
            className="flex cursor-pointer items-center gap-3 border-b border-slate-700/50 px-4 py-3 transition-colors last:border-b-0 hover:bg-slate-800/50"
            onClick={() => window.open(task.url, "_blank")}
        >
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

            {/* Kanban Board */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                {/* To Do */}
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <Circle className="h-4 w-4 text-slate-400" />
                        <h2 className="text-sm font-semibold text-slate-300">To Do</h2>
                        <span className="text-xs text-slate-500">
                            ({todoTasks.length})
                        </span>
                    </div>
                    <Card className="overflow-hidden p-0">
                        {todoTasks.length > 0 ? (
                            todoTasks.map((task) => (
                                <TaskRow key={task.number} task={task} />
                            ))
                        ) : (
                            <div className="p-4 text-center text-sm text-slate-500">
                                No tasks
                            </div>
                        )}
                    </Card>
                </div>

                {/* In Progress */}
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <Loader2 className="h-4 w-4 text-blue-400" />
                        <h2 className="text-sm font-semibold text-slate-300">
                            In Progress
                        </h2>
                        <span className="text-xs text-slate-500">
                            ({inProgressTasks.length})
                        </span>
                    </div>
                    <Card className="overflow-hidden p-0">
                        {inProgressTasks.length > 0 ? (
                            inProgressTasks.map((task) => (
                                <TaskRow key={task.number} task={task} />
                            ))
                        ) : (
                            <div className="p-4 text-center text-sm text-slate-500">
                                No tasks
                            </div>
                        )}
                    </Card>
                </div>

                {/* Blocked */}
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-red-400" />
                        <h2 className="text-sm font-semibold text-slate-300">Blocked</h2>
                        <span className="text-xs text-slate-500">
                            ({blockedTasks.length})
                        </span>
                    </div>
                    <Card className="overflow-hidden p-0">
                        {blockedTasks.length > 0 ? (
                            blockedTasks.map((task) => (
                                <TaskRow key={task.number} task={task} />
                            ))
                        ) : (
                            <div className="p-4 text-center text-sm text-slate-500">
                                No tasks
                            </div>
                        )}
                    </Card>
                </div>

                {/* Done */}
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                        <h2 className="text-sm font-semibold text-slate-300">Done</h2>
                        <span className="text-xs text-slate-500">
                            ({doneTasks.length})
                        </span>
                    </div>
                    <Card className="max-h-96 overflow-hidden overflow-y-auto p-0">
                        {doneTasks.length > 0 ? (
                            doneTasks
                                .slice(0, 10)
                                .map((task) => <TaskRow key={task.number} task={task} />)
                        ) : (
                            <div className="p-4 text-center text-sm text-slate-500">
                                No tasks
                            </div>
                        )}
                        {doneTasks.length > 10 && (
                            <div className="p-2 text-center text-xs text-slate-500">
                                +{doneTasks.length - 10} more
                            </div>
                        )}
                    </Card>
                </div>
            </div>
        </div>
    );
}
