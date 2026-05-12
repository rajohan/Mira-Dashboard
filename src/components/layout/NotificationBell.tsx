import { Bell, BellRing } from "lucide-react";
import { useState } from "react";

import {
    useClearReadNotifications,
    useDeleteNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
} from "../../hooks";
import { AUTO_REFRESH_MS } from "../../lib/queryClient";
import { formatDate } from "../../utils/format";
import { Badge } from "../ui/Badge";
import { Dropdown } from "../ui/Dropdown";

/** Defines notification filter. */
type NotificationFilter = "all" | "unread" | "warning";

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

    const sortedItems = [...items].sort(
        (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
    );

    const filteredItems = sortedItems.filter((notification) => {
        if (filter === "unread") return !notification.isRead;
        if (filter === "warning") return notification.type === "warning";
        return true;
    });

    return (
        <Dropdown
            align="right"
            variant="ghost"
            icon={
                <span className="relative inline-flex">
                    {unreadCount > 0 ? (
                        <BellRing className="h-5 w-5" />
                    ) : (
                        <Bell className="h-5 w-5" />
                    )}
                    {unreadCount > 0 && (
                        <span className="bg-accent-500 absolute -top-2 -right-2 rounded-full px-1.5 text-[10px] font-semibold text-white">
                            {unreadCount}
                        </span>
                    )}
                </span>
            }
            content={
                <div className="w-[380px] p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <h2 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                            Notifications
                        </h2>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="border-primary-600 text-primary-200 hover:bg-primary-700 rounded-md border px-2 py-1 text-xs"
                                onClick={() => clearRead.mutate()}
                                disabled={items.length === 0}
                            >
                                Clear read
                            </button>
                            <button
                                type="button"
                                className="border-primary-600 text-primary-200 hover:bg-primary-700 rounded-md border px-2 py-1 text-xs"
                                onClick={() => markAllRead.mutate()}
                                disabled={items.length === 0}
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
                                        : "border-primary-600 text-primary-300 hover:bg-primary-700 border"
                                }`}
                                onClick={() => setFilter(value)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="max-h-80 space-y-2 overflow-y-auto">
                        {filteredItems.length === 0 ? (
                            <p className="text-primary-400 text-sm">
                                No notifications for this filter.
                            </p>
                        ) : (
                            filteredItems.map((notification) => (
                                <div
                                    key={notification.id}
                                    className="border-primary-700 bg-primary-800/30 w-full rounded-lg border px-3 py-2 text-left"
                                >
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <div className="inline-flex items-center gap-2">
                                            <Badge
                                                variant={
                                                    notification.type === "warning"
                                                        ? "warning"
                                                        : "info"
                                                }
                                            >
                                                {notification.type}
                                            </Badge>
                                            {!notification.isRead && (
                                                <Badge variant="success">unread</Badge>
                                            )}
                                        </div>
                                        <span className="text-primary-500 text-xs">
                                            {formatDate(
                                                new Date(notification.occurredAt)
                                            )}
                                        </span>
                                    </div>
                                    <div className="text-primary-100 text-sm">
                                        {notification.title}
                                    </div>
                                    <div className="text-primary-300 line-clamp-2 text-xs">
                                        {notification.description}
                                    </div>
                                    <div className="mt-2 flex items-center gap-2">
                                        {!notification.isRead && (
                                            <button
                                                type="button"
                                                className="border-primary-600 text-primary-200 hover:bg-primary-700 rounded-md border px-2 py-1 text-xs"
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
                                            className="border-primary-600 text-primary-200 hover:bg-primary-700 rounded-md border px-2 py-1 text-xs"
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
