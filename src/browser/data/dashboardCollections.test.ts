import { describe, expect, test } from "bun:test";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { resetAuthenticatedBrowserCache } from "../auth/authQueries.ts";
import { notificationLatestQueryKey } from "../notifications/notificationQueries.ts";
import { createDashboardBrowserCollections } from "./dashboardCollections.ts";

const unusedTransport: DashboardTrpcTransport = Object.freeze({
    mutation: (path: string) =>
        Promise.reject(new TypeError(`Unexpected mutation: ${path}`)),
    query: (path: string) => Promise.reject(new TypeError(`Unexpected query: ${path}`)),
});

describe("Dashboard browser collections", () => {
    test("observes every cleanup failure and still recreates the registry", async () => {
        const queryClient = createDashboardQueryClient();
        const collections = createDashboardBrowserCollections(
            queryClient,
            createDashboardTrpcClient(unusedTransport)
        );
        const previousAgents = collections.agents;
        const previousNotifications = collections.notifications;
        const definitionsFailure = new TypeError("definitions cleanup failed");
        const statusesFailure = new TypeError("statuses cleanup failed");
        const notificationsFailure = new TypeError("notifications cleanup failed");
        const cleanups: string[] = [];
        Reflect.set(previousAgents.definitions, "cleanup", () => {
            cleanups.push("definitions");
            return Promise.reject(definitionsFailure);
        });
        Reflect.set(previousAgents.statuses, "cleanup", () => {
            cleanups.push("statuses");
            return Promise.reject(statusesFailure);
        });
        Reflect.set(previousNotifications, "cleanup", () => {
            cleanups.push("notifications");
            return Promise.reject(notificationsFailure);
        });

        try {
            const failure = await collections.reset().catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual([
                definitionsFailure,
                statusesFailure,
                notificationsFailure,
            ]);
            expect(cleanups).toEqual(["definitions", "statuses", "notifications"]);
            expect(collections.agents).not.toBe(previousAgents);
            expect(collections.notifications).not.toBe(previousNotifications);
        } finally {
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("loads fresh notifications after logout and relogin", async () => {
        const timestampMs = 1_800_000_000_000;
        const firstNotificationId = "019fdc00-0000-7000-8000-000000000003";
        const secondNotificationId = "019fdc00-0000-7000-8000-000000000004";
        const results = [
            {
                notifications: [
                    {
                        id: firstNotificationId,
                        kind: "heartbeat",
                        message: "First session notification.",
                        occurredAtMs: timestampMs,
                        severity: "warning",
                        title: "First session",
                    },
                ],
                readCount: 0,
                unreadCount: 1,
            },
            {
                notifications: [
                    {
                        id: secondNotificationId,
                        kind: "task",
                        message: "Second session notification.",
                        occurredAtMs: timestampMs + 1000,
                        severity: "info",
                        title: "Second session",
                    },
                ],
                readCount: 1,
                unreadCount: 0,
            },
        ] satisfies ListNotificationsResult[];
        let notificationQueryCount = 0;
        const transport: DashboardTrpcTransport = Object.freeze({
            mutation: (path: string) =>
                Promise.reject(new TypeError(`Unexpected mutation: ${path}`)),
            query: (path: string, input?: unknown) => {
                if (path !== "notifications.list") {
                    return Promise.reject(new TypeError(`Unexpected query: ${path}`));
                }
                expect(input).toEqual({ limit: 100 });
                const result = results[notificationQueryCount];
                notificationQueryCount += 1;
                return result === undefined
                    ? Promise.reject(new TypeError("Unexpected notification query"))
                    : Promise.resolve(result);
            },
        });
        const queryClient = createDashboardQueryClient();
        const collections = createDashboardBrowserCollections(
            queryClient,
            createDashboardTrpcClient(transport)
        );
        const firstNotifications = collections.notifications;
        const authenticatedStatus = {
            session: {
                authenticatedAtMs: timestampMs,
                authMethod: "password",
                createdAtMs: timestampMs,
                expiresAtMs: timestampMs + 86_400_000,
                id: "a".repeat(32),
                isCurrent: true,
                lastSeenAtMs: timestampMs,
            },
            state: "authenticated",
            user: {
                id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                email: "operator@example.com",
                username: "operator",
            },
        } satisfies AuthStatus;

        try {
            await firstNotifications.toArrayWhenReady();
            expect(firstNotifications.get(firstNotificationId)?.title).toBe(
                "First session"
            );
            expect(notificationQueryCount).toBe(1);

            await resetAuthenticatedBrowserCache(queryClient, collections, {
                state: "anonymous",
            });
            expect(collections.notifications).not.toBe(firstNotifications);
            expect(queryClient.getQueryData(notificationLatestQueryKey)).toBeUndefined();
            const loggedOutNotifications = collections.notifications;

            await resetAuthenticatedBrowserCache(
                queryClient,
                collections,
                authenticatedStatus
            );
            expect(collections.notifications).not.toBe(loggedOutNotifications);
            expect(queryClient.getQueryData(notificationLatestQueryKey)).toBeUndefined();

            await collections.notifications.toArrayWhenReady();
            expect(notificationQueryCount).toBe(2);
            expect(collections.notifications.get(secondNotificationId)?.title).toBe(
                "Second session"
            );
            expect(collections.notifications.get(firstNotificationId)).toBeUndefined();
            expect(queryClient.getQueryData(notificationLatestQueryKey)).toEqual(
                results[1]
            );
        } finally {
            await collections.cleanup();
            queryClient.clear();
        }
    });
});
