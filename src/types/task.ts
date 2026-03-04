import type { TaskAssigneeId } from "../constants/taskActors";

export interface Task {
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

export interface TaskUpdate {
    id: number;
    taskId: number;
    author: TaskAssigneeId;
    messageMd: string;
    createdAt: string;
}

export type ColumnId = "todo" | "in-progress" | "blocked" | "done";
