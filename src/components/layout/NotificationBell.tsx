import { Bell, BellRing } from "lucide-react";
import { useEffect, useState } from "react";

import {
    hasQuotaStatus,
    useCreateNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
    useQuotas,
} from "../../hooks";
import { AUTO_REFRESH_MS } from "../../lib/queryClient";
import { formatDate } from "../../utils/format";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

interface NotificationBellProps {
    isConnected: boolean;
}

export function NotificationBell({ isConnected }: NotificationBellProps) {
    const { data: notifications } = useNotifications(isConnected ? AUTO_REFRESH_MS : false);
    const { data: quotas } = useQuotas(isConnected ? AUTO_REFRESH_MS : false);
    const createNotification = useCreateNotification();
    const markNotificationRead = useMarkNotificationRead();
    const markAllRead = useMarkAllNotificationsRead();
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        if (!quotas) return;

        const quotaEntries: Array<{ key: string; title: string; description: string; percent: number }> = [];

        if (!hasQuotaStatus(quotas.openrouter) && (quotas.openrouter.percentUsed || 0) >= 80) {
            quotaEntries.push({
                key: "openrouter",
                title: "OpenRouter usage high",
                description: `${quotas.openrouter.percentUsed}% used ($${quotas.openrouter.remaining.toFixed(2)} remaining)`,
                percent: quotas.openrouter.percentUsed || 0,
            });
        }

        if (!hasQuotaStatus(quotas.elevenlabs) && (quotas.elevenlabs.percentUsed || 0) >= 80) {
            quotaEntries.push({
                key: "elevenlabs",
                title: "ElevenLabs usage high",
                description: `${quotas.elevenlabs.percentUsed}% used (${quotas.elevenlabs.remaining.toLocaleString()} chars remaining)`,
                percent: quotas.elevenlabs.percentUsed || 0,
            });
        }

        if (!hasQuotaStatus(quotas.zai)) {
            const highest = Math.max(quotas.zai.fiveHour.usedPercentage, quotas.zai.weekly.usedPercentage);
            if (highest >= 80) {
                quotaEntries.push({
                    key: "zai",
                    title: "Z.ai usage high",
                    description: `5h ${quotas.zai.fiveHour.usedPercentage}% · weekly ${quotas.zai.weekly.usedPercentage}%`,
                    percent: highest,
                });
            }
        }

        if (!hasQuotaStatus(quotas.openai) && (quotas.openai.percentUsed || 0) >= 80) {
            quotaEntries.push({
                key: "openai",
                title: "OpenAI API usage high",
                description: `${quotas.openai.percentUsed}% of hard limit used`,
                percent: quotas.openai.percentUsed || 0,
            });
        }

        for (const entry of quotaEntries) {
            const severityBucket = entry.percent >= 95 ? "95" : entry.percent >= 90 ? "90" : "80";
            const dedupeKey = `quota:${entry.key}:${severityBucket}`;
            createNotification.mutate({
                title: entry.title,
                description: entry.description,
                type: "warning",
                source: "quota",
                dedupeKey,
                metadata: { provider: entry.key, percent: entry.percent },
                occurredAt: new Date(quotas.checkedAt).toISOString(),
            });
        }
    }, [createNotification, quotas]);

    const items = notifications?.items || [];
    const unreadCount = notifications?.unreadCount || 0;

    const sortedItems = [...items].sort(
        (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
    );

    return (
        <div className="relative">
            <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsOpen((prev) => !prev)}
                className="relative"
            >
                {unreadCount > 0 ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
                {unreadCount > 0 && (
                    <span className="absolute -right-1 -top-1 rounded-full bg-accent-500 px-1.5 text-[10px] font-semibold text-white">
                        {unreadCount}
                    </span>
                )}
            </Button>

            {isOpen && (
                <div className="absolute right-0 top-11 w-[380px] rounded-lg border border-primary-700 bg-primary-900 p-3 shadow-2xl">
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                            Notifications
                        </h2>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => markAllRead.mutate()}
                            disabled={items.length === 0}
                        >
                            Mark all read
                        </Button>
                    </div>

                    <div className="max-h-80 space-y-2 overflow-y-auto">
                        {sortedItems.length === 0 ? (
                            <p className="text-sm text-primary-400">No notifications yet.</p>
                        ) : (
                            sortedItems.map((notification) => (
                                <button
                                    key={notification.id}
                                    type="button"
                                    className="w-full rounded-lg border border-primary-700 bg-primary-800/30 px-3 py-2 text-left"
                                    onClick={() => {
                                        if (!notification.isRead) {
                                            markNotificationRead.mutate(notification.id);
                                        }
                                    }}
                                >
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <div className="inline-flex items-center gap-2">
                                            <Badge variant={notification.type === "warning" ? "warning" : "info"}>
                                                {notification.type}
                                            </Badge>
                                            {!notification.isRead && <Badge variant="success">unread</Badge>}
                                        </div>
                                        <span className="text-xs text-primary-500">
                                            {formatDate(new Date(notification.occurredAt))}
                                        </span>
                                    </div>
                                    <div className="text-sm text-primary-100">{notification.title}</div>
                                    <div className="line-clamp-2 text-xs text-primary-300">
                                        {notification.description}
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
