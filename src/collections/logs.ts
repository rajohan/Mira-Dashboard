import { createCollection } from "@tanstack/react-db";

import type { LogEntry } from "../types/log";
import { parseLogLine } from "../utils/logUtils";

export const logsCollection = createCollection<LogEntry>({
    getKey: (item) => item.ts || item.raw,
    sync: {
        sync: () => {},
    },
    startSync: true,
});

export function writeLogFromWebSocket(line: string) {
    try {
        const parsed = parseLogLine(line);
        if (parsed) {
            logsCollection.utils.writeInsert(parsed);
        }
    } catch (error) {
        console.error("Error parsing log line:", line, error);
    }
}
