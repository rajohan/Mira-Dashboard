import { useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInMilliseconds, minutesToMilliseconds } from "date-fns";
import { useEffect } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { classifyDashboardBrowserFailure } from "../api/trpcError.ts";
import {
    authStatusQueryKey,
    authStatusQueryOptions,
    publishAuthenticationStatus,
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
        let active = true;
        let inFlight = false;
        let statusRefreshInFlight = false;
        let lastAttemptAtMs: number | undefined;
        let requestController: AbortController | undefined;

        async function touchSession(controller: AbortController): Promise<void> {
            try {
                await client.mutation("auth.touch", {}, { signal: controller.signal });
                if (!active) return;
                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: authStatusQueryKey,
                });
                if (!active) return;
                await queryClient.fetchQuery(authStatusQueryOptions(client));
            } catch (error: unknown) {
                if (
                    active &&
                    !controller.signal.aborted &&
                    classifyDashboardBrowserFailure(error) === "unauthorized"
                ) {
                    await queryClient.cancelQueries();
                    if (active) {
                        await publishAuthenticationStatus(queryClient, {
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
            if (inFlight || statusRefreshInFlight) return;
            const nowMs = Date.now();
            const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (!activityTouchIsDue(status, nowMs, lastAttemptAtMs)) return;

            lastAttemptAtMs = nowMs;
            inFlight = true;
            const controller = new AbortController();
            requestController = controller;
            void touchSession(controller);
        }

        async function reconcileAuthenticationStatus(): Promise<void> {
            if (statusRefreshInFlight || inFlight) return;
            statusRefreshInFlight = true;
            let touchAfterReconciliation = false;
            try {
                await queryClient.refetchQueries({
                    exact: true,
                    queryKey: authStatusQueryKey,
                    type: "active",
                });
                if (!active) return;
                const queryState =
                    queryClient.getQueryState<AuthStatus>(authStatusQueryKey);
                if (queryState?.status !== "success") return;
                const currentStatus =
                    queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
                if (
                    currentStatus?.state !== "authenticated" ||
                    currentStatus.session.id !== authenticatedSessionId
                )
                    return;
                touchAfterReconciliation = true;
            } finally {
                statusRefreshInFlight = false;
            }
            if (touchAfterReconciliation) requestTouch();
        }

        function reconcileAuthenticationWhenVisible(): void {
            if (document.visibilityState === "visible") {
                void reconcileAuthenticationStatus();
            }
        }

        function reconcileAuthenticationOnFocus(): void {
            void reconcileAuthenticationStatus();
        }

        if (authenticatedSessionId !== undefined) {
            requestTouch();
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
        }
        document.addEventListener("visibilitychange", reconcileAuthenticationWhenVisible);
        window.addEventListener("focus", reconcileAuthenticationOnFocus);

        return () => {
            active = false;
            requestController?.abort();
            for (const eventName of authenticatedActivityEvents) {
                document.removeEventListener(eventName, requestTouch);
            }
            document.removeEventListener("scroll", requestTouch, true);
            document.removeEventListener(
                "visibilitychange",
                reconcileAuthenticationWhenVisible
            );
            window.removeEventListener("focus", reconcileAuthenticationOnFocus);
        };
    }, [authenticatedSessionId, client, queryClient]);

    return null;
}
