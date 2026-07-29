import { subscribeToStructuredLogs } from "../../src/lib/structuredLogger.ts";

interface StructuredLogEntry {
    [key: string]: unknown;
    component?: string;
    event?: string;
    level?: string;
}

/**
 * Captures structured events emitted during one test without patching console APIs.
 * @returns Capture structured logs result.
 */
export function captureStructuredLogs(): {
    entries: StructuredLogEntry[];
    stop: () => void;
} {
    const entries: StructuredLogEntry[] = [];
    const stop = subscribeToStructuredLogs((line) => {
        try {
            entries.push(JSON.parse(line) as StructuredLogEntry);
        } catch {
            // A malformed line belongs in the logger's own unit tests.
        }
    });
    return { entries, stop };
}
