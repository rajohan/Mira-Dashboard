import { describe, expect, jest, test } from "bun:test";

import { QueryObserver } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";

import type { SystemMetrics } from "../../contracts/system.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import {
    systemMetricsQueryKey,
    systemMetricsQueryOptions,
    systemMetricsRefreshIntervalMs,
} from "./systemMetricsQueries.ts";

const freshMetrics = Object.freeze({
    cpu: {
        loadAverage: [2, 1, 0.5],
        loadPercent: 50,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 400,
        totalBytes: 1000,
        usedBytes: 600,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 250,
        totalBytes: 1000,
        usedBytes: 750,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 800,
        state: "ready",
        uploadBitsPerSecond: 400,
    },
    sampledAtMs: 1_800_000_000_000,
    uptimeSeconds: 12,
} as const satisfies SystemMetrics);

interface QueryCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class SystemMetricsTransport implements DashboardTrpcTransport {
    readonly calls: QueryCall[] = [];
    readonly #outputs: readonly SystemMetrics[];

    constructor(outputs: readonly SystemMetrics[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        const output =
            this.#outputs[Math.min(this.calls.length, this.#outputs.length - 1)];
        this.calls.push({ input, path, signal: options?.signal });
        return output === undefined
            ? Promise.reject(new TypeError("Missing metrics output"))
            : Promise.resolve(output);
    }
}

class HangingSystemMetricsTransport implements DashboardTrpcTransport {
    readonly started = Promise.withResolvers<AbortSignal>();

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(
        _path: string,
        _input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown> {
        const signal = options?.signal;
        if (signal === undefined) {
            return Promise.reject(new TypeError("Missing query cancellation signal"));
        }
        this.started.resolve(signal);
        return new Promise((_resolve, reject) => {
            signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true }
            );
        });
    }
}

describe("system metrics query", () => {
    test("polls every five seconds and retains explicit server freshness", async () => {
        jest.useFakeTimers();
        const staleMetrics = {
            ...freshMetrics,
            freshness: "stale" as const,
        } satisfies SystemMetrics;
        const transport = new SystemMetricsTransport([freshMetrics, staleMetrics]);
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);
        const observer = new QueryObserver(
            queryClient,
            systemMetricsQueryOptions(client)
        );
        const freshResult = Promise.withResolvers<void>();
        const staleResult = Promise.withResolvers<void>();
        const unsubscribe = observer.subscribe((result) => {
            if (result.data?.freshness === "fresh") freshResult.resolve();
            if (result.data?.freshness === "stale" && transport.calls.length === 2) {
                staleResult.resolve();
            }
        });

        try {
            await freshResult.promise;
            jest.advanceTimersByTime(systemMetricsRefreshIntervalMs);
            await staleResult.promise;

            expect(systemMetricsQueryOptions(client).queryKey).toEqual(
                systemMetricsQueryKey
            );
            expect(systemMetricsQueryOptions(client).refetchOnMount).toBe("always");
            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                { input: {}, path: "system.metrics" },
                { input: {}, path: "system.metrics" },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
        } finally {
            unsubscribe();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("aborts an in-flight request when its final observer unsubscribes", async () => {
        const transport = new HangingSystemMetricsTransport();
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);
        const observer = new QueryObserver(
            queryClient,
            systemMetricsQueryOptions(client)
        );
        const unsubscribe = observer.subscribe(() => null);

        const signal = await transport.started.promise;
        expect(signal.aborted).toBeFalse();

        unsubscribe();
        await Promise.resolve();
        expect(signal.aborted).toBeTrue();
        queryClient.clear();
    });
});
