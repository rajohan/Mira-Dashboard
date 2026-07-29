import type { Session } from "../../../contracts/sessions";

/**
 * Formats session type for display.
 * @returns Formatted session type for display.
 */
export function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) return session.agentType.toUpperCase();
    return type;
}

/**
 * Returns type sort order.
 * @param type Type value.
 * @returns type sort order.
 */
export function getTypeSortOrder(type: string | undefined): number {
    const t = (type || "unknown").toUpperCase();
    switch (t) {
        case "MAIN": {
            return 0;
        }
        case "SUBAGENT": {
            return 1;
        }
        case "HOOK": {
            return 2;
        }
        case "CRON": {
            return 3;
        }
        default: {
            return 4;
        }
    }
}

/**
 * Returns the badge variant for a session type.
 * @param type Type value.
 * @returns the badge variant for a session type.
 */
export function getSessionTypeVariant(
    type?: string
): "cron" | "default" | "hook" | "main" | "subagent" {
    switch ((type || "unknown").toUpperCase()) {
        case "MAIN": {
            return "main";
        }
        case "HOOK": {
            return "hook";
        }
        case "CRON": {
            return "cron";
        }
        case "SUBAGENT": {
            return "subagent";
        }
        default: {
            return "default";
        }
    }
}

/**
 * Returns default chat sort order.
 * @returns default chat sort order.
 */
function getDefaultChatSortOrder(session: Session): number {
    if (session.key === "agent:main:main") {
        return 0;
    }

    return 1;
}

/**
 * Sorts sessions by type and activity.
 * @param sessions Sessions value.
 * @returns Sorted sessions by type and activity.
 */
export function sortSessionsByTypeAndActivity(sessions: Session[]): Session[] {
    return [...sessions].toSorted((a, b) => {
        const defaultChatOrder = getDefaultChatSortOrder(a) - getDefaultChatSortOrder(b);
        if (defaultChatOrder !== 0) {
            return defaultChatOrder;
        }

        const typeOrder = getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
        if (typeOrder !== 0) {
            return typeOrder;
        }

        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

/** Defines session types. */
export const SESSION_TYPES = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"] as const;
