import { describe, expect, jest, test } from "bun:test";

import { QueryObserver } from "@tanstack/react-query";
import type { TRPCRequestOptions } from "@trpc/client";

import type {
    CacheEntry,
    CacheEntryStatus,
    CacheStatusResult,
} from "../../contracts/cache.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import {
    cacheEntryQueryKey,
    cacheEntryQueryOptions,
    cacheEntryQueryRoot,
    cacheStatusQueryKey,
    cacheStatusQueryOptions,
    cacheStatusRefreshIntervalMs,
} from "./cacheQueries.ts";

const systemHostKey = "system.host";
const timestampMs = 1_800_000_000_000;
const runId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";

const systemHostEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAtMs: timestampMs + 60_000,
    freshness: "fresh",
    key: systemHostKey,
    lastAttemptAtMs: timestampMs,
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 1,
    lastAttemptRunId: runId,
    lastAttemptStatus: "succeeded",
    lastSuccessAtMs: timestampMs,
    manualRunAvailable: true,
    metadata: { provider: "node" },
    payload: {
        architecture: "x64",
        disk: { freeBytes: 500, path: "/", totalBytes: 1000 },
        hostname: "dashboard",
        memory: { freeBytes: 1000, totalBytes: 2000 },
        platform: "linux",
        release: "6.8.0",
        uptimeSeconds: 60,
    },
    schemaId: "system.host.v1",
    source: systemHostKey,
    updatedAtMs: timestampMs,
} as const satisfies CacheEntry);

const systemHostStatus = Object.freeze(
    (({ payload: _payload, ...status }) => status)(systemHostEntry)
) satisfies CacheEntryStatus;

function cacheStatus(
    generatedAtMs = timestampMs,
    entry: CacheEntryStatus = systemHostStatus
): CacheStatusResult {
    return {
        entries: [entry],
        generatedAtMs,
        totalCount: 1,
        truncated: false,
    };
}

interface QueryCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class CacheQueryTransport implements DashboardTrpcTransport {
    readonly calls: QueryCall[] = [];
    readonly #outputs: Readonly<Record<string, readonly unknown[]>>;

