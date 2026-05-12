import type { Session } from "../types/session";

/** Handles format session type. */
export function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) return session.agentType.toUpperCase();
    return type;
}

/** Handles get type sort order. */
export function getTypeSortOrder(type: string | null | undefined): number {
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

/** Handles get default chat sort order. */
function getDefaultChatSortOrder(session: Session): number {
    if (session.key === "agent:main:main") {
        return 0;
    }

    return 1;
}

/** Handles sort sessions by type and activity. */
export function sortSessionsByTypeAndActivity(sessions: Session[]): Session[] {
    return [...sessions].sort((a, b) => {
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

/** Stores session types. */
export const SESSION_TYPES = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"] as const;
