import { CheckCheck, ExternalLink, Trash2 } from "lucide-react";
import type { Ref } from "react";

import type { NotificationRecord } from "../../contracts/monitoring.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    notificationDestination,
    notificationSeverityBadgeVariant,
} from "./notificationPresentation.ts";

interface NotificationListItemProps {
    readonly actionsDisabled: boolean;
    readonly itemRef: Ref<HTMLElement>;
    readonly notification: NotificationRecord;
    readonly onDelete: (id: string) => void;
    readonly onMarkRead: (id: string) => void;
}

/** @returns One safe-text notification row with exact entity actions. */
export function NotificationListItem({
    actionsDisabled,
    itemRef,
    notification,
    onDelete,
    onMarkRead,
}: NotificationListItemProps) {
    const destination = notificationDestination(notification);
    const unread = notification.readAtMs === undefined;
    const titleId = `notification-${notification.id}-title`;
    const actionDetails = [
        formatDashboardDateTime(notification.occurredAtMs),
        notification.severity,
        notification.source ?? notification.kind,
        ...(notification.incidentGeneration === undefined
            ? []
            : [`incident generation ${notification.incidentGeneration}`]),
        `reference ${notification.id.slice(-8)}`,
    ].join(", ");

    return (
        <li>
            <article
                aria-labelledby={titleId}
                className={
                    unread
                        ? "border-accent-500/35 bg-accent-950/25 rounded-lg border p-3"
                        : "border-primary-700 bg-primary-900 rounded-lg border p-3"
                }
                ref={itemRef}
                tabIndex={-1}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3
                                className="text-primary-50 text-sm font-semibold wrap-anywhere"
                                id={titleId}
                            >
                                {notification.title}
                            </h3>
                            {unread && (
                                <>
                                    <span
                                        aria-hidden="true"
                                        className="bg-accent-400 size-2 rounded-full"
                                    />
                                    <span className="sr-only">Unread notification</span>
                                </>
                            )}
                        </div>
                        <Text className="mt-1 wrap-anywhere" size="sm">
                            {notification.message}
                        </Text>
                    </div>
                    <Badge
                        variant={notificationSeverityBadgeVariant(notification.severity)}
                    >
                        <span className="capitalize">{notification.severity}</span>
                    </Badge>
                </div>
                <Text className="mt-2 wrap-anywhere" size="sm" tone="muted">
                    {formatDashboardDateTime(notification.occurredAtMs)} ·{" "}
                    {notification.kind}
                    {notification.source === undefined ? "" : ` · ${notification.source}`}
                </Text>
                <div className="mt-3 flex flex-wrap gap-2">
                    {destination !== undefined && (
                        <a
                            aria-label={`${destination.label} for ${notification.title} (${actionDetails})`}
                            className={buttonClassNames({
                                size: "sm",
                                variant: "secondary",
                            })}
                            href={destination.href}
                        >
                            <Icon icon={ExternalLink} size="sm" tone="inherit" />
                            {destination.label}
                        </a>
                    )}
                    {unread && (
                        <Button
                            aria-label={`Mark ${notification.title} read (${actionDetails})`}
                            data-notification-mark-read="true"
                            disabled={actionsDisabled}
                            onClick={() => onMarkRead(notification.id)}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={CheckCheck} size="sm" tone="inherit" />
                            Mark read
                        </Button>
                    )}
                    <Button
                        aria-label={`Delete notification: ${notification.title} (${actionDetails})`}
                        data-notification-delete="true"
                        disabled={actionsDisabled}
                        onClick={() => onDelete(notification.id)}
                        size="sm"
                        variant="ghost"
                    >
                        <Icon icon={Trash2} size="sm" tone="inherit" />
                        Delete
                    </Button>
                </div>
            </article>
        </li>
    );
}
