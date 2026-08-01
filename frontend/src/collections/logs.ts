import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import { type LogEntry, parseLogLine } from "../utils/logUtilities";

export const MAX_RETAINED_LIVE_LOG_ENTRIES = 5000;
const MAX_LIVE_LOG_LINE_CHARACTERS = 256 * 1024;

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
 * Trims oldest log rows so a live stream cannot grow client state indefinitely.
 * @param maximumEntries Maximum retained live rows.
 */
export function trimRetainedLiveLogs(
    maximumEntries = MAX_RETAINED_LIVE_LOG_ENTRIES
): void {
    const overflow = logsCollection.size - maximumEntries;
    if (overflow <= 0) {
        return;
    }
    const oldestKeys: string[] = [];
    const entries = logsCollection[Symbol.iterator]();
    for (let index = 0; index < overflow; index += 1) {
        const entry = entries.next();
        if (entry.done) {
            break;
        }
        oldestKeys.push(entry.value[0]);
    }
    logsCollection.utils.writeDelete(oldestKeys);
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
        const parsed = parseLogLine(
            line.length <= MAX_LIVE_LOG_LINE_CHARACTERS
                ? line
                : `${line.slice(0, MAX_LIVE_LOG_LINE_CHARACTERS)}… [truncated]`,
            lineId
        );
        if (!parsed) {
            return;
        }

        logsCollection.utils.writeUpsert(parsed);
        trimRetainedLiveLogs();
    } catch (error) {
        console.error("Error parsing log line:", line, error);
    }
}
