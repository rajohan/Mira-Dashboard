import { useQuery } from "@tanstack/react-query";

import {
    compactStatusText,
    formatToolName,
    normalizeRuntimeStream,
    runtimeProgressText,
    stringValue,
} from "../components/features/chat/useChatRuntimeEvents";
import { type Session } from "../types/session";
import { type SocketEnvelope } from "../types/socket";
import { apiFetchRequired } from "./useApi";

/** Represents the session history API response. */
interface SessionHistoryResponse {
    messages: Array<{
        id?: number | string;
        role: string;
        content: string;
        timestamp?: string;
    }>;
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

/** Returns a plain object when the supplied runtime payload is record-like. */
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Creates a compact deterministic hash for feed fallback identifiers. */
function stableFeedHash(value: string): string {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.codePointAt(index) || 0;
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(36);
}

/** Normalizes optional session timestamps without using wall-clock fallbacks. */
function getSessionFallbackTimestamp(session: Session): number {
    if (typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)) {
        return session.updatedAt;
    }

    return 0;
}

/** Converts one API history message into a dashboard feed item. */
function toFeedItem(
    session: Session,
    message: SessionHistoryResponse["messages"][number],
    index: number
): FeedItem {
    const fallbackTimestamp = getSessionFallbackTimestamp(session);
    const parsedTimestamp = message.timestamp
        ? new Date(message.timestamp).getTime()
        : fallbackTimestamp;
    const timestamp = Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : fallbackTimestamp;

    return {
        id: getFeedMessageId(session, message, index, timestamp),
        sessionKey: session.key,
        sessionLabel: getSessionFeedLabel(session),
        sessionType: (session.type || "unknown").toUpperCase(),
        role: normalizeFeedRole(String(message.role || "unknown")),
        content: String(message.content || "").trim(),
        timestamp,
    };
}

/** Builds a stable row id, falling back to deterministic content fingerprints. */
function getFeedMessageId(
    session: Session,
    message: SessionHistoryResponse["messages"][number],
    index: number,
    timestamp: number
): string {
    if (
        message.id !== undefined &&
        message.id !== null &&
        String(message.id).length > 0
    ) {
        return `${session.key}-${message.id}`;
    }

    return `${session.key}-fallback-${stableFeedHash(
        [index, message.role || "unknown", timestamp, message.content || ""].join(
            "\u001F"
        )
    )}`;
}

/** Finds the feed session that owns an incoming Gateway runtime event. */
function findRuntimeFeedSession(
    sessions: Session[],
    payload: Record<string, unknown>
): Session | null {
    const sessionKey = stringValue(payload.sessionKey);
    if (sessionKey) {
        const normalizedSessionKey = sessionKey.toLowerCase();
        const matchingSession = sessions.find(
            (session) => session.key.toLowerCase() === normalizedSessionKey
        );

        if (matchingSession) {
            return matchingSession;
        }
    }

    const runId = stringValue(payload.runId);
    if (!runId) {
        return null;
    }

    return (
        sessions.find((session) =>
            [
                session.id,
                session.runId,
                session.activeRunId,
                session.currentRunId,
            ].includes(runId)
        ) || null
    );
}

/** Extracts compact display text from live Gateway session.message events. */
function runtimeMessageFeedText(payload: Record<string, unknown>): string | null {
    const raw = payload.message ?? payload.content ?? payload.deltaText ?? payload.text;
    if (typeof raw === "string") {
        return compactStatusText(raw);
    }

    if (Array.isArray(raw)) {
        const text = raw
            .map((item) => {
                const record = asRecord(item);
                return record ? stringValue(record.text) || "" : "";
            })
            .join("")
            .trim();

        return text ? compactStatusText(text) : null;
    }

    return null;
}

/** Returns whether a tool event is chat delivery noise rather than session work. */
function isDeliveryToolName(value: string): boolean {
    const normalized = value.startsWith("functions.")
        ? value.slice("functions.".length)
        : value;
    return [
        "message",
        "messages",
        "reply",
        "send",
        "reaction",
        "react",
        "typing",
    ].includes(normalized.toLowerCase());
}

/** Extracts compact display text from live Gateway session.tool events. */
function runtimeToolFeedText(
    eventName: string,
    stream: string,
    phase: string,
    data: Record<string, unknown>
): string | null {
    const progress = runtimeProgressText(eventName, stream, phase, data);
    if (progress) {
        return progress;
    }

    const toolName = stringValue(data.name) || stringValue(data.toolName);
    if (toolName && isDeliveryToolName(toolName)) {
        return null;
    }

    return toolName ? formatToolName(toolName) : null;
}

/** Converts one Gateway runtime websocket event into a live-feed item. */
export function feedItemFromSocketEvent(
    envelope: SocketEnvelope,
    sessions: Session[],
    receivedAt: number = Date.now()
): FeedItem | null {
    if (envelope.type !== "event" || typeof envelope.event !== "string") {
        return null;
    }

    if (envelope.event !== "session.message" && envelope.event !== "session.tool") {
        return null;
    }

    const payload = asRecord(envelope.payload);
    if (!payload) {
        return null;
    }

    const session = findRuntimeFeedSession(sessions, payload);
    if (!session) {
        return null;
    }

    const data = asRecord(payload.data) || payload;
    const stream = normalizeRuntimeStream(stringValue(payload.stream) || "");
    const phase = stringValue(data.phase) || "";
    const role = envelope.event === "session.tool" ? "tool" : "assistant";
    const content =
        envelope.event === "session.message"
            ? runtimeMessageFeedText(payload)
            : runtimeToolFeedText(envelope.event, stream, phase, data);

    if (!content) {
        return null;
    }

    const eventId =
        stringValue(payload.id) ||
        stringValue(data.id) ||
        stringValue(data.toolCallId) ||
        stringValue(data.tool_call_id) ||
        stringValue(data.callId) ||
        stableFeedHash(
            JSON.stringify([envelope.event, payload.runId, stream, phase, content])
        );

    return {
        id: `${session.key}-live-${eventId}-${receivedAt}`,
        sessionKey: session.key,
        sessionLabel: getSessionFeedLabel(session),
        sessionType: (session.type || "unknown").toUpperCase(),
        role,
        content,
        timestamp: receivedAt,
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

    /** Fetches live-feed items for the current candidate session snapshot. */
    function queryLiveFeedItems(): Promise<FeedItem[]> {
        return fetchLiveFeedItems(feedSessionCandidates);
    }

    return useQuery({
        queryKey: liveFeedKeys.list(sessionSignature, updatedSignature),
        enabled: feedSessionCandidates.length > 0,
        refetchInterval: refreshInterval,
        staleTime: 2_000,
        queryFn: queryLiveFeedItems,
    });
}
