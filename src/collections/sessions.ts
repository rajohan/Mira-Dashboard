import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import type { Session } from "../types/session";

/** Handles get session collection key. */
function getSessionCollectionKey(item: Partial<Session>): string | null {
    const key = item.key || item.id;
    return typeof key === "string" && key.trim().length > 0 ? key : null;
}

/** Handles is writable session. */
function isWritableSession(item: unknown): item is Session {
    return (
        !!item &&
        typeof item === "object" &&
        getSessionCollectionKey(item as Partial<Session>) !== null
    );
}

/** Stores sessions collection. */
export const sessionsCollection = createCollection(
    queryCollectionOptions({
        queryKey: ["sessions"],
        queryFn: async () => [],
        queryClient,
        staleTime: Number.POSITIVE_INFINITY,
        getKey: (item: Session) => getSessionCollectionKey(item) || "unknown-session",
    })
);

void sessionsCollection.preload();

/** Handles delete session from collection. */
export function deleteSessionFromCollection(key: string) {
    if (!sessionsCollection.isReady()) {
        return;
    }

    for (const [existingKey] of sessionsCollection) {
        if (String(existingKey) !== key) {
            continue;
        }

        try {
            sessionsCollection.utils.writeDelete(key);
        } catch (error) {
            if (!(error instanceof Error && error.message.includes("does not exist"))) {
                throw error;
            }
        }
        return;
    }
}

/** Handles replace sessions from web socket. */
export function replaceSessionsFromWebSocket(sessions: unknown) {
    if (!sessionsCollection.isReady()) {
        return;
    }

    const writableSessions = Array.isArray(sessions)
        ? sessions.filter(isWritableSession)
        : [];

    const nextKeys = new Set<string>(
        writableSessions.map((session) => String(getSessionCollectionKey(session)))
    );

    for (const [existingKey] of sessionsCollection) {
        if (!nextKeys.has(String(existingKey))) {
            deleteSessionFromCollection(String(existingKey));
        }
    }

    for (const session of writableSessions) {
        sessionsCollection.utils.writeUpsert(
            session as unknown as Partial<Record<string, unknown>>
        );
    }
}
