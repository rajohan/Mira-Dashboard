import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AUTO_REFRESH_MS } from "../lib/queryClient";
import { apiFetch, apiPost } from "./useApi";

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

export function useNotifications(refreshInterval: number | false = AUTO_REFRESH_MS) {
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
