import type { ColumnId, Task } from "../types/task";

export const PRIORITY_COLORS: Record<string, string> = {
    high: "bg-red-500/20 text-red-400 border-red-500/30",
    medium: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    low: "bg-primary-500/20 text-primary-400 border-primary-500/30",
};

export interface ColumnConfig {
    id: ColumnId;
    title: string;
    dotColor: string;
    label: string;
    filter: (t: Task) => boolean;
}

export const COLUMN_CONFIG: ColumnConfig[] = [
    {
        id: "todo",
        title: "New",
        dotColor: "bg-orange-500",
        label: "todo",
        filter: (t: Task) =>
            t.state === "OPEN" &&
            !t.labels.some((l: { name: string }) => l.name === "blocked") &&
            !t.labels.some((l: { name: string }) => l.name === "in-progress"),
    },
    {
        id: "in-progress",
        title: "In Progress",
        dotColor: "bg-blue-500",
        label: "in-progress",
        filter: (t: Task) =>
            t.state === "OPEN" &&
            t.labels.some((l: { name: string }) => l.name === "in-progress"),
    },
    {
        id: "blocked",
        title: "Blocked",
        dotColor: "bg-red-500",
        label: "blocked",
        filter: (t: Task) =>
            t.state === "OPEN" &&
            t.labels.some((l: { name: string }) => l.name === "blocked"),
    },
    {
        id: "done",
        title: "Done",
        dotColor: "bg-green-500",
        label: "done",
        filter: (t: Task) => t.state === "CLOSED",
    },
];

export function getPriority(labels: Array<{ name: string }>): "high" | "medium" | "low" {
    if (
        labels.some(
            (l: { name: string }) => l.name === "priority-high" || l.name === "high"
        )
    )
        return "high";
    if (
        labels.some(
            (l: { name: string }) => l.name === "priority-medium" || l.name === "medium"
        )
    )
        return "medium";
    return "low";
}

export function getColumnId(taskOrId: Task | string): ColumnId | null {
    if (typeof taskOrId === "string") {
        if (["todo", "in-progress", "blocked", "done"].includes(taskOrId)) {
            return taskOrId as ColumnId;
        }
        return null;
    }

    const task = taskOrId as Task;
    if (task.state === "CLOSED") return "done";
    if (task.labels?.some((l: { name: string }) => l.name === "blocked"))
        return "blocked";
    if (task.labels?.some((l: { name: string }) => l.name === "in-progress")) {
        return "in-progress";
    }
    return "todo";
}
