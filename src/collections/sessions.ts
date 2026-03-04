import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import type { Session } from "../types/session";

export const sessionsCollection = createCollection(
    queryCollectionOptions({
        queryKey: ["sessions"],
        queryFn: async () => [],
        queryClient,
        staleTime: Number.POSITIVE_INFINITY,
        getKey: (item: Session) => item.key || item.id,
    })
);

export function writeSessionFromWebSocket(session: Session) {
    sessionsCollection.utils.writeUpsert(
        session as unknown as Partial<Record<string, unknown>>
    );
}

export function writeSessionsFromWebSocket(sessions: Session[]) {
    sessionsCollection.utils.writeBatch(() => {
        for (const session of sessions) {
            sessionsCollection.utils.writeUpsert(
                session as unknown as Partial<Record<string, unknown>>
            );
        }
    });
}

export function replaceSessionsFromWebSocket(sessions: Session[]) {
    const nextKeys = new Set(
        sessions.map((session) => session.key || session.id).filter(Boolean)
    );

    sessionsCollection.utils.writeBatch(() => {
        for (const [existingKey] of sessionsCollection) {
            if (!nextKeys.has(existingKey)) {
                sessionsCollection.utils.writeDelete(existingKey);
            }
        }

        for (const session of sessions) {
            sessionsCollection.utils.writeUpsert(
                session as unknown as Partial<Record<string, unknown>>
            );
        }
    });
}
