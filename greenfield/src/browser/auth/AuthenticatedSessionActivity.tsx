import { useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInMilliseconds, minutesToMilliseconds } from "date-fns";
import { useEffect } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { classifyDashboardBrowserFailure } from "../api/trpcError.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import {
    authStatusQueryKey,
    authStatusQueryOptions,
    resetAuthenticatedBrowserCache,
} from "./authQueries.ts";

const browserSessionTouchThrottleMs = minutesToMilliseconds(1);
const authenticatedActivityEvents = ["keydown", "pointerdown"] as const;
const passiveActivityListenerOptions = Object.freeze({ passive: true });
const capturedPassiveActivityListenerOptions = Object.freeze({
    capture: true,
    passive: true,
});

function activityTouchIsDue(
    status: AuthStatus | undefined,
    nowMs: number,
    lastAttemptAtMs: number | undefined
): boolean {
    if (status?.state !== "authenticated") return false;
    if (
        differenceInMilliseconds(nowMs, status.session.lastSeenAtMs) <
        browserSessionTouchThrottleMs
    ) {
        return false;
    }
    return (
        lastAttemptAtMs === undefined ||
        differenceInMilliseconds(nowMs, lastAttemptAtMs) >= browserSessionTouchThrottleMs
    );
}

function updateCachedSessionActivity(
    status: AuthStatus | undefined,
    lastSeenAtMs: number
): AuthStatus | undefined {
    if (
        status?.state !== "authenticated" ||
        status.session.lastSeenAtMs >= lastSeenAtMs
    ) {
        return status;
    }
    return {
        ...status,
        session: { ...status.session, lastSeenAtMs },
    };
}

/**
 * Records explicit activity for an authenticated browser without write-amplifying
 * high-frequency DOM events.
 * @returns No visual output.
 */
export function AuthenticatedSessionActivity() {
    const client = useDashboardTrpcClient();
    const collections = useDashboardBrowserCollections();
    const queryClient = useQueryClient();
    const status = useQuery(authStatusQueryOptions(client));
    const authenticatedSessionId =
        status.data?.state === "authenticated" ? status.data.session.id : undefined;

    useEffect(() => {
        if (authenticatedSessionId === undefined) return;
        let active = true;
        let inFlight = false;
        let lastAttemptAtMs: number | undefined;
        let requestController: AbortController | undefined;

        async function touchSession(controller: AbortController): Promise<void> {
            try {
                const result = await client.mutation(
                    "auth.touch",
                    {},
                    { signal: controller.signal }
                );
                if (!active) return;
                queryClient.setQueryData<AuthStatus>(authStatusQueryKey, (status) =>
                    updateCachedSessionActivity(status, result.lastSeenAtMs)
                );
            } catch (error: unknown) {
                if (
                    active &&
                    !controller.signal.aborted &&
                    classifyDashboardBrowserFailure(error) === "unauthorized"
                ) {
                    await queryClient.cancelQueries();
                    if (active) {
                        await resetAuthenticatedBrowserCache(queryClient, collections, {
                            state: "anonymous",
                        });
                    }
                }
            } finally {
                inFlight = false;
                if (requestController === controller) requestController = undefined;
            }
        }

        function requestTouch(): void {
            if (inFlight) return;
            const nowMs = Date.now();
            const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (!activityTouchIsDue(status, nowMs, lastAttemptAtMs)) return;

            lastAttemptAtMs = nowMs;
            inFlight = true;
            const controller = new AbortController();
            requestController = controller;
            void touchSession(controller);
        }

        function requestTouchWhenVisible(): void {
            if (document.visibilityState === "visible") requestTouch();
        }

        requestTouchWhenVisible();
        for (const eventName of authenticatedActivityEvents) {
            document.addEventListener(
                eventName,
                requestTouch,
                passiveActivityListenerOptions
            );
        }
        document.addEventListener(
            "scroll",
            requestTouch,
            capturedPassiveActivityListenerOptions
        );
        document.addEventListener("visibilitychange", requestTouchWhenVisible);
        window.addEventListener("focus", requestTouch);

        return () => {
            active = false;
            requestController?.abort();
            for (const eventName of authenticatedActivityEvents) {
                document.removeEventListener(eventName, requestTouch);
            }
            document.removeEventListener("scroll", requestTouch, true);
            document.removeEventListener("visibilitychange", requestTouchWhenVisible);
            window.removeEventListener("focus", requestTouch);
        };
    }, [authenticatedSessionId, client, collections, queryClient]);

    return null;
}
