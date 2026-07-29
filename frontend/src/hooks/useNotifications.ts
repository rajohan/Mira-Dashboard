import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type CreateNotificationInput,
    parseCreateNotificationResponse,
    parseDeleteNotificationsResponse,
    parseNotificationMutationResponse,
    parseNotificationsResponse,
} from "../../../contracts/notifications";
import { apiDeleteParsed, apiFetchParsed, apiPostParsed } from "./useApi";

/**
 * Fetches notifications.
 * @returns Fetch notifications result.
 */
function fetchNotifications() {
    return apiFetchParsed("/notifications", parseNotificationsResponse);
}

/**
 * Provides notifications.
 * @param refreshInterval Refresh interval value.
 * @returns The notifications.
 */
export function useNotifications(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["notifications"],
        queryFn: fetchNotifications,
        refetchInterval: refreshInterval,
        staleTime: 2000,
    });
}

/**
 * Provides create notification.
 * @returns The create notification.
 */
export function useCreateNotification() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (payload: CreateNotificationInput) =>
            apiPostParsed("/notifications", parseCreateNotificationResponse, payload),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

/**
 * Provides mark notification read.
 * @returns The mark notification read.
 */
export function useMarkNotificationRead() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) =>
            apiPostParsed(`/notifications/${id}/read`, parseNotificationMutationResponse),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

/**
 * Provides mark all notifications read.
 * @returns The mark all notifications read.
 */
export function useMarkAllNotificationsRead() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostParsed(
                "/notifications/mark-all-read",
                parseNotificationMutationResponse
            ),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

/**
 * Provides clear read notifications.
 * @returns The clear read notifications.
 */
export function useClearReadNotifications() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostParsed(
                "/notifications/clear-read",
                parseDeleteNotificationsResponse,
                {}
            ),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}

/**
 * Provides delete notification.
 * @returns The delete notification.
 */
export function useDeleteNotification() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) =>
            apiDeleteParsed(`/notifications/${id}`, parseDeleteNotificationsResponse),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        },
    });
}
