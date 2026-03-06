import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiFetch, apiPost } from "./useApi";

export interface NotificationItem {
    id: number;
    title: string;
    description: string;
    type: "info" | "warning" | "error" | "success";
    source: string | null;
    dedupeKey: string | null;
    metadata: Record<string, unknown>;
    isRead: boolean;
    createdAt: string;
    updatedAt: string;
    occurredAt: string;
}

export interface NotificationsResponse {
    items: NotificationItem[];
    unreadCount: number;
}

interface CreateNotificationInput {
    title: string;
    description: string;
    type?: "info" | "warning" | "error" | "success";
    source?: string;
    dedupeKey?: string;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
}

function fetchNotifications() {
    return apiFetch<NotificationsResponse>("/notifications");
}

export function useNotifications(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["notifications"],
        queryFn: fetchNotifications,
        refetchInterval: refreshInterval,
        staleTime: 2_000,
    });
}

export function useCreateNotification() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (payload: CreateNotificationInput) =>
            apiPost<{ ok: boolean; id: number | null }>("/notifications", payload),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

export function useMarkNotificationRead() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiPost<{ ok: boolean }>(`/notifications/${id}/read`),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

export function useMarkAllNotificationsRead() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPost<{ ok: boolean }>("/notifications/mark-all-read"),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

export function useClearReadNotifications() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPost<{ ok: boolean; deleted: number }>("/notifications/clear-read"),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

export function useDeleteNotification() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) =>
            apiDelete<{ ok: boolean; deleted: number }>(`/notifications/${id}`),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}
