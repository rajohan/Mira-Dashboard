import type { Task, ColumnId, ColumnConfig } from "../../../types/task";

export const COLUMN_CONFIG: Record<ColumnId, ColumnConfig> = {
    todo: {
        title: "New",
        dotColor: "bg-orange-500",
        filter: (t: Task) =>
            t.state === "OPEN" &&
            !t.labels.some((l: { name: string }) => l.name === "blocked") &&
            !t.labels.some((l: { name: string }) => l.name === "in-progress"),
    },
    "in-progress": {
        title: "In Progress",
        dotColor: "bg-blue-500",
        filter: (t: Task) =>
            t.state === "OPEN" && t.labels.some((l: { name: string }) => l.name === "in-progress"),
    },
    blocked: {
        title: "Blocked",
        dotColor: "bg-red-500",
        filter: (t: Task) => t.state === "OPEN" && t.labels.some((l: { name: string }) => l.name === "blocked"),
    },
    done: {
        title: "Done",
        dotColor: "bg-green-500",
        filter: (t: Task) => t.state === "CLOSED",
    },
};

export function getPriority(labels: Array<{ name: string }>): "high" | "medium" | "low" {
    if (labels.some((l: { name: string }) => l.name === "priority-high" || l.name === "high"))
        return "high";
    if (labels.some((l: { name: string }) => l.name === "priority-medium" || l.name === "medium"))
        return "medium";
    return "low";
}

export function getColumnId(task: Task): ColumnId {
    if (task.state === "CLOSED") return "done";
    if (task.labels.some((l: { name: string }) => l.name === "blocked")) return "blocked";
    if (task.labels.some((l: { name: string }) => l.name === "in-progress")) return "in-progress";
    return "todo";
}