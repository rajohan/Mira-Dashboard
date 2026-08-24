import { describe, expect, test } from "bun:test";

import type { TRPCRequestOptions } from "@trpc/client";

import type { NotificationRecord } from "../../contracts/monitoring.ts";
import type {
    BulkNotificationInput,
    ListNotificationsResult,
} from "../../contracts/notifications.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    DashboardProtocolError,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import {
    executeBulkNotificationAction,
    notificationBulkActionMaximumBatches,
    NotificationBulkLimitError,
    patchNotificationInCachedQueries,
    removeNotificationFromCachedQueries,
} from "./notificationMutations.ts";
import {
    notificationHistoryQueryKey,
    notificationLatestQueryKey,
} from "./notificationQueries.ts";

const notificationId = "019fdc00-0000-7000-8000-000000000003";
const olderNotificationId = "019fdb00-0000-7000-8000-000000000002";
const timestampMs = 1_800_000_000_000;

function notification(id: string, occurredAtMs: number): NotificationRecord {
    return {
        id,
        kind: "heartbeat",
        message: "A monitor changed state.",
        occurredAtMs,
        severity: "warning",
        title: "Monitoring update",
    };
}

interface MutationCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class NotificationMutationTransport implements DashboardTrpcTransport {
    readonly calls: MutationCall[] = [];
    readonly firstCall = Promise.withResolvers<MutationCall>();
    readonly #outputs: unknown[];

    constructor(outputs: unknown[]) {
        this.#outputs = outputs;
    }

