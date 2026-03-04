import { createCollection } from "@tanstack/react-db";

import type { Session } from "../types/session";

export const sessionsCollection = createCollection<Session>({
    getKey: (item) => item.key || item.id,
    sync: {
        sync: () => {},
    },
    startSync: true,
});

export function replaceSessionsFromWebSocket(sessions: Session[]) {
    const nextKeys = new Set<string | number>(
        sessions.map((session) => session.key || session.id)
    );

    sessionsCollection.utils.writeBatch(() => {
        for (const [existingKey] of sessionsCollection) {
            if (!nextKeys.has(existingKey)) {
                sessionsCollection.utils.writeDelete(existingKey);
            }
        }

        for (const session of sessions) {
            sessionsCollection.utils.writeUpsert(session);
        }
    });
}
