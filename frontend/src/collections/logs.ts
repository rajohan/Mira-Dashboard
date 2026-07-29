import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import { type LogEntry, parseLogLine } from "../utils/logUtilities";

/** Defines logs collection. */
export const logsCollection = createCollection(
    queryCollectionOptions({
        id: "logs",
        queryKey: ["logs"],
        queryFn: () => Promise.resolve([]),
        queryClient,
        staleTime: Infinity,
        getKey: (item: LogEntry) => item.id,
    })
);

/** Starts the logs collection query. */
export function preloadLogsCollection() {
    void logsCollection.preload();
}

/**
 * Performs write log from WebSocket.
 * @param line Line value.
 * @param lineId Line identifier.
 */
export function writeLogFromWebSocket(line: string, lineId?: string) {
    if (!logsCollection.isReady()) {
        return;
    }

    try {
        const parsed = parseLogLine(line, lineId);
        if (!parsed) {
            return;
        }

        logsCollection.utils.writeUpsert(parsed);
    } catch (error) {
        console.error("Error parsing log line:", line, error);
    }
}
