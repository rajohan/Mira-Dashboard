import { useEffect, useState } from "react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { CheckCircle2, Circle, Loader2, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";

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
                    args: ["issue", "list", "--repo", "rajohan/Mira-Workspace", "--limit", "50", "--json", "number,title,state,labels,assignees,createdAt,updatedAt,url"]
                })
            });
            if (!res.ok) throw new Error("Failed to fetch tasks");
            const data = await res.json();
            setTasks(data.stdout ? JSON.parse(data.stdout) : []);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTasks();
    }, []);

    const filteredTasks = tasks.filter(task => {
        if (filter === "all") return true;
        return task.assignees.some(a => (a.login || a.name) === filter);
    });

    const todoTasks = filteredTasks.filter(t => 
        t.state === "OPEN" && 
        !t.labels.some(l => l.name === "blocked") && 
        !t.labels.some(l => l.name === "in-progress")
    );
    const inProgressTasks = filteredTasks.filter(t => 
        t.state === "OPEN" && 
        t.labels.some(l => l.name === "in-progress")
    );
    const blockedTasks = filteredTasks.filter(t => 
        t.state === "OPEN" && 
        t.labels.some(l => l.name === "blocked")
    );
    const doneTasks = filteredTasks.filter(t => t.state === "CLOSED");

    const TaskRow = ({ task }: { task: Task }) => (
        <div 
            className="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 transition-colors cursor-pointer border-b border-slate-700/50 last:border-b-0"
            onClick={() => window.open(task.url, "_blank")}
        >
            <div className="flex-shrink-0">
                {task.state === "CLOSED" ? (
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                ) : task.labels.some(l => l.name === "blocked") ? (
                    <AlertCircle className="w-5 h-5 text-red-400" />
                ) : task.labels.some(l => l.name === "in-progress") ? (
                    <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                ) : (
                    <Circle className="w-5 h-5 text-slate-400" />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-100 truncate">#{task.number}: {task.title}</p>
                <div className="flex items-center gap-2 mt-1">
                    {task.labels.slice(0, 3).map(label => (
                        <span 
                            key={label.name} 
                            className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-300"
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
            <ExternalLink className="w-4 h-4 text-slate-500 flex-shrink-0" />
        </div>
    );

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-slate-100">Tasks</h1>
                <div className="flex items-center gap-3">
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as typeof filter)}
                        className="bg-slate-800 text-slate-100 rounded-lg px-3 py-1.5 text-sm border border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        <option value="all">All Tasks</option>
                        <option value="mira-2026">Assigned to Mira</option>
                        <option value="rajohan">Assigned to Raymond</option>
                    </select>
                    <Button variant="secondary" onClick={fetchTasks} disabled={loading}>
                        <RefreshCw className={loading ? "animate-spin w-4 h-4" : "w-4 h-4"} />
                    </Button>
                </div>
            </div>

            {error && (
                <Card className="p-4 bg-red-900/20 border-red-800">
                    <p className="text-red-400">Error: {error}</p>
                </Card>
            )}

            {/* Kanban Board */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* To Do */}
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <Circle className="w-4 h-4 text-slate-400" />
                        <h2 className="text-sm font-semibold text-slate-300">To Do</h2>
                        <span className="text-xs text-slate-500">({todoTasks.length})</span>
                    </div>
                    <Card className="p-0 overflow-hidden">
                        {todoTasks.length > 0 ? (
                            todoTasks.map(task => <TaskRow key={task.number} task={task} />)
                        ) : (
                            <div className="p-4 text-center text-slate-500 text-sm">No tasks</div>
                        )}
                    </Card>
                </div>

                {/* In Progress */}
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <Loader2 className="w-4 h-4 text-blue-400" />
                        <h2 className="text-sm font-semibold text-slate-300">In Progress</h2>
                        <span className="text-xs text-slate-500">({inProgressTasks.length})</span>
                    </div>
                    <Card className="p-0 overflow-hidden">
                        {inProgressTasks.length > 0 ? (
                            inProgressTasks.map(task => <TaskRow key={task.number} task={task} />)
                        ) : (
                            <div className="p-4 text-center text-slate-500 text-sm">No tasks</div>
                        )}
                    </Card>
                </div>

                {/* Blocked */}
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <h2 className="text-sm font-semibold text-slate-300">Blocked</h2>
                        <span className="text-xs text-slate-500">({blockedTasks.length})</span>
                    </div>
                    <Card className="p-0 overflow-hidden">
                        {blockedTasks.length > 0 ? (
                            blockedTasks.map(task => <TaskRow key={task.number} task={task} />)
                        ) : (
                            <div className="p-4 text-center text-slate-500 text-sm">No tasks</div>
                        )}
                    </Card>
                </div>

                {/* Done */}
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <CheckCircle2 className="w-4 h-4 text-green-400" />
                        <h2 className="text-sm font-semibold text-slate-300">Done</h2>
                        <span className="text-xs text-slate-500">({doneTasks.length})</span>
                    </div>
                    <Card className="p-0 overflow-hidden max-h-96 overflow-y-auto">
                        {doneTasks.length > 0 ? (
                            doneTasks.slice(0, 10).map(task => <TaskRow key={task.number} task={task} />)
                        ) : (
                            <div className="p-4 text-center text-slate-500 text-sm">No tasks</div>
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
