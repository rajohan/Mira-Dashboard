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

/** Builds the query key for a specific live-feed session snapshot. */
function createLiveFeedListKey(sessionSignature: string, updatedSignature: string) {
    return [...liveFeedKeys.all, sessionSignature, updatedSignature] as const;
}

/** Defines live feed keys. */
export const liveFeedKeys = {
    all: ["live-feed"] as const,
    list: createLiveFeedListKey,
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

/** Returns the display label used to identify a session in the live feed. */
function getSessionFeedLabel(session: Session): string {
    return session.displayLabel || session.displayName || session.key;
}

/** Normalizes transcript roles for stable live-feed filtering. */
function normalizeFeedRole(role: string): string {
    const rawRole = role.toLowerCase().replaceAll(/[.\s-]+/g, "_");

    if (rawRole === "toolresult" || rawRole === "tool_result") {
        return "tool_result";
    }

    if (
        rawRole === "tool" ||
        rawRole === "toolcall" ||
        rawRole === "tool_call" ||
        rawRole === "tooluse" ||
        rawRole === "tool_use" ||
        rawRole === "function_call"
    ) {
        return "tool";
    }

    if (rawRole === "developer") {
        return "system";
    }

    return rawRole;
}

/** Converts one API history message into a dashboard feed item. */
function toFeedItem(
    session: Session,
    message: SessionHistoryResponse["messages"][number],
    index: number
): FeedItem {
    const fallbackTimestamp = session.updatedAt || Date.now();
    const parsedTimestamp = message.timestamp
        ? new Date(message.timestamp).getTime()
        : fallbackTimestamp;

    return {
        id: `${session.key}-${index}-${parsedTimestamp}`,
        sessionKey: session.key,
        sessionLabel: getSessionFeedLabel(session),
        sessionType: (session.type || "unknown").toUpperCase(),
        role: normalizeFeedRole(String(message.role || "unknown")),
        content: String(message.content || "").trim(),
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallbackTimestamp,
    };
}

/** Fetches recent feed items for one session, returning an empty list on failure. */
async function fetchSessionFeedItems(session: Session): Promise<FeedItem[]> {
    let history: SessionHistoryResponse;
    try {
        history = await apiFetchRequired<SessionHistoryResponse>(
            `/sessions/${encodeURIComponent(session.key)}/history?limit=20&offset=0`
        );
    } catch (error) {
        console.error("Failed to fetch feed items for session:", session.key, error);
        return [];
    }

    const messages = Array.isArray(history.messages) ? history.messages : [];
    return messages.map((message, index) => toFeedItem(session, message, index));
}

/** Fetches and merges live-feed items for the provided session candidates. */
async function fetchLiveFeedItems(sessions: Session[]): Promise<FeedItem[]> {
    const historyBySession = await Promise.all(
        sessions.map((session) => fetchSessionFeedItems(session))
    );

    return historyBySession
        .flat()
        .filter((item) => item.content.length > 0)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 300);
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
        queryFn: () => fetchLiveFeedItems(feedSessionCandidates),
    });
}
