import { createStructuredLogger } from "../../lib/structuredLogger.ts";

export const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const MAX_PULL_REQUEST_BODY_LENGTH = 64 * 1024;
export const pullRequestLogger = createStructuredLogger("pull-requests");

export function dateToISOString(date: Date): string {
    return date.toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
