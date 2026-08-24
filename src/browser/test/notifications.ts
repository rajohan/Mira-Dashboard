import type { ListNotificationsResult } from "../../contracts/notifications.ts";

/** Empty authoritative notification projection for unrelated route tests. */
export const emptyNotificationListResult = Object.freeze({
    notifications: [],
    readCount: 0,
    unreadCount: 0,
} satisfies ListNotificationsResult);
