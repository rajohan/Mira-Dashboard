import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { cacheRefreshResponseParser } from "../../../contracts/cache";
import {
    type DockerContainerAction,
    type DockerContainerActionRequest,
    type DockerContainer,
    type DockerContainerDetails,
    type DockerExecStartRequest,
    type DockerExecJob,
    type DockerPruneRequest,
    type DockerStackActionRequest,
    parseDockerContainerDetails,
    parseDockerContainerLogsResponse,
    parseDockerContainersResponse,
    parseDockerExecJob,
    parseDockerExecStartResponse,
    parseDockerManualUpdateResult,
    parseDockerOutputResponse,
    parseDockerPruneResponse,
    parseDockerSuccessResponse,
    parseDockerSummaryCache,
    parseDockerUpdaterRunResult,
} from "../../../contracts/docker";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiDeleteParsed, apiFetchParsed, apiPostParsed } from "./useApi";
import { cacheKeys, useCacheEntry } from "./useCache";

/** Defines Docker keys. */
export const dockerKeys = {
    containers: ["docker", "containers"] as const,
    container: (containerId: string) => ["docker", "container", containerId] as const,
    containerLogs: (containerId: string, tail: number) =>
        ["docker", "container-logs", containerId, tail] as const,
    images: ["docker", "images"] as const,
    volumes: ["docker", "volumes"] as const,
    execJob: (jobId: string | undefined) => ["docker", "exec", jobId] as const,
    updaterServices: ["docker", "updater", "services"] as const,
    updaterEvents: (limit: number) => ["docker", "updater", "events", limit] as const,
    summaryRefresh: ["docker", "summary-refresh"] as const,
};

const DOCKER_CONTAINER_REFRESH_MS = refreshPolicy.active;
const DOCKER_SUMMARY_REFRESH_MS = refreshPolicy.background;

function invalidateDockerSummary(queryClient: ReturnType<typeof useQueryClient>) {
    return queryClient.invalidateQueries({ queryKey: cacheKeys.entry("docker.summary") });
}

async function refreshDockerSummary(queryClient: ReturnType<typeof useQueryClient>) {
    try {
        await apiPostParsed(
            "/cache/docker.summary/refresh",
            cacheRefreshResponseParser(parseDockerSummaryCache)
        );
    } finally {
        await invalidateDockerSummary(queryClient);
    }
}

/**
 * Fetches container.
 * @param containerId Container identifier.
 * @returns Promise resolving to the fetch container result.
 */
async function fetchContainer(containerId: string): Promise<DockerContainerDetails> {
    return apiFetchParsed(
        `/docker/containers/${encodeURIComponent(containerId)}`,
        parseDockerContainerDetails
    );
}

async function fetchDockerContainers(): Promise<DockerContainer[]> {
    const data = await apiFetchParsed(
        "/docker/containers",
        parseDockerContainersResponse
    );
    return data.containers;
}

/**
 * Fetches container logs.
 * @param containerId Container identifier.
 * @param tail Tail value.
 * @returns Promise resolving to the fetch container logs result.
 */
async function fetchContainerLogs(containerId: string, tail: number): Promise<string> {
    const data = await apiFetchParsed(
        `/docker/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`,
        parseDockerContainerLogsResponse
    );
    return data.content || "";
}

/**
 * Fetches Docker exec job.
 * @param jobId Job identifier.
 * @returns Promise resolving to the fetch docker exec job result.
 */
async function fetchDockerExecJob(jobId: string): Promise<DockerExecJob> {
    return apiFetchParsed(
        `/docker/exec/${encodeURIComponent(jobId)}`,
        parseDockerExecJob
    );
}

/**
 * Provides Docker containers.
 * @returns The Docker containers.
 */
