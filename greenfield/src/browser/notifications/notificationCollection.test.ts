import { describe, expect, spyOn, test } from "bun:test";

import type { TRPCRequestOptions } from "@trpc/client";

import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { createNotificationCollection } from "./notificationCollection.ts";
import { notificationLatestQueryKey } from "./notificationQueries.ts";

const notificationId = "019fdc00-0000-7000-8000-000000000003";
const timestampMs = 1_800_000_000_000;

describe("notification collection", () => {
    test("materializes rows while preserving counts and cursor in Query cache", async () => {
        const result = {
            nextCursor: { id: notificationId, occurredAtMs: timestampMs },
            notifications: [
                {
                    id: notificationId,
                    kind: "heartbeat",
                    message: "A monitor changed state.",
                    occurredAtMs: timestampMs,
                    severity: "warning",
                    title: "Monitoring update",
                },
            ],
            readCount: 4,
            unreadCount: 7,
        } satisfies ListNotificationsResult;
        let queryInput: unknown;
        let querySignal: AbortSignal | undefined;
        const transport: DashboardTrpcTransport = {
            mutation: (path: string) =>
                Promise.reject(new TypeError(`Unexpected mutation: ${path}`)),
            query: (path: string, input?: unknown, options?: TRPCRequestOptions) => {
                if (path !== "notifications.list") {
                    return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                }
                queryInput = input;
                querySignal = options?.signal;
                return Promise.resolve(result);
            },
        };
        const queryClient = createDashboardQueryClient();
        const collection = createNotificationCollection(
            queryClient,
            createDashboardTrpcClient(transport)
        );
        try {
            await collection.toArrayWhenReady();
            expect(collection.get(notificationId)?.title).toBe("Monitoring update");
            expect(queryInput).toEqual({ limit: 100 });
            expect(querySignal).toBeInstanceOf(AbortSignal);
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationLatestQueryKey
                )
            ).toEqual(result);
        } finally {
            await collection.cleanup();
            queryClient.clear();
        }
    });

    test("retains rows and result metadata when a refresh fails", async () => {
        const result = {
            notifications: [
                {
                    id: notificationId,
                    kind: "heartbeat",
                    message: "A monitor changed state.",
                    occurredAtMs: timestampMs,
                    severity: "warning",
                    title: "Monitoring update",
                },
            ],
            readCount: 4,
            unreadCount: 7,
        } satisfies ListNotificationsResult;
        const refreshFailure = new TypeError("refresh failed");
        let queryCount = 0;
        const transport: DashboardTrpcTransport = {
            mutation: (path: string) =>
                Promise.reject(new TypeError(`Unexpected mutation: ${path}`)),
            query: (path: string) => {
                if (path !== "notifications.list") {
                    return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                }
                queryCount += 1;
                return queryCount === 1
                    ? Promise.resolve(result)
                    : Promise.reject(refreshFailure);
            },
        };
        const queryClient = createDashboardQueryClient();
        queryClient.setQueryDefaults(notificationLatestQueryKey, { retry: false });
        const collection = createNotificationCollection(
            queryClient,
            createDashboardTrpcClient(transport)
        );
        const consoleError = spyOn(console, "error").mockImplementation(() => {});

        try {
            await collection.toArrayWhenReady();
            const failure = await collection.utils
                .refetch({ throwOnError: true })
                .catch((error: unknown) => error);
            expect(failure).toBe(refreshFailure);
            expect(collection.get(notificationId)?.title).toBe("Monitoring update");
            expect(
                queryClient.getQueryData<ListNotificationsResult>(
                    notificationLatestQueryKey
                )
            ).toEqual(result);
            expect(consoleError).toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
            await collection.cleanup();
            queryClient.clear();
        }
    });
});
