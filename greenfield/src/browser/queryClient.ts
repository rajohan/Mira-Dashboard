import { QueryClient } from "@tanstack/react-query";

/**
 * Creates one browser-owned query cache with bounded retry and retention defaults.
 * @returns A fresh QueryClient for one application or isolated test lifetime.
 */
export function createDashboardQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: {
                gcTime: 5 * 60 * 1000,
                refetchOnWindowFocus: false,
                retry: 2,
                staleTime: 30 * 1000,
            },
        },
    });
}