export function useDockerContainers() {
    const query = useCacheEntry("docker.summary", parseDockerSummaryCache, false, {
        refreshOnMissing: true,
    });
    const liveQuery = useQuery({
        queryKey: dockerKeys.containers,
        queryFn: fetchDockerContainers,
        refetchInterval: DOCKER_CONTAINER_REFRESH_MS,
        refetchIntervalInBackground: false,
        staleTime: 1000,
    });
    const cachedContainers = query.data?.data.containers ?? [];
    const containers = liveQuery.data ?? cachedContainers;

    return {
        ...query,
        data: containers,
        error: liveQuery.error ?? query.error,
        isError: liveQuery.isError && containers.length === 0,
        isFetching: liveQuery.isFetching || query.isFetching,
        isLoading: liveQuery.isLoading && query.isLoading,
    };
}

/**
 * Provides Docker container.
 * @param containerId Container identifier.
 * @returns The Docker container.
 */
export function useDockerContainer(containerId: string | undefined) {
    return useQuery({
        queryKey: dockerKeys.container(containerId || ""),
        queryFn: () => fetchContainer(containerId!),
        enabled: Boolean(containerId),
        refetchInterval: refreshPolicy.static,
        refetchOnWindowFocus: false,
        staleTime: 60_000,
    });
}

/**
 * Provides Docker container logs.
 * @param containerId Container identifier.
 * @param tail Tail value.
 * @param isEnabled Whether is enabled.
 * @returns The Docker container logs.
 */
export function useDockerContainerLogs(
    containerId: string | undefined,
    tail: number,
    isEnabled = true
) {
    return useQuery({
        queryKey: dockerKeys.containerLogs(containerId || "", tail),
        queryFn: () => fetchContainerLogs(containerId!, tail),
        enabled: isEnabled && Boolean(containerId),
        refetchInterval: refreshPolicy.active,
    });
}

/**
 * Provides Docker images.
 * @returns The Docker images.
 */
export function useDockerImages() {
    const query = useCacheEntry("docker.summary", parseDockerSummaryCache, false, {
        refreshOnMissing: true,
    });
    return { ...query, data: query.data?.data.images ?? [] };
}

/**
 * Provides Docker volumes.
 * @returns The Docker volumes.
 */
export function useDockerVolumes() {
    const query = useCacheEntry("docker.summary", parseDockerSummaryCache, false, {
        refreshOnMissing: true,
    });
    return { ...query, data: query.data?.data.volumes ?? [] };
}

/**
 * Provides Docker exec job.
 * @param jobId Job identifier.
 * @returns The Docker exec job.
 */
export function useDockerExecJob(jobId: string | undefined) {
    return useQuery({
        queryKey: dockerKeys.execJob(jobId),
        queryFn: () => fetchDockerExecJob(jobId!),
        enabled: Boolean(jobId),
        refetchInterval: (query) => {
            const state = query.state.data;
            return state?.status === "done" ? false : 1000;
        },
    });
}

/**
 * Provides Docker updater services.
 * @returns The Docker updater services.
 */
export function useDockerUpdaterServices() {
    const query = useCacheEntry("docker.summary", parseDockerSummaryCache, false, {
        refreshOnMissing: true,
    });
    return {
        ...query,
        data: {
            services: query.data?.data.updaterServices ?? [],
            summary: query.data?.data.updaterSummary ?? {
                autoPolicy: 0,
                enabled: 0,
                failed: 0,
                notifyPolicy: 0,
                total: 0,
                updateAvailable: 0,
            },
        },
    };
}

/**
 * Provides Docker updater events.
 * @param limit Limit value.
 * @returns The Docker updater events.
 */
export function useDockerUpdaterEvents(limit = 25) {
    const query = useCacheEntry("docker.summary", parseDockerSummaryCache, false, {
        refreshOnMissing: true,
    });
    return { ...query, data: (query.data?.data.updaterEvents ?? []).slice(0, limit) };
}

/**
 * Provides Docker summary refresh.
 * @returns The Docker summary refresh.
 */
export function useRefreshDockerSummary() {
    const queryClient = useQueryClient();
    return () => refreshDockerSummary(queryClient);
}

/**
 * Keeps the complete Docker summary fresh while the Docker page is mounted.
 * @returns Docker summary auto refresh state and actions.
 */
