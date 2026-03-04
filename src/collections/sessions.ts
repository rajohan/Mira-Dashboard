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

void sessionsCollection.preload();

export function replaceSessionsFromWebSocket(sessions: Session[]) {
    if (!sessionsCollection.isReady()) {
        return;
    }

    const nextKeys = new Set<string>(
        sessions.map((session) => String(session.key || session.id))
    );

    for (const [existingKey] of sessionsCollection) {
        if (!nextKeys.has(String(existingKey))) {
            sessionsCollection.utils.writeDelete(String(existingKey));
        }
    }

    for (const session of sessions) {
        sessionsCollection.utils.writeUpsert(
            session as unknown as Partial<Record<string, unknown>>
        );
    }
}
