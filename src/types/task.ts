import type { TaskAssigneeId } from "../constants/taskActors";

/** Represents task automation. */
export interface TaskAutomation {
    type: "cron";
    recurring: boolean;
    cronJobId: string;
    jobName?: string;
    enabled?: boolean;
    schedule?: { kind?: string; [key: string]: unknown };
    scheduleSummary?: string;
    sessionTarget?: string;
    model?: string;
    thinking?: string;
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastDurationMs?: number;
    source?: "cron" | "stored";
}

/** Represents task. */
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
    automation?: TaskAutomation;
}

/** Represents task update. */
export interface TaskUpdate {
    id: number;
    taskId: number;
    author: TaskAssigneeId;
    messageMd: string;
    createdAt: string;
}

/** Defines column id. */
export type ColumnId = "todo" | "in-progress" | "blocked" | "done";
