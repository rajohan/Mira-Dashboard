import { describe, expect, test } from "bun:test";

import type { TRPCRequestOptions } from "@trpc/client";

import type { NotificationRecord } from "../../contracts/monitoring.ts";
import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { reportQueryKey } from "../monitoring/monitoringQueries.ts";
import {
    notificationHistoryQueryKey,
    notificationHistoryPageQueryOptions,
    notificationLatestQueryKey,
    notificationLatestQueryOptions,
    refreshNotificationQueries,
    refreshNotificationRealtimeQueries,
    uniqueNotificationRows,
} from "./notificationQueries.ts";

const newestId = "019fdc00-0000-7000-8000-000000000003";
const middleId = "019fdb00-0000-7000-8000-000000000002";
const oldestId = "019fda00-0000-7000-8000-000000000001";
const timestampMs = 1_800_000_000_000;

function notification(
    id: string,
    occurredAtMs: number,
    readAtMs?: number
): NotificationRecord {
    return {
        id,
        kind: "heartbeat",
        message: "A monitor changed state.",
        occurredAtMs,
        ...(readAtMs === undefined ? {} : { readAtMs }),
        severity: "warning",
        title: "Monitoring update",
    };
}

interface QueryCall {
    readonly input: unknown;
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

class NotificationQueryTransport implements DashboardTrpcTransport {
    readonly calls: QueryCall[] = [];
    readonly #outputs: unknown[];

    constructor(outputs: unknown[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        const output = this.#outputs[this.calls.length];
        this.calls.push({ input, path, signal: options?.signal });
        return output === undefined
            ? Promise.reject(new TypeError(`Unexpected query: ${path}`))
            : Promise.resolve(output);
    }
}

describe("notification browser queries", () => {
    test("retains the complete newest-window result under the collection query key", async () => {
        const newest = notification(newestId, timestampMs);
        const result = {
            nextCursor: { id: newest.id, occurredAtMs: newest.occurredAtMs },
            notifications: [newest],
            readCount: 9,
            unreadCount: 17,
        } satisfies ListNotificationsResult;
        const transport = new NotificationQueryTransport([result]);
        const queryClient = createDashboardQueryClient();

        try {
            const fetched = await queryClient.fetchQuery(
                notificationLatestQueryOptions(createDashboardTrpcClient(transport))
            );

            expect(fetched).toEqual(result);
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationLatestQueryKey
                )
            ).toEqual(result);
            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                { input: { limit: 100 }, path: "notifications.list" },
            ]);
            expect(transport.calls[0]?.signal).toBeInstanceOf(AbortSignal);
        } finally {
            queryClient.clear();
        }
    });

    test("fetches each filtered history page under its exact cursor key", async () => {
        const newest = notification(newestId, timestampMs);
        const middle = notification(middleId, timestampMs - 1000);
        const oldest = notification(oldestId, timestampMs - 2000, timestampMs);
        const firstCursor = { id: newest.id, occurredAtMs: newest.occurredAtMs };
        const transport = new NotificationQueryTransport([
            {
                nextCursor: { id: middle.id, occurredAtMs: middle.occurredAtMs },
                notifications: [middle],
                readCount: 1,
                unreadCount: 2,
            },
            {
                notifications: [oldest],
                readCount: 1,
                unreadCount: 2,
            },
        ]);
        const queryClient = createDashboardQueryClient();

        try {
            const firstPage = await queryClient.fetchQuery(
                notificationHistoryPageQueryOptions(
                    createDashboardTrpcClient(transport),
                    firstCursor,
                    { readState: "all", severities: ["warning"] },
                    true
                )
            );
            const secondCursor = {
                id: middle.id,
                occurredAtMs: middle.occurredAtMs,
            };
            const secondPage = await queryClient.fetchQuery(
                notificationHistoryPageQueryOptions(
                    createDashboardTrpcClient(transport),
                    secondCursor,
                    { readState: "all", severities: ["warning"] },
                    true
                )
            );

            expect(firstPage.notifications).toEqual([middle]);
            expect(secondPage.notifications).toEqual([oldest]);
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationHistoryQueryKey(firstCursor, {
                        readState: "all",
                        severities: ["warning"],
                    })
                )
            ).toEqual(firstPage);
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationHistoryQueryKey(secondCursor, {
                        readState: "all",
                        severities: ["warning"],
                    })
                )
            ).toEqual(secondPage);

            expect(transport.calls.map(({ input, path }) => ({ input, path }))).toEqual([
                {
                    input: {
                        cursor: firstCursor,
                        filters: { readState: "all", severities: ["warning"] },
                        limit: 100,
                    },
                    path: "notifications.list",
                },
                {
                    input: {
                        cursor: secondCursor,
                        filters: { readState: "all", severities: ["warning"] },
                        limit: 100,
                    },
                    path: "notifications.list",
                },
            ]);
            expect(
                transport.calls.every(({ signal }) => signal instanceof AbortSignal)
            ).toBeTrue();
        } finally {
            queryClient.clear();
        }
    });

    test("deduplicates overlapping latest and history rows without reordering", () => {
        const newest = notification(newestId, timestampMs);
        const older = notification(middleId, timestampMs - 1000);
        expect(uniqueNotificationRows([newest, older, older])).toEqual([newest, older]);
    });

    test("invalidates notifications without invalidating report projections", async () => {
        const queryClient = createDashboardQueryClient();
        const reportKey = [...reportQueryKey, "test"] as const;
        const historyKey = notificationHistoryQueryKey(
            { id: newestId, occurredAtMs: timestampMs },
            undefined
        );
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });
        queryClient.setQueryData(historyKey, { notifications: [] });
        queryClient.setQueryData(reportKey, { reports: [] });

        try {
            await refreshNotificationQueries(queryClient);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(reportKey)?.isInvalidated).toBeFalse();
        } finally {
            queryClient.clear();
        }
    });

    test("marks inactive history stale without refetching it during realtime refresh", async () => {
        const queryClient = createDashboardQueryClient();
        const historyKey = notificationHistoryQueryKey(
            { id: newestId, occurredAtMs: timestampMs },
            undefined
        );
        const reportKey = [...reportQueryKey, "test"] as const;
        queryClient.setQueryData(notificationLatestQueryKey, { notifications: [] });
        queryClient.setQueryData(historyKey, { notifications: [] });
        queryClient.setQueryData(reportKey, { reports: [] });

        try {
            await refreshNotificationRealtimeQueries(queryClient);
            expect(
                queryClient.getQueryState(notificationLatestQueryKey)?.isInvalidated
            ).toBeTrue();
            expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBeTrue();
            expect(queryClient.getQueryState(reportKey)?.isInvalidated).toBeFalse();
        } finally {
            queryClient.clear();
        }
    });
});