    constructor(outputs: Readonly<Record<string, readonly unknown[]>>) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        const callIndex = this.calls.filter((call) => call.path === path).length;
        this.calls.push({ input, path, signal: options?.signal });
        const output = this.#outputs[path]?.[callIndex];
        if (output === undefined) {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

describe("cache browser queries", () => {
    test("polls the mounted bounded status snapshot as freshness advances", async () => {
        jest.useFakeTimers();
        const staleStatus = {
            ...systemHostStatus,
            freshness: "stale" as const,
        };
        const transport = new CacheQueryTransport({
            "cache.getStatus": [
                cacheStatus(),
                cacheStatus(systemHostEntry.expiresAtMs, staleStatus),
            ],
        });
        const queryClient = createDashboardQueryClient();
        const observer = new QueryObserver(
            queryClient,
            cacheStatusQueryOptions(createDashboardTrpcClient(transport))
        );
        const freshResult = Promise.withResolvers<void>();
        const staleResult = Promise.withResolvers<void>();
        const unsubscribe = observer.subscribe((result) => {
            if (result.data?.entries[0]?.freshness === "fresh") {
                freshResult.resolve();
            }
            if (
                result.data?.entries[0]?.freshness === "stale" &&
                transport.calls.length === 2
            ) {
                staleResult.resolve();
            }
        });

        try {
            await freshResult.promise;
            expect(transport.calls).toHaveLength(1);
            jest.advanceTimersByTime(cacheStatusRefreshIntervalMs);
            await staleResult.promise;

            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                { input: {}, path: "cache.getStatus" },
                { input: {}, path: "cache.getStatus" },
            ]);
        } finally {
            unsubscribe();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("loads only the selected exact entry with stable keys and cancellation signals", async () => {
        const transport = new CacheQueryTransport({
            "cache.getEntry": [systemHostEntry],
            "cache.getStatus": [cacheStatus()],
        });
        const queryClient = createDashboardQueryClient();
        const client = createDashboardTrpcClient(transport);

        try {
            const status = await queryClient.fetchQuery(cacheStatusQueryOptions(client));
            const selected = await queryClient.fetchQuery(
                cacheEntryQueryOptions(client, systemHostKey)
            );

            expect(status.entries).toHaveLength(1);
            expect(selected).toEqual(systemHostEntry);
            expect(cacheStatusQueryOptions(client).queryKey).toEqual(cacheStatusQueryKey);
            expect(cacheStatusQueryOptions(client).refetchOnMount).toBe("always");
            expect(cacheEntryQueryKey(systemHostKey)).toEqual([
                ...cacheEntryQueryRoot,
                systemHostKey,
            ]);
            expect(cacheEntryQueryOptions(client, systemHostKey).refetchOnMount).toBe(
                "always"
            );
            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                { input: {}, path: "cache.getStatus" },
                {
                    input: { key: systemHostKey },
                    path: "cache.getEntry",
                },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("polls the selected exact entry as its derived freshness advances", async () => {
        jest.useFakeTimers();
        const staleEntry = {
            ...systemHostEntry,
            freshness: "stale" as const,
        } satisfies CacheEntry;
        const transport = new CacheQueryTransport({
            "cache.getEntry": [systemHostEntry, staleEntry],
        });
        const queryClient = createDashboardQueryClient();
        const observer = new QueryObserver(
            queryClient,
            cacheEntryQueryOptions(createDashboardTrpcClient(transport), systemHostKey)
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
            jest.advanceTimersByTime(cacheStatusRefreshIntervalMs);
            await staleResult.promise;
            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                { input: { key: systemHostKey }, path: "cache.getEntry" },
                { input: { key: systemHostKey }, path: "cache.getEntry" },
            ]);
        } finally {
            unsubscribe();
            queryClient.clear();
            jest.useRealTimers();
        }
    });

    test("reconciles a selected exact entry when its observer remounts while fresh", async () => {
        const remountedEntry = {
            ...systemHostEntry,
            updatedAtMs: timestampMs + 1,
        } satisfies CacheEntry;
        const transport = new CacheQueryTransport({
            "cache.getEntry": [systemHostEntry, remountedEntry],
        });
        const queryClient = createDashboardQueryClient();
        const options = cacheEntryQueryOptions(
            createDashboardTrpcClient(transport),
            systemHostKey
        );
        const firstObserver = new QueryObserver(queryClient, options);
        const firstResult = Promise.withResolvers<void>();
        const unsubscribeFirst = firstObserver.subscribe((result) => {
            if (result.data?.updatedAtMs === timestampMs) firstResult.resolve();
        });

        try {
            await firstResult.promise;
            unsubscribeFirst();
            expect(queryClient.getQueryData(options.queryKey)).toEqual(systemHostEntry);

            const remountedResult = Promise.withResolvers<void>();
            const secondObserver = new QueryObserver(queryClient, options);
            const unsubscribeSecond = secondObserver.subscribe((result) => {
                if (
                    result.data?.updatedAtMs === timestampMs + 1 &&
                    transport.calls.length === 2
                ) {
                    remountedResult.resolve();
                }
            });
            try {
                await remountedResult.promise;
                expect(transport.calls).toHaveLength(2);
            } finally {
                unsubscribeSecond();
            }
        } finally {
            unsubscribeFirst();
            queryClient.clear();
        }
    });

    test("retains last-known-good exact data when a background refresh fails", async () => {
        const transport = new CacheQueryTransport({
            "cache.getEntry": [
                systemHostEntry,
                new TypeError("cache transport unavailable"),
            ],
        });
        const queryClient = createDashboardQueryClient();
        const options = cacheEntryQueryOptions(
            createDashboardTrpcClient(transport),
            systemHostKey
        );

        try {
            await queryClient.fetchQuery(options);
            await queryClient.invalidateQueries({
                exact: true,
                queryKey: options.queryKey,
            });
            const failure = await queryClient
                .fetchQuery({ ...options, retry: false })
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(TypeError);
            expect(queryClient.getQueryData(options.queryKey)).toEqual(systemHostEntry);
        } finally {
            queryClient.clear();
        }
    });

    test("forwards TanStack cancellation to an in-flight exact request", async () => {
        const started = Promise.withResolvers<void>();
        let requestSignal: AbortSignal | undefined;
        const transport: DashboardTrpcTransport = {
            mutation(path) {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            },
            query(path, _input, options) {
                if (path !== "cache.getEntry") {
                    return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                }
                requestSignal = options?.signal;
                started.resolve();
                return new Promise((_resolve, reject) => {
                    requestSignal?.addEventListener(
                        "abort",
                        () => reject(new DOMException("Aborted", "AbortError")),
                        { once: true }
                    );
                });
            },
        };
        const queryClient = createDashboardQueryClient();
        const key = cacheEntryQueryKey(systemHostKey);
        const request = queryClient
            .fetchQuery(
                cacheEntryQueryOptions(
                    createDashboardTrpcClient(transport),
                    systemHostKey
                )
            )
            .catch(() => {});

        try {
            await started.promise;
            await queryClient.cancelQueries({ exact: true, queryKey: key });
            expect(requestSignal?.aborted).toBeTrue();
            await request;
        } finally {
            queryClient.clear();
        }
    });
});
