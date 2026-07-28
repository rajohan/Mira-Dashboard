import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    AssignTaskRequest,
    ColumnId,
    CreateTaskRequest,
    CreateTaskUpdateRequest,
    MoveTaskRequest,
    Task,
    TaskAssigneeId,
    TaskAutomationInput,
    TaskUpdate,
    UpdateTaskRequest,
    UpdateTaskUpdateRequest,
} from "../../contracts/tasks";
import {
    parseTaskMutationResponse,
    parseTaskResponse,
    parseTasksResponse,
    parseTaskUpdateResponse,
    parseTaskUpdatesResponse,
} from "../../contracts/tasks";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { apiDeleteParsed, apiFetchParsed, apiPatchParsed, apiPostParsed } from "./useApi";

/** Defines task keys. */
export const taskKeys = {
    all: ["tasks"] as const,
    list: () => [...taskKeys.all, "list"] as const,
    updates: (taskId: number) => [...taskKeys.all, "updates", taskId] as const,
};

/** Fetches tasks. */
async function fetchTasks(): Promise<Task[]> {
    return apiFetchParsed("/tasks", parseTasksResponse);
}

/** Creates task. */
async function createTask(
    title: string,
    body: string,
    labels: string[],
    assignee: TaskAssigneeId,
    automation?: TaskAutomationInput
): Promise<Task> {
    const request: CreateTaskRequest = {
        assignee,
        body,
        labels,
        title,
        ...(automation && { automation }),
    };
    return apiPostParsed("/tasks", parseTaskResponse, request);
}

/** Performs update task. */
async function updateTask(number: number, updates: UpdateTaskRequest): Promise<Task> {
    return apiPatchParsed(`/tasks/${number}`, parseTaskResponse, updates);
}

/** Performs move task. */
async function moveTask(number: number, columnLabel: ColumnId): Promise<Task> {
    const request: MoveTaskRequest = { columnLabel };
    return apiPostParsed(`/tasks/${number}/move`, parseTaskResponse, request);
}

/** Performs assign task. */
async function assignTask(number: number, assignee: TaskAssigneeId): Promise<Task> {
    const request: AssignTaskRequest = { assignee };
    return apiPostParsed(`/tasks/${number}/assign`, parseTaskResponse, request);
}

/** Performs delete task. */
async function deleteTask(number: number): Promise<void> {
    await apiDeleteParsed(`/tasks/${number}`, parseTaskMutationResponse);
}

/** Fetches task updates. */
async function fetchTaskUpdates(taskId: number): Promise<TaskUpdate[]> {
    return apiFetchParsed(`/tasks/${taskId}/updates`, parseTaskUpdatesResponse);
}

/** Creates task update. */
async function createTaskUpdate(
    taskId: number,
    author: TaskAssigneeId,
    messageMd: string
): Promise<TaskUpdate> {
    const request: CreateTaskUpdateRequest = { author, messageMd };
    return apiPostParsed(`/tasks/${taskId}/updates`, parseTaskUpdateResponse, request);
}

/** Performs update task update. */
async function updateTaskUpdate(
    taskId: number,
    updateId: number,
    messageMd: string
): Promise<TaskUpdate> {
    const request: UpdateTaskUpdateRequest = { messageMd };
    return apiPatchParsed(
        `/tasks/${taskId}/updates/${updateId}`,
        parseTaskUpdateResponse,
        request
    );
}

/** Performs delete task update. */
async function deleteTaskUpdate(taskId: number, updateId: number): Promise<void> {
    await apiDeleteParsed(
        `/tasks/${taskId}/updates/${updateId}`,
        parseTaskMutationResponse
    );
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
            automation?: TaskAutomationInput;
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
            updates: UpdateTaskRequest;
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
        mutationFn: ({
            number,
            columnLabel,
        }: {
            number: number;
            columnLabel: ColumnId;
        }) => moveTask(number, columnLabel),
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
export function useTaskUpdates(taskId: number | undefined) {
    return useQuery({
        queryKey: taskId === undefined ? taskKeys.all : taskKeys.updates(taskId),
        queryFn: () => fetchTaskUpdates(taskId!),
        enabled: taskId !== undefined,
        staleTime: 5000,
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
            messageMd,
        }: {
            taskId: number;
            updateId: number;
            messageMd: string;
        }) => updateTaskUpdate(taskId, updateId, messageMd),
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
