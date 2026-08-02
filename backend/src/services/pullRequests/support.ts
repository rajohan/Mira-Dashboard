import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { DASHBOARD_REPO } from "./config.ts";

export const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const MAX_PULL_REQUEST_BODY_LENGTH = 64 * 1024;
export const pullRequestLogger = createStructuredLogger("pull-requests");

export function dateToISOString(date: Date): string {
    return date.toISOString();
}

/**
 * Builds the public Dashboard commit URL for a full or abbreviated SHA.
 * @param commitSha Git commit SHA.
 * @returns Public GitHub commit URL.
 */
export function dashboardCommitUrl(commitSha: string): string {
    return `https://github.com/${DASHBOARD_REPO}/commit/${encodeURIComponent(commitSha)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
