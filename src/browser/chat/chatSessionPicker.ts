import type { ChatSessionOption } from "./chatTypes.ts";

/** One agent selector row derived only from the reviewed session inventory. */
export interface ChatAgentOption {
    readonly description: string;
    readonly label: string;
    readonly value: string;
}

/**
 * Extracts the normalized OpenClaw agent scope from one exact session key.
 * @param sessionKey Exact provider session key.
 * @returns Lowercase agent id or the explicit unknown bucket.
 */
export function chatAgentIdFromSessionKey(sessionKey: string): string {
    const [scope = "", agentId = ""] = sessionKey.split(":", 2);
    return scope.toLowerCase() === "agent" && agentId !== ""
        ? agentId.toLowerCase()
        : "unknown";
}

function compareSessions(left: ChatSessionOption, right: ChatSessionOption): number {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    const leftIsMain = left.key.split(":")[2]?.toLowerCase() === "main";
    const rightIsMain = right.key.split(":")[2]?.toLowerCase() === "main";
    if (leftIsMain !== rightIsMain) return leftIsMain ? -1 : 1;
    return (
        right.activeRunCount - left.activeRunCount ||
        (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) ||
        left.displayName.localeCompare(right.displayName) ||
        left.key.localeCompare(right.key)
    );
}

/**
 * Builds a stable main-first agent inventory with bounded session counts.
 * @param sessions Current projected chat sessions.
 * @returns Unique agent picker rows.
 */
export function chatAgentOptions(
    sessions: readonly ChatSessionOption[]
): readonly ChatAgentOption[] {
    const counts = new Map<string, number>();
    for (const session of sessions) {
        const agentId = chatAgentIdFromSessionKey(session.key);
        counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    }
    return [...counts]
        .toSorted(([left], [right]) => {
            if (left === "main") return -1;
            if (right === "main") return 1;
            return left.localeCompare(right);
        })
        .map(([agentId, count]) => ({
            description: `${count} session${count === 1 ? "" : "s"}`,
            label: agentId === "unknown" ? "Other / unknown" : agentId,
            value: agentId,
        }));
}

/**
 * Filters and orders the session selector for one chosen agent.
 * @param sessions Current projected chat sessions.
 * @param agentId Normalized selected agent id.
 * @returns Default/active/recent sessions for only that agent.
 */
export function chatSessionsForAgent(
    sessions: readonly ChatSessionOption[],
    agentId: string
): readonly ChatSessionOption[] {
    return sessions
        .filter((session) => chatAgentIdFromSessionKey(session.key) === agentId)
        .toSorted(compareSessions);
}

/**
 * Formats an exact agent-scoped key relative to the selected agent.
 * @param session Session picker row.
 * @param agentId Normalized selected agent id.
 * @returns Agent-relative suffix or the reviewed display-name fallback.
 */
export function chatSessionLabelForAgent(
    session: ChatSessionOption,
    agentId: string
): string {
    const [scope = "", keyAgentId = "", ...sessionParts] = session.key.split(":");
    if (
        scope.toLowerCase() === "agent" &&
        keyAgentId.toLowerCase() === agentId &&
        sessionParts.length > 0
    ) {
        return sessionParts.join(":");
    }
    return session.displayName;
}
