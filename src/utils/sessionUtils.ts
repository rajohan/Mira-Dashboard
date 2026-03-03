import type { Session } from "../hooks/useOpenClaw";

export function formatSessionType(session: Session): string {
    const type = (session.type || "unknown").toUpperCase();
    if (type === "SUBAGENT" && session.agentType) return session.agentType.toUpperCase();
    return type;
}

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

export const SESSION_TYPES = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"] as const;
