import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";

import { queryClient } from "../lib/queryClient";
import type { LogEntry } from "../types/log";
import { parseLogLine } from "../utils/logUtils";

/** Stores logs collection. */
export const logsCollection = createCollection(
    queryCollectionOptions({
        queryKey: ["logs"],
        queryFn: async () => [],
        queryClient,
        staleTime: Number.POSITIVE_INFINITY,
        getKey: (item: LogEntry) => item.id,
    })
);

void logsCollection.preload();

/** Handles write log from web socket. */
export function writeLogFromWebSocket(line: string) {
    if (!logsCollection.isReady()) {
        return;
    }

    try {
        const parsed = parseLogLine(line);
        if (!parsed) {
            return;
        }

        logsCollection.utils.writeUpsert(
            parsed as unknown as Partial<Record<string, unknown>>
        );
    } catch (error) {
        console.error("Error parsing log line:", line, error);
    }
}
