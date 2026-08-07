import { useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInMilliseconds, minutesToMilliseconds } from "date-fns";
import { useEffect } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { authStatusQueryKey, authStatusQueryOptions } from "./authQueries.ts";

const browserSessionTouchThrottleMs = minutesToMilliseconds(1);
const authenticatedActivityEvents = ["keydown", "pointerdown", "scroll"] as const;

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
            } catch {
                // Activity writes are best-effort and retried after the throttle window.
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
            document.addEventListener(eventName, requestTouch, { passive: true });
        }
        document.addEventListener("visibilitychange", requestTouchWhenVisible);
        window.addEventListener("focus", requestTouch);

        return () => {
            active = false;
            requestController?.abort();
            for (const eventName of authenticatedActivityEvents) {
                document.removeEventListener(eventName, requestTouch);
            }
            document.removeEventListener("visibilitychange", requestTouchWhenVisible);
            window.removeEventListener("focus", requestTouch);
        };
    }, [authenticatedSessionId, client, queryClient]);

    return null;
}
