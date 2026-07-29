import gateway from "../gateway.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";

const cronListSnapshot = new CoalescedSnapshot<unknown>({
    freshForMs: 3000,
    load: async () => {
        const payload = await gateway.request("cron.list", {
            includeDisabled: true,
        });
        normalizeOpenClawCronJobs<Record<string, unknown>>(payload);
        return payload;
    },
    name: "openclaw.cron-list",
    staleForMs: 30_000,
});

interface CronListResponse<T> {
    jobs?: T[];
}

/**
 * Reads the shared raw Gateway cron list for route-specific normalization.
 * @returns Read the shared raw Gateway cron list for route-specific normalization.
 */
export function getOpenClawCronListSnapshot(): Promise<unknown> {
    return cronListSnapshot.read();
}

/**
 * Extracts cron jobs while letting each consumer retain its own narrow job type.
 * @param payload Request or event payload.
 * @returns Normalize open claw cron jobs result.
 */
export function normalizeOpenClawCronJobs<T>(payload: unknown): T[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("Invalid OpenClaw cron list response");
    }
    const value = payload as CronListResponse<T>;
    const jobs = Array.isArray(value.jobs) ? value.jobs : undefined;
    if (
        !jobs ||
        jobs.some((job) => !job || typeof job !== "object" || Array.isArray(job))
    ) {
        throw new TypeError("Invalid OpenClaw cron list response");
    }
    return jobs;
}

/** Invalidates cron state after any Gateway mutation. */
export function invalidateOpenClawCronListSnapshot(): void {
    cronListSnapshot.invalidate();
}
