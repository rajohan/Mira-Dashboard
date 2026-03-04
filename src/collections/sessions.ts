import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import type { Session } from "../types/session";

export const sessionsCollection = createCollection(
    queryCollectionOptions({
        queryKey: ["sessions"],
        queryFn: async () => [],
        queryClient,
        getKey: (item: Session) => item.key || item.id,
    })
);

export function writeSessionFromWebSocket(session: Session) {
    sessionsCollection.utils.writeUpsert(session);
}

export function writeSessionsFromWebSocket(sessions: Session[]) {
    sessionsCollection.utils.writeBatch(() => {
        for (const session of sessions) {
            sessionsCollection.utils.writeUpsert(session);
        }
    });
}
