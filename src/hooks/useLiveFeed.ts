import { useQuery } from "@tanstack/react-query";

import { type Session } from "../types/session";
import { apiFetchRequired } from "./useApi";

/** Represents the session history API response. */
interface SessionHistoryResponse {
    messages: Array<{ role: string; content: string; timestamp?: string }>;
}

/** Represents feed item. */
export interface FeedItem {
    id: string;
    sessionKey: string;
    sessionLabel: string;
    sessionType: string;
    role: string;
    content: string;
    timestamp: number;
}

/** Defines live feed keys. */
export const liveFeedKeys = {
    all: ["live-feed"] as const,
    list: (sessionSignature: string, updatedSignature: string) =>
        [...liveFeedKeys.all, sessionSignature, updatedSignature] as const,
};

/** Returns whether feed session. */
function isFeedSession(session: unknown): session is Session {
    return (
        !!session &&
        typeof session === "object" &&
        typeof (session as Session).key === "string" &&
        (session as Session).key.trim().length > 0
    );
}

/** Provides live feed. */
export function useLiveFeed(sessions: Session[], refreshInterval: number | false) {
    const feedSessionCandidates = Array.isArray(sessions)
        ? sessions.filter(isFeedSession).slice(0, 20)
        : [];
    const sessionSignature = feedSessionCandidates.map((s) => s.key).join("|");
    const updatedSignature = feedSessionCandidates.map((s) => s.updatedAt || 0).join("|");

    return useQuery({
        queryKey: liveFeedKeys.list(sessionSignature, updatedSignature),
        enabled: feedSessionCandidates.length > 0,
        refetchInterval: refreshInterval,
        staleTime: 2_000,
        queryFn: async () => {
            const historyBySession = await Promise.all(
                feedSessionCandidates.map(async (session) => {
                    let history: SessionHistoryResponse;
                    try {
                        history = await apiFetchRequired<SessionHistoryResponse>(
                            `/sessions/${encodeURIComponent(session.key)}/history?limit=20&offset=0`
                        );
                    } catch {
                        return [];
                    }

                    const messages = Array.isArray(history.messages)
                        ? history.messages
                        : [];

                    return messages.map((message, index) => {
                        const fallbackTimestamp = session.updatedAt || Date.now();
                        const parsedTimestamp = message.timestamp
                            ? new Date(message.timestamp).getTime()
                            : fallbackTimestamp;

                        const rawRole = String(message.role || "unknown").toLowerCase();
                        const normalizedRole =
                            rawRole === "toolresult" || rawRole === "tool-result"
                                ? "tool_result"
                                : rawRole;

                        return {
                            id: `${session.key}-${index}-${parsedTimestamp}`,
                            sessionKey: session.key,
                            sessionLabel:
                                session.displayLabel ||
                                session.displayName ||
                                session.key,
                            sessionType: (session.type || "unknown").toUpperCase(),
                            role: normalizedRole,
                            content: String(message.content || "").trim(),
                            timestamp: Number.isFinite(parsedTimestamp)
                                ? parsedTimestamp
                                : fallbackTimestamp,
                        } as FeedItem;
                    });
                })
            );

            return historyBySession
                .flat()
                .filter((item) => item.content.length > 0)
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 300);
        },
    });
}
