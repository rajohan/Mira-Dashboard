import { useLiveQuery } from "@tanstack/react-db";
import { Bell } from "lucide-react";

import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { useObservedQueryState } from "../api/useObservedQueryState.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { Icon } from "../ui/Icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/Popover.tsx";
import { NotificationPanel } from "./NotificationPanel.tsx";
import { notificationLatestQueryKey } from "./notificationQueries.ts";
import { useNotificationRealtimeInvalidation } from "./useNotificationRealtimeInvalidation.ts";

/** @returns Global authenticated notification status and its on-demand panel. */
export function NotificationCenter() {
    useNotificationRealtimeInvalidation();
    const collection = useDashboardBrowserCollections().notifications;
    const latestRows = useLiveQuery(collection);
    const latestState = useObservedQueryState<ListNotificationsResult>(
        notificationLatestQueryKey
    );
    const unreadCount = latestState?.data?.unreadCount;
    let triggerLabel: string;
    if (unreadCount === undefined) {
        triggerLabel =
            latestState?.status === "error"
                ? "Notifications, unread count unavailable"
                : "Notifications, unread count loading";
    } else {
        triggerLabel =
            unreadCount === 0
                ? "Notifications, none unread"
                : `Notifications, ${unreadCount} unread`;
    }

    return (
        <Popover className="relative">
            {unreadCount !== undefined && (
                <output aria-atomic="true" aria-live="polite" className="sr-only">
                    Notification status: {unreadCount} unread.
                </output>
            )}
            <PopoverTrigger
                aria-label={triggerLabel}
                className="relative size-10 px-0"
                size="sm"
                title={triggerLabel}
                variant="ghost"
            >
                <Icon icon={Bell} tone="inherit" />
                {unreadCount !== undefined && unreadCount > 0 && (
                    <span
                        aria-hidden="true"
                        className="bg-accent-500 text-primary-950 absolute -top-1 -right-1 min-w-5 rounded-full px-1 text-center text-xs leading-5 font-bold"
                    >
                        {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                )}
            </PopoverTrigger>
            <PopoverContent
                anchored={false}
                className="absolute top-full right-0 mt-2 flex w-[min(32rem,calc(100vw-1rem))] flex-col"
            >
                <NotificationPanel
                    latestError={latestState?.error ?? null}
                    latestLoading={latestRows.isLoading}
                    latestReady={latestRows.isReady}
                    latestResult={latestState?.data}
                    latestRows={latestRows.data ?? []}
                    onRetryLatest={() => void collection.utils.refetch()}
                />
            </PopoverContent>
        </Popover>
    );
}
