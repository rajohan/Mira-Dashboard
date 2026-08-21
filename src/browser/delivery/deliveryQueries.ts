import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { cacheRealtimeTopic } from "../../contracts/cacheRealtime.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import type { DeliveryClient } from "./deliveryClient.ts";

export const deliveryQueryRoot = ["delivery"] as const;
export const deliveryPullRequestsQueryKey = [
    ...deliveryQueryRoot,
    "pull-requests",
] as const;
export const deliveryPreviewQueryKey = [...deliveryQueryRoot, "preview"] as const;
export const deliveryCheckoutQueryKey = [...deliveryQueryRoot, "checkout"] as const;
export const deliveryReleasesQueryKey = [...deliveryQueryRoot, "releases"] as const;
export const deliveryDeploymentsQueryKey = [...deliveryQueryRoot, "deployments"] as const;

const deliveryRefreshIntervalMs = 30_000;

export function deliveryPullRequestsQueryOptions(client: DeliveryClient) {
    return queryOptions({
        queryFn: ({ signal }) =>
            client.query("delivery.listPullRequests", {}, { signal }),
        queryKey: deliveryPullRequestsQueryKey,
        refetchInterval: deliveryRefreshIntervalMs,
        retry: false,
        staleTime: 15_000,
    });
}

export function deliveryPreviewQueryOptions(client: DeliveryClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("delivery.getPreview", {}, { signal }),
        queryKey: deliveryPreviewQueryKey,
        refetchInterval: 10_000,
        retry: false,
        staleTime: 2000,
    });
}

export function deliveryCheckoutQueryOptions(client: DeliveryClient) {
    return queryOptions({
        queryFn: ({ signal }) =>
            client.query("delivery.getProductionCheckout", {}, { signal }),
        queryKey: deliveryCheckoutQueryKey,
        refetchInterval: deliveryRefreshIntervalMs,
        retry: false,
        staleTime: 3000,
    });
}

export function deliveryReleasesQueryOptions(client: DeliveryClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("delivery.getReleases", {}, { signal }),
        queryKey: deliveryReleasesQueryKey,
        refetchInterval: deliveryRefreshIntervalMs,
        retry: false,
        staleTime: 10_000,
    });
}

export function deliveryDeploymentsQueryOptions(client: DeliveryClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("delivery.listDeployments", {}, { signal }),
        queryKey: deliveryDeploymentsQueryKey,
        refetchInterval: deliveryRefreshIntervalMs,
        retry: false,
        staleTime: 10_000,
    });
}

export async function refreshDeliveryOverviewQueries(queryClient: QueryClient) {
    await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: deliveryPullRequestsQueryKey }),
        queryClient.invalidateQueries({ queryKey: deliveryPreviewQueryKey }),
        queryClient.invalidateQueries({ queryKey: deliveryCheckoutQueryKey }),
        queryClient.invalidateQueries({ queryKey: deliveryReleasesQueryKey }),
    ]);
}

export async function refreshDeliveryQueries(queryClient: QueryClient) {
    await Promise.allSettled([
        refreshDeliveryOverviewQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: deliveryDeploymentsQueryKey }),
    ]);
}

/** Realtime invalidation with bounded polling fallback for cache and Job changes. */
export function useDeliveryRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: deliveryRefreshIntervalMs,
        refreshDelayMs: 100,
        refreshQueries: refreshDeliveryOverviewQueries,
        topic: cacheRealtimeTopic,
    });
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: deliveryRefreshIntervalMs,
        refreshDelayMs: 100,
        refreshQueries: refreshDeliveryQueries,
        topic: jobRealtimeTopics.runs,
    });
}
