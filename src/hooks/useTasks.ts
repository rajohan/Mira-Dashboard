import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TaskAssigneeId } from "../constants/taskActors";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import type { Task, TaskAutomation, TaskUpdate } from "../types/task";
import { apiDelete, apiFetchRequired, apiPostRequired } from "./useApi";

/** Defines task keys. */
export const taskKeys = {
    all: ["tasks"] as const,
    list: () => [...taskKeys.all, "list"] as const,
    updates: (taskId: number) => [...taskKeys.all, "updates", taskId] as const,
};

/** Fetches tasks. */
async function fetchTasks(): Promise<Task[]> {
    return apiFetchRequired<Task[]>("/tasks");
}

/** Creates task. */
async function createTask(
    title: string,
    body: string,
    labels: string[],
    assignee: TaskAssigneeId,
    automation?: Pick<TaskAutomation, "cronJobId" | "scheduleSummary" | "sessionTarget">
): Promise<Task> {
    return apiPostRequired<Task>("/tasks", { title, body, labels, assignee, automation });
}

/** Performs update task. */
async function updateTask(
    number: number,
    updates: {
        title?: string;
        body?: string;
        labels?: string[];
        automation?: Pick<
            TaskAutomation,
            "cronJobId" | "scheduleSummary" | "sessionTarget"
        > | null;
    }
): Promise<Task> {
    return apiFetchRequired<Task>(`/tasks/${number}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
    });
}

/** Performs move task. */
async function moveTask(number: number, columnLabel: string): Promise<Task> {
    return apiPostRequired<Task>(`/tasks/${number}/move`, { columnLabel });
}

/** Performs assign task. */
async function assignTask(number: number, assignee: TaskAssigneeId): Promise<Task> {
    return apiPostRequired<Task>(`/tasks/${number}/assign`, { assignee });
}

/** Performs delete task. */
async function deleteTask(number: number): Promise<void> {
    await apiDelete(`/tasks/${number}`);
}

/** Fetches task updates. */
async function fetchTaskUpdates(taskId: number): Promise<TaskUpdate[]> {
    return apiFetchRequired<TaskUpdate[]>(`/tasks/${taskId}/updates`);
}

/** Creates task update. */
async function createTaskUpdate(
    taskId: number,
    author: TaskAssigneeId,
    messageMd: string
): Promise<TaskUpdate> {
    return apiPostRequired<TaskUpdate>(`/tasks/${taskId}/updates`, { author, messageMd });
}

/** Performs update task update. */
async function updateTaskUpdate(
    taskId: number,
    updateId: number,
    author: TaskAssigneeId,
    messageMd: string
): Promise<TaskUpdate> {
    return apiFetchRequired<TaskUpdate>(`/tasks/${taskId}/updates/${updateId}`, {
        method: "PATCH",
        body: JSON.stringify({ author, messageMd }),
    });
}

/** Performs delete task update. */
async function deleteTaskUpdate(taskId: number, updateId: number): Promise<void> {
    await apiDelete(`/tasks/${taskId}/updates/${updateId}`);
}

/** Provides tasks. */
export function useTasks() {
    return useQuery({
        queryKey: taskKeys.list(),
        queryFn: fetchTasks,
        staleTime: 10_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides create task. */
export function useCreateTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            title,
            body,
            labels,
            assignee,
            automation,
        }: {
            title: string;
            body: string;
            labels: string[];
            assignee: TaskAssigneeId;
            automation?: Pick<
                TaskAutomation,
                "cronJobId" | "scheduleSummary" | "sessionTarget"
            >;
        }) => createTask(title, body, labels, assignee, automation),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides update task. */
export function useUpdateTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            number,
            updates,
        }: {
            number: number;
            updates: {
                title?: string;
                body?: string;
                labels?: string[];
                automation?: Pick<
                    TaskAutomation,
                    "cronJobId" | "scheduleSummary" | "sessionTarget"
                > | null;
            };
        }) => updateTask(number, updates),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides move task. */
export function useMoveTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number, columnLabel }: { number: number; columnLabel: string }) =>
            moveTask(number, columnLabel),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides assign task. */
export function useAssignTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            number,
            assignee,
        }: {
            number: number;
            assignee: TaskAssigneeId;
        }) => assignTask(number, assignee),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides delete task. */
export function useDeleteTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number }: { number: number }) => deleteTask(number),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides task updates. */
export function useTaskUpdates(taskId: number | null) {
    return useQuery({
        queryKey: taskId ? taskKeys.updates(taskId) : taskKeys.all,
        queryFn: () => fetchTaskUpdates(taskId!),
        enabled: !!taskId,
        staleTime: 5_000,
        refetchInterval: AUTO_REFRESH_MS,
    });
}

/** Provides create task update. */
export function useCreateTaskUpdate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            taskId,
            author,
            messageMd,
        }: {
            taskId: number;
            author: TaskAssigneeId;
            messageMd: string;
        }) => createTaskUpdate(taskId, author, messageMd),
        onSuccess: (_result, variables) => {
            void queryClient.invalidateQueries({
                queryKey: taskKeys.updates(variables.taskId),
            });
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides update task update. */
export function useUpdateTaskUpdate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            taskId,
            updateId,
            author,
            messageMd,
        }: {
            taskId: number;
            updateId: number;
            author: TaskAssigneeId;
            messageMd: string;
        }) => updateTaskUpdate(taskId, updateId, author, messageMd),
        onSuccess: (_result, variables) => {
            void queryClient.invalidateQueries({
                queryKey: taskKeys.updates(variables.taskId),
            });
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

/** Provides delete task update. */
export function useDeleteTaskUpdate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ taskId, updateId }: { taskId: number; updateId: number }) =>
            deleteTaskUpdate(taskId, updateId),
        onSuccess: (_result, variables) => {
            void queryClient.invalidateQueries({
                queryKey: taskKeys.updates(variables.taskId),
            });
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}