    mutation(
        path: string,
        input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown> {
        const output = this.#outputs[this.calls.length];
        const call = { input, path, signal: options?.signal };
        this.calls.push(call);
        this.firstCall.resolve(call);
        if (output instanceof Error) return Promise.reject(output);
        return output === undefined
            ? Promise.reject(new TypeError(`Unexpected mutation: ${path}`))
            : Promise.resolve(output);
    }

    query(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected query: ${path}`));
    }
}

function seedNotificationCaches() {
    const queryClient = createDashboardQueryClient();
    const newest = notification(notificationId, timestampMs);
    const older = notification(olderNotificationId, timestampMs - 1000);
    const latest = {
        nextCursor: { id: newest.id, occurredAtMs: newest.occurredAtMs },
        notifications: [newest],
        readCount: 3,
        unreadCount: 2,
    } satisfies ListNotificationsResult;
    const history = {
        notifications: [older],
        readCount: 3,
        unreadCount: 2,
    } satisfies ListNotificationsResult;
    const historyKey = notificationHistoryQueryKey(latest.nextCursor, undefined);
    queryClient.setQueryData(notificationLatestQueryKey, latest);
    queryClient.setQueryData(historyKey, history);
    return { historyKey, latest, older, queryClient };
}

describe("notification browser mutations", () => {
    test("patches known rows and global counts before a refresh", () => {
        const { historyKey, latest, queryClient } = seedNotificationCaches();
        const read: NotificationRecord = {
            ...latest.notifications[0]!,
            readAtMs: timestampMs + 1000,
        };

        try {
            patchNotificationInCachedQueries(queryClient, read);
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationLatestQueryKey
                )
            ).toEqual({
                ...latest,
                notifications: [read],
                readCount: 4,
                unreadCount: 1,
            });
            const history = queryClient.getQueryData<ListNotificationsResult>(historyKey);
            expect(history?.readCount).toBe(4);
            expect(history?.unreadCount).toBe(1);
        } finally {
            queryClient.clear();
        }
    });

    test("removes a known history row and adjusts latest global counts", () => {
        const { historyKey, latest, older, queryClient } = seedNotificationCaches();

        try {
            removeNotificationFromCachedQueries(queryClient, older.id);
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationLatestQueryKey
                )
            ).toEqual({ ...latest, readCount: 3, unreadCount: 1 });
            expect(
                queryClient.getQueryData<ListNotificationsResult>(historyKey)
                    ?.notifications
            ).toEqual([]);
        } finally {
            queryClient.clear();
        }
    });

    test("runs bounded batches sequentially with identical filters", async () => {
        const transport = new NotificationMutationTransport([
            { affectedCount: 100, completedAtMs: timestampMs, remaining: true },
            { affectedCount: 50, completedAtMs: timestampMs + 1, remaining: false },
        ]);
        const queryClient = createDashboardQueryClient();
        const input: BulkNotificationInput = {
            filters: { kinds: ["heartbeat"], severities: ["warning"] },
        };
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });

        try {
            const result = await executeBulkNotificationAction(
                createDashboardTrpcClient(transport),
                queryClient,
                "notifications.markAllRead",
                input
            );
            expect(result).toEqual({
                affectedCount: 150,
                batchCount: 2,
                completedAtMs: timestampMs + 1,
            });
            expect(transport.calls).toEqual([
                {
                    input,
                    path: "notifications.markAllRead",
                    signal: undefined,
                },
                {
                    input,
                    path: "notifications.markAllRead",
                    signal: undefined,
                },
            ]);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("propagates a later batch failure and still invalidates the cache", async () => {
        const failure = new TypeError("second batch failed");
        const transport = new NotificationMutationTransport([
            { affectedCount: 100, completedAtMs: timestampMs, remaining: true },
            failure,
        ]);
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });

        try {
            const caught = await executeBulkNotificationAction(
                createDashboardTrpcClient(transport),
                queryClient,
                "notifications.clearRead",
                { filters: { severities: ["warning"] } }
            ).catch((error: unknown) => error);
            expect(caught).toBe(failure);
            expect(transport.calls).toHaveLength(2);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("rejects a contract-invalid zero-progress continuation and still invalidates the cache", async () => {
        const transport = new NotificationMutationTransport([
            { affectedCount: 0, completedAtMs: timestampMs, remaining: true },
        ]);
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });

        try {
            const failure = await executeBulkNotificationAction(
                createDashboardTrpcClient(transport),
                queryClient,
                "notifications.clearRead",
                { filters: {} }
            ).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(DashboardProtocolError);
            expect(transport.calls).toHaveLength(1);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("stops after the defensive 32-batch ceiling and refreshes partial state", async () => {
        const transport = new NotificationMutationTransport(
            Array.from({ length: notificationBulkActionMaximumBatches }, (_, index) => ({
                affectedCount: 100,
                completedAtMs: timestampMs + index,
                remaining: true,
            }))
        );
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });

        try {
            const failure = await executeBulkNotificationAction(
                createDashboardTrpcClient(transport),
                queryClient,
                "notifications.clearRead",
                { filters: {} }
            ).catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(NotificationBulkLimitError);
            expect(transport.calls).toHaveLength(notificationBulkActionMaximumBatches);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("cancels an in-flight batch without refreshing a replaced session cache", async () => {
        const pendingBatch = Promise.withResolvers<unknown>();
        const transport = new NotificationMutationTransport([pendingBatch.promise]);
        const queryClient = createDashboardQueryClient();
        const controller = new AbortController();
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });

        try {
            const operation = executeBulkNotificationAction(
                createDashboardTrpcClient(transport),
                queryClient,
                "notifications.markAllRead",
                { filters: {} },
                { signal: controller.signal }
            ).catch((error: unknown) => error);
            await transport.firstCall.promise;
            expect(transport.calls).toHaveLength(1);
            expect(transport.calls[0]?.signal).toBe(controller.signal);

            controller.abort();
            pendingBatch.resolve({
                affectedCount: 100,
                completedAtMs: timestampMs,
                remaining: true,
            });
            const failure = await operation;

            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).name).toBe("AbortError");
            expect(transport.calls).toHaveLength(1);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeFalse();
        } finally {
            pendingBatch.resolve({
                affectedCount: 0,
                completedAtMs: timestampMs,
                remaining: false,
            });
            queryClient.clear();
        }
    });
});
