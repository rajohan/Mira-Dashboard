import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Task } from "../types/task";
import { apiDelete, apiFetch, apiPost } from "./useApi";

export const taskKeys = {
    all: ["tasks"] as const,
    list: () => [...taskKeys.all, "list"] as const,
};

async function fetchTasks(): Promise<Task[]> {
    return apiFetch<Task[]>("/tasks");
}

async function createTask(
    title: string,
    body: string,
    labels: string[],
    assignee: "mira-2026" | "rajohan"
): Promise<Task> {
    return apiPost<Task>("/tasks", { title, body, labels, assignee });
}

async function updateTask(
    number: number,
    updates: { title?: string; body?: string; labels?: string[] }
): Promise<Task> {
    return apiFetch<Task>(`/tasks/${number}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
    });
}

async function moveTask(number: number, columnLabel: string): Promise<Task> {
    return apiPost<Task>(`/tasks/${number}/move`, { columnLabel });
}

async function assignTask(
    number: number,
    assignee: "mira-2026" | "rajohan"
): Promise<Task> {
    return apiPost<Task>(`/tasks/${number}/assign`, { assignee });
}

async function deleteTask(number: number): Promise<void> {
    await apiDelete(`/tasks/${number}`);
}

export function useTasks() {
    return useQuery({
        queryKey: taskKeys.list(),
        queryFn: fetchTasks,
        staleTime: 10_000,
        refetchInterval: 15_000,
    });
}

export function useCreateTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            title,
            body,
            labels,
            assignee,
        }: {
            title: string;
            body: string;
            labels: string[];
            assignee: "mira-2026" | "rajohan";
        }) => createTask(title, body, labels, assignee),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

export function useUpdateTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            number,
            updates,
        }: {
            number: number;
            updates: { title?: string; body?: string; labels?: string[] };
        }) => updateTask(number, updates),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

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

export function useAssignTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            number,
            assignee,
        }: {
            number: number;
            assignee: "mira-2026" | "rajohan";
        }) => assignTask(number, assignee),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

export function useDeleteTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number }: { number: number }) => deleteTask(number),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}