export function useDockerSummaryAutoRefresh() {
    const queryClient = useQueryClient();
    return useQuery({
        queryKey: dockerKeys.summaryRefresh,
        queryFn: async () => {
            await refreshDockerSummary(queryClient);
            return Date.now();
        },
        refetchInterval: DOCKER_SUMMARY_REFRESH_MS,
        refetchIntervalInBackground: false,
        staleTime: 0,
    });
}

/**
 * Provides Docker action.
 * @returns The Docker action.
 */
export function useDockerAction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            containerId,
            action,
        }: {
            containerId: string;
            action: DockerContainerAction;
        }) =>
            apiPostParsed(
                `/docker/containers/${encodeURIComponent(containerId)}/action`,
                parseDockerOutputResponse,
                {
                    action,
                } satisfies DockerContainerActionRequest
            ),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.containers }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.images }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.volumes }),
            ]);
        },
    });
}

/**
 * Provides Docker manual update.
 * @returns The Docker manual update.
 */
export function useDockerManualUpdate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (serviceId: number) =>
            apiPostParsed(
                `/docker/updater/services/${encodeURIComponent(String(serviceId))}/update`,
                parseDockerManualUpdateResult
            ),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.containers }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.images }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.volumes }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.updaterServices }),
                queryClient.invalidateQueries({
                    queryKey: ["docker", "updater", "events"],
                }),
            ]);
        },
    });
}

/**
 * Provides run Docker updater.
 * @returns The run Docker updater.
 */
export function useRunDockerUpdater() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () =>
            apiPostParsed("/docker/updater/run", parseDockerUpdaterRunResult),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.containers }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.images }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.volumes }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.updaterServices }),
                queryClient.invalidateQueries({
                    queryKey: ["docker", "updater", "events"],
                }),
            ]);
        },
    });
}

/**
 * Provides delete Docker image.
 * @returns The delete Docker image.
 */
export function useDeleteDockerImage() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (imageId: string) =>
            apiDeleteParsed(
                `/docker/images/${encodeURIComponent(imageId)}`,
                parseDockerSuccessResponse
            ),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.images }),
            ]);
        },
    });
}

/**
 * Provides delete Docker volume.
 * @returns The delete Docker volume.
 */
export function useDeleteDockerVolume() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (volumeName: string) =>
            apiDeleteParsed(
                `/docker/volumes/${encodeURIComponent(volumeName)}`,
                parseDockerSuccessResponse
            ),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.volumes }),
            ]);
        },
    });
}

/**
 * Provides Docker prune.
 * @returns The Docker prune.
 */
export function useDockerPrune() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (target: "images" | "volumes") =>
            apiPostParsed("/docker/prune", parseDockerPruneResponse, {
                target,
            } satisfies DockerPruneRequest),
        onSuccess: async (_, target) => {
            await refreshDockerSummary(queryClient);
            if (target === "images") {
                await queryClient.invalidateQueries({ queryKey: dockerKeys.images });
            } else if (target === "volumes") {
                await queryClient.invalidateQueries({ queryKey: dockerKeys.volumes });
            }
            await queryClient.invalidateQueries({ queryKey: dockerKeys.containers });
        },
    });
}

/**
 * Restarts the complete Docker stack through the authenticated API client.
 * @returns Restart docker stack result.
 */
export function restartDockerStack() {
    return apiPostParsed("/docker/stack/action", parseDockerOutputResponse, {
        action: "restart",
    } satisfies DockerStackActionRequest);
}

/**
 * Performs start Docker exec.
 * @param containerId Container identifier.
 * @param command Command value.
 * @returns Start Docker exec result.
 */
export function startDockerExec(containerId: string, command: string) {
    return apiPostParsed("/docker/exec/start", parseDockerExecStartResponse, {
        command,
        containerId,
    } satisfies DockerExecStartRequest);
}

/**
 * Performs stop Docker exec.
 * @param jobId Job identifier.
 * @returns Stop Docker exec result.
 */
export function stopDockerExec(jobId: string) {
    return apiPostParsed(
        `/docker/exec/${encodeURIComponent(jobId)}/stop`,
        parseDockerSuccessResponse
    );
}
