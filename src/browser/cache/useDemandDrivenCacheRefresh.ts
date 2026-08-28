import type { TRPCRequestOptions } from "@trpc/client";
import { useEffect, useRef } from "react";

import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";

const requestTimeoutMs = 30_000;

export interface DemandDrivenCacheRefreshOptions {
    readonly client: {
        readonly mutation: (
            name: "cache.refreshEntry",
            input: DashboardProcedureInput<"cache.refreshEntry">,
            options?: TRPCRequestOptions
        ) => Promise<DashboardProcedureOutput<"cache.refreshEntry">>;
    };
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly key: DashboardProcedureInput<"cache.refreshEntry">["key"];
    readonly observedAtMs?: number;
}

/**
 * Requests bounded durable refreshes only while a projection consumer is visible.
 * Existing job idempotency, resource leases, and worker concurrency remain authoritative.
 * @param options Generic cache demand and latest observed projection timestamp.
 */
export function useDemandDrivenCacheRefresh(
    options: DemandDrivenCacheRefreshOptions
): void {
    const pendingSince = useRef<number | null>(null);
    const pendingObservedAtMs = useRef<number | undefined>(undefined);

    useEffect(() => {
        if (!options.enabled) return;
        const controller = new AbortController();
        const requestIfNeeded = () => {
            const nowMs = Date.now();
            if (
                globalThis.document.visibilityState !== "visible" ||
                (options.observedAtMs !== undefined &&
                    nowMs - options.observedAtMs < options.intervalMs) ||
                (pendingSince.current !== null &&
                    pendingObservedAtMs.current === options.observedAtMs &&
                    nowMs - pendingSince.current < requestTimeoutMs)
            ) {
                return;
            }
            pendingSince.current = nowMs;
            pendingObservedAtMs.current = options.observedAtMs;
            void options.client
                .mutation(
                    "cache.refreshEntry",
                    {
                        idempotencyKey: globalThis.crypto
                            .randomUUID()
                            .replaceAll("-", ""),
                        key: options.key,
                    },
                    { signal: controller.signal }
                )
                .catch(() => {
                    pendingSince.current = null;
                });
        };
        const interval = globalThis.setInterval(requestIfNeeded, options.intervalMs);
        globalThis.document.addEventListener("visibilitychange", requestIfNeeded);
        return () => {
            controller.abort();
            globalThis.clearInterval(interval);
            globalThis.document.removeEventListener("visibilitychange", requestIfNeeded);
        };
    }, [
        options.client,
        options.enabled,
        options.intervalMs,
        options.key,
        options.observedAtMs,
    ]);
}
