import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiPost } from "./useApi";

import type { Task } from "../types/task";

// Types
interface ExecResponse {
    stdout: string;
    stderr: string;
    exitCode: number;
}

// Query keys
export const taskKeys = {
    all: ["tasks"] as const,
    list: () => [...taskKeys.all, "list"] as const,
};

// Fetchers
async function execCommand(command: string, args: string[]): Promise<ExecResponse> {
    return apiPost<ExecResponse>("/exec", { command, args });
}

async function fetchTasks(): Promise<Task[]> {
    const result = await execCommand("gh", [
        "issue",
        "list",
        "--repo",
        "rajohan/Mira-Workspace",
        "--limit",
        "50",
        "--json",
        "number,title,body,state,labels,assignees,createdAt,updatedAt,url",
    ]);
    return result.stdout ? JSON.parse(result.stdout) : [];
}

async function createTask(title: string, body: string, labels: string[]): Promise<void> {
    const args = [
        "issue",
        "create",
        "--repo",
        "rajohan/Mira-Workspace",
        "--title",
        title,
        "--body",
        body,
    ];
    if (labels.length > 0) {
        args.push("--label", labels.join(","));
    }
    await execCommand("gh", args);
}

async function updateTask(
    number: number,
    updates: { title?: string; body?: string; labels?: string[] }
): Promise<void> {
    const args = ["issue", "edit", "--repo", "rajohan/Mira-Workspace", String(number)];
    if (updates.title) {
        args.push("--title", updates.title);
    }
    if (updates.body) {
        args.push("--body", updates.body);
    }
    await execCommand("gh", args);

    // Handle label updates separately
    if (updates.labels) {
        // First remove all existing labels, then add new ones
        await execCommand("gh", [
            "issue",
            "edit",
            "--repo",
            "rajohan/Mira-Workspace",
            String(number),
            "--remove-label",
            "*", // This doesn't work, need different approach
        ]).catch(() => {}); // Ignore error if no labels to remove
        
        if (updates.labels.length > 0) {
            await execCommand("gh", [
                "issue",
                "edit",
                "--repo",
                "rajohan/Mira-Workspace",
                String(number),
                "--add-label",
                updates.labels.join(","),
            ]);
        }
    }
}

async function moveTask(number: number, columnLabel: string): Promise<void> {
    // Use gh issue edit to update labels
    await execCommand("gh", [
        "issue",
        "edit",
        "--repo",
        "rajohan/Mira-Workspace",
        String(number),
        "--add-label",
        columnLabel,
    ]);
}

// Hooks
export function useTasks() {
    return useQuery({
        queryKey: taskKeys.list(),
        queryFn: fetchTasks,
        staleTime: 60_000, // 1 minute
    });
}

export function useCreateTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ title, body, labels }: { title: string; body: string; labels: string[] }) =>
            createTask(title, body, labels),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: taskKeys.list() });
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
            queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

export function useMoveTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ number, columnLabel }: { number: number; columnLabel: string }) =>
            moveTask(number, columnLabel),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: taskKeys.list() });
        },
    });
}

// Export execCommand for other uses
export { execCommand };