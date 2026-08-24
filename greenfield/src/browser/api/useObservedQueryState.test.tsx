import { describe, expect, test } from "bun:test";

import { hashKey, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { type ReactNode } from "react";

import { createDashboardQueryClient } from "./queryClient.ts";
import { useObservedQueryData, useObservedQueryState } from "./useObservedQueryState.ts";

const { act, renderHook } = await import("@testing-library/react");

describe("observed Query cache snapshots", () => {
    test("ignores observer lifecycle churn while retaining state and data updates", () => {
        const queryClient = createDashboardQueryClient();
        const queryKey = ["observed-query-state-test"] as const;
        queryClient.setQueryData(queryKey, "first");
        const wrapper = ({ children }: { readonly children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        let stateRenderCount = 0;
        let dataRenderCount = 0;
        const state = renderHook(
            () => {
                stateRenderCount += 1;
                return useObservedQueryState<string>(queryKey);
            },
            { wrapper }
        );
        const data = renderHook(
            () => {
                dataRenderCount += 1;
                return useObservedQueryData<string>(queryKey);
            },
            { wrapper }
        );
        const observer = new QueryObserver(queryClient, {
            enabled: false,
            queryKey,
        });
        const observerLifecycleEvents: string[] = [];
        const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
            if (
                event.query.queryHash === hashKey(queryKey) &&
                event.type.startsWith("observer")
            ) {
                observerLifecycleEvents.push(event.type);
            }
        });
        let unsubscribe: (() => void) | undefined;

        act(() => {
            unsubscribe = observer.subscribe(() => null);
            observer.setOptions({ enabled: false, queryKey, staleTime: 1000 });
        });
        expect(stateRenderCount).toBe(1);
        expect(dataRenderCount).toBe(1);
        expect(observerLifecycleEvents).toContain("observerAdded");
        expect(observerLifecycleEvents).toContain("observerOptionsUpdated");

        act(() => {
            queryClient.setQueryData(queryKey, "second");
        });
        expect(state.result.current?.data).toBe("second");
        expect(data.result.current).toBe("second");
        expect(stateRenderCount).toBe(2);
        expect(dataRenderCount).toBe(2);

        act(() => {
            queryClient.removeQueries({ exact: true, queryKey });
        });
        expect(state.result.current).toBeUndefined();
        expect(data.result.current).toBeUndefined();
        expect(stateRenderCount).toBe(3);
        expect(dataRenderCount).toBe(3);

        act(() => unsubscribe?.());
        unsubscribeCache();
        expect(observerLifecycleEvents).toContain("observerRemoved");
        expect(stateRenderCount).toBe(3);
        expect(dataRenderCount).toBe(3);
    });
});
