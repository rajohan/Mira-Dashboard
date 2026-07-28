import gateway from "../gateway.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";

const cronListSnapshot = new CoalescedSnapshot<unknown>({
    freshForMs: 3000,
    load: () => gateway.request("cron.list", { includeDisabled: true }),
    name: "openclaw.cron-list",
    staleForMs: 30_000,
});

/** Reads the shared raw Gateway cron list for route-specific normalization. */
export function getOpenClawCronListSnapshot(): Promise<unknown> {
    return cronListSnapshot.read();
}

/** Invalidates cron state after any Gateway mutation. */
export function invalidateOpenClawCronListSnapshot(): void {
    cronListSnapshot.invalidate();
}
