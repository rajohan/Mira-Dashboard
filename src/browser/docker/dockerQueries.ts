import { queryOptions } from "@tanstack/react-query";

import type { DockerClient } from "./dockerClient.ts";

export const dockerOverviewQueryKey = ["docker", "overview"] as const;
export const dockerOverviewRefreshIntervalMs = 5000;

/** @returns The foreground-polled bounded Docker Engine and Compose overview query. */
export function dockerOverviewQueryOptions(client: DockerClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("docker.overview", {}, { signal }),
        queryKey: dockerOverviewQueryKey,
        refetchInterval: dockerOverviewRefreshIntervalMs,
        refetchOnMount: "always",
        retry: false,
    });
}
