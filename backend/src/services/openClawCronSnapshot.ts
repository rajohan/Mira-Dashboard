import gateway from "../gateway.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";

const cronListSnapshot = new CoalescedSnapshot<unknown>({
    freshForMs: 3000,
    load: () => gateway.request("cron.list", { includeDisabled: true }),
    name: "openclaw.cron-list",
    staleForMs: 30_000,
});

interface CronListResponse<T> {
    items?: T[];
    jobs?: T[];
}

/** Reads the shared raw Gateway cron list for route-specific normalization. */
export function getOpenClawCronListSnapshot(): Promise<unknown> {
    return cronListSnapshot.read();
}

/** Extracts cron jobs while letting each consumer retain its own narrow job type. */
export function normalizeOpenClawCronJobs<T>(payload: unknown): T[] {
    if (!payload || typeof payload !== "object") return [];
    const value = payload as CronListResponse<T>;
    if (Array.isArray(value.jobs)) return value.jobs;
    return Array.isArray(value.items) ? value.items : [];
}

/** Invalidates cron state after any Gateway mutation. */
export function invalidateOpenClawCronListSnapshot(): void {
    cronListSnapshot.invalidate();
}
