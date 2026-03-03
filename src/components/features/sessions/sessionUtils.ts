import type { Session } from "../../../hooks/useOpenClaw";

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

export function getTypeBadgeColor(type: string | null | undefined): string {
    const t = (type || "unknown").toUpperCase();
    switch (t) {
        case "MAIN": {
            return "bg-blue-500/20 text-blue-400 border-blue-500/30";
        }
        case "HOOK": {
            return "bg-green-500/20 text-green-400 border-green-500/30";
        }
        case "CRON": {
            return "bg-purple-500/20 text-purple-400 border-purple-500/30";
        }
        case "SUBAGENT": {
            return "bg-orange-500/20 text-orange-400 border-orange-500/30";
        }
        default: {
            return "bg-slate-500/20 text-slate-400 border-slate-500/30";
        }
    }
}

export const SESSION_TYPES = ["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"] as const;