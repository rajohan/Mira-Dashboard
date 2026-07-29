import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import * as v from "valibot";

import { ContractValidationError } from "../../../contracts/runtime";
import { parseSession, type Session } from "../../../contracts/sessions";
import { queryClient } from "../lib/queryClient";

const unknownSessionsSchema = v.array(v.unknown());

/**
 * Returns session collection key.
 * @returns session collection key.
 */
function getSessionCollectionKey(item: Partial<Session>): string | undefined {
    const hasKey = typeof item.key === "string" && item.key.trim().length > 0;
    const key = hasKey ? item.key : item.id;
    return typeof key === "string" && key.trim().length > 0 ? key : undefined;
}

/** Defines sessions collection. */
export const sessionsCollection = createCollection(
    queryCollectionOptions({
        id: "sessions",
        queryKey: ["sessions"],
        queryFn: () => Promise.resolve([]),
        queryClient,
        staleTime: Infinity,
        getKey: (item: Session) => getSessionCollectionKey(item) || "unknown-session",
    })
);

/** Starts the sessions collection query. */
export function preloadSessionsCollection() {
    void sessionsCollection.preload();
}

/**
 * Performs delete session from collection.
 * @param key Lookup key.
 */
export function deleteSessionFromCollection(key: string) {
    if (!sessionsCollection.isReady()) {
        return;
    }

    for (const [existingKey] of sessionsCollection) {
        if (existingKey !== key) {
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

/**
 * Performs replace sessions from WebSocket.
 * @param sessions Sessions value.
 */
export function replaceSessionsFromWebSocket(sessions: unknown) {
    if (!sessionsCollection.isReady()) {
        return;
    }

    const result = v.safeParse(unknownSessionsSchema, sessions);
    if (!result.success) return;
    const entries = result.output;
    const writableSessions = entries.flatMap((entry, index): Session[] => {
        try {
            return [parseSession(entry, `sessions[${index}]`)];
        } catch (error) {
            if (error instanceof ContractValidationError) {
                return [];
            }
            throw error;
        }
    });

    const nextKeys = new Set<string>(
        writableSessions.map((session) => String(getSessionCollectionKey(session)))
    );

    for (const [existingKey] of sessionsCollection) {
        if (!nextKeys.has(existingKey)) {
            deleteSessionFromCollection(existingKey);
        }
    }

    for (const session of writableSessions) {
        sessionsCollection.utils.writeUpsert(session);
    }
}
