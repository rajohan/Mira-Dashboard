import { Link } from "@tanstack/react-router";
import { Bell, BellRing } from "lucide-react";
import { useState } from "react";

import {
    useClearReadNotifications,
    useDeleteNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
} from "../../hooks";
import type { NotificationItem } from "../../hooks/useNotifications";
import { AUTO_REFRESH_MS } from "../../lib/queryClient";
import { formatDate } from "../../utils/format";
import { Badge } from "../ui/Badge";
import { Dropdown } from "../ui/Dropdown";

/** Defines notification filter. */
type NotificationFilter = "all" | "unread" | "warning";

const NOTIFICATION_ACTION_CLASS =
    "rounded-md border border-primary-600 px-2 py-1 text-xs text-primary-200 hover:bg-primary-700";

/** Returns a sortable timestamp for notifications with graceful fallbacks. */
function getNotificationTimestamp(notification: NotificationItem): number {
    const occurredAt = Date.parse(notification.occurredAt);

    if (!Number.isNaN(occurredAt)) {
        return occurredAt;
    }

    const createdAt = Date.parse(notification.createdAt);
    return Number.isNaN(createdAt) ? 0 : createdAt;
}

/** Formats notification time without surfacing invalid Date text. */
function formatNotificationTime(notification: NotificationItem): string {
    const timestamp = getNotificationTimestamp(notification);

    return timestamp > 0 ? formatDate(timestamp) : "Unknown time";
}

function reportIdFromNotification(notification: NotificationItem): number | undefined {
    const value = notification.metadata.reportId;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}

/** Renders the notification bell UI. */
export function NotificationBell() {
    const { data: notifications } = useNotifications(AUTO_REFRESH_MS);
    const markNotificationRead = useMarkNotificationRead();
    const markAllRead = useMarkAllNotificationsRead();
    const clearRead = useClearReadNotifications();
    const deleteNotification = useDeleteNotification();
    const [filter, setFilter] = useState<NotificationFilter>("all");

    const items = notifications?.items || [];
    const unreadCount = notifications?.unreadCount || 0;
    const readCount = notifications?.readCount || 0;
    const notificationMenuLabel =
        unreadCount === 0
            ? "Open notifications"
            : `Open notifications, ${unreadCount} unread`;

    const sortedItems = [...items].toSorted(
        (a, b) => getNotificationTimestamp(b) - getNotificationTimestamp(a)
    );

    const filteredItems = sortedItems.filter((notification) => {
        if (filter === "unread") return !notification.isRead;
        if (filter === "warning") return notification.type === "warning";
        return true;
    });

    return (
        <Dropdown
            align="right"
            ariaLabel={notificationMenuLabel}
            variant="ghost"
            icon={
                <span className="relative inline-flex">
                    {unreadCount > 0 ? (
                        <BellRing className="size-5" />
                    ) : (
                        <Bell className="size-5" />
                    )}
                    {unreadCount > 0 && (
                        <span className="absolute -top-2 -right-2 rounded-full bg-accent-500 px-1.5 text-[10px] font-semibold text-white">
                            {unreadCount}
                        </span>
                    )}
                </span>
            }
            content={
                <div className="w-95 p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                            Notifications
                        </h2>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className={NOTIFICATION_ACTION_CLASS}
                                onClick={() => clearRead.mutate()}
                                disabled={readCount === 0}
                            >
                                Clear all read
                            </button>
                            <button
                                type="button"
                                className={NOTIFICATION_ACTION_CLASS}
                                onClick={() => markAllRead.mutate()}
                                disabled={unreadCount === 0}
                            >
                                Mark all read
                            </button>
                        </div>
                    </div>

                    <div className="mb-2 flex gap-2">
                        {(
                            [
                                ["all", "All"],
                                ["unread", "Unread"],
                                ["warning", "Warning"],
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                className={`rounded-md px-2 py-1 text-xs ${
                                    filter === value
                                        ? "bg-accent-500 text-white"
                                        : "border border-primary-600 text-primary-300 hover:bg-primary-700"
                                }`}
                                role="menuitemradio"
                                aria-checked={filter === value}
                                onClick={() => setFilter(value)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="max-h-80 space-y-2 overflow-y-auto">
                        {filteredItems.length === 0 ? (
                            <p className="text-sm text-primary-400">
                                No notifications for this filter.
                            </p>
                        ) : (
                            filteredItems.map((notification) => (
                                <div
                                    key={notification.id}
                                    className="w-full rounded-lg border border-primary-700 bg-primary-800/30 px-3 py-2 text-left"
                                >
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <div className="inline-flex items-center gap-2">
                                            <Badge variant={notification.type}>
                                                {notification.type}
                                            </Badge>
                                            {!notification.isRead && (
                                                <Badge variant="success">unread</Badge>
                                            )}
                                        </div>
                                        <span className="text-xs text-primary-500">
                                            {formatNotificationTime(notification)}
                                        </span>
                                    </div>
                                    <div className="text-sm text-primary-100">
                                        {notification.title}
                                    </div>
                                    <div className="line-clamp-2 text-xs text-primary-300">
                                        {notification.description}
                                    </div>
                                    <div className="mt-2 flex items-center gap-2">
                                        {reportIdFromNotification(notification) ? (
                                            <Link
                                                className={NOTIFICATION_ACTION_CLASS}
                                                to="/reports"
                                                search={{
                                                    reportId:
                                                        reportIdFromNotification(
                                                            notification
                                                        ),
                                                }}
                                            >
                                                Open report
                                            </Link>
                                        ) : undefined}
                                        {!notification.isRead && (
                                            <button
                                                type="button"
                                                className={NOTIFICATION_ACTION_CLASS}
                                                onClick={() =>
                                                    markNotificationRead.mutate(
                                                        notification.id
                                                    )
                                                }
                                            >
                                                Mark read
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className={NOTIFICATION_ACTION_CLASS}
                                            onClick={() =>
                                                deleteNotification.mutate(notification.id)
                                            }
                                        >
                                            Clear
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            }
        />
    );
}
