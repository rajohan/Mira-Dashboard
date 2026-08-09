import { Bell } from "lucide-react";
import { useId } from "react";

import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import {
    notificationDestination,
    notificationSeverityBadgeVariant,
} from "../notifications/notificationPresentation.ts";
import { Badge } from "../ui/Badge.tsx";
import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

export interface OverviewNotificationsCardProps {
    readonly result: ListNotificationsResult;
}

/**
 * Renders exact global read counts and one bounded newest notification window.
 * @param properties Validated authoritative notification projection.
 * @returns Read-only notification overview without mutation controls.
 */
export function OverviewNotificationsCard({ result }: OverviewNotificationsCardProps) {
    const headingId = useId();
    const latestHeadingId = useId();
    const latest = result.notifications[0];
    const destination =
        latest === undefined ? undefined : notificationDestination(latest);

    return (
        <Card aria-labelledby={headingId} className="h-full">
            <div className="flex min-w-0 items-start gap-3">
                <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                    <Icon icon={Bell} tone="accent" />
                </span>
                <div className="min-w-0">
                    <Heading id={headingId} level={2} size="subsection">
                        Notifications
                    </Heading>
                    <Text className="mt-1" size="sm" tone="muted">
                        Exact global read counts and the bounded newest window. Use the
                        notification bell for history and actions.
                    </Text>
                </div>
            </div>

            <dl className="mt-5 grid grid-cols-3 gap-3">
                {[
                    ["Unread", result.unreadCount],
                    ["Read", result.readCount],
                    ["Newest 100", result.notifications.length],
                ].map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                        key={label}
                    >
                        <dt className="text-primary-400 text-xs">{label}</dt>
                        <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>

            {latest === undefined ? (
                <div className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4">
                    <Text>No notifications.</Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        Monitoring notifications will appear here and in the global bell.
                    </Text>
                </div>
            ) : (
                <section
                    aria-labelledby={latestHeadingId}
                    className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge
                            variant={notificationSeverityBadgeVariant(latest.severity)}
                        >
                            <span className="capitalize">{latest.severity}</span>
                        </Badge>
                        <Badge
                            variant={latest.readAtMs === undefined ? "info" : "default"}
                        >
                            {latest.readAtMs === undefined ? "unread" : "read"}
                        </Badge>
                    </div>
                    <Heading
                        className="mt-3 line-clamp-2 wrap-break-word"
                        id={latestHeadingId}
                        level={3}
                    >
                        {latest.title}
                    </Heading>
                    <Text className="mt-2 line-clamp-2 wrap-break-word" tone="muted">
                        {latest.message}
                    </Text>
                    <time
                        className="text-primary-400 mt-3 block text-xs"
                        dateTime={new Date(latest.occurredAtMs).toISOString()}
                    >
                        {formatDashboardDateTime(latest.occurredAtMs)}
                    </time>
                    {destination !== undefined && (
                        <a
                            className={buttonClassNames({
                                className: "mt-3",
                                size: "sm",
                                variant: "secondary",
                            })}
                            href={destination.href}
                        >
                            {destination.label}
                        </a>
                    )}
                </section>
            )}

            {result.nextCursor !== undefined && (
                <Text className="mt-3" size="sm" tone="muted">
                    Older notifications are available from the global notification bell.
                </Text>
            )}
        </Card>
    );
}
