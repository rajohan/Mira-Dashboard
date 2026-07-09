import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDeleteRequired, apiFetchRequired, apiPostRequired } from "./useApi";
import { cacheKeys, useCacheEntry } from "./useCache";

/** Represents Docker container. */
export interface DockerContainer {
    id: string;
    name: string;
    image: string;
    imageId: string;
    command: string;
    createdAt: string;
    startedAt: string | undefined;
    finishedAt: string | undefined;
    runningFor: string;
    state: string;
    status: string;
    health: string;
    restartCount: number;
    service: string | undefined;
    project: string | undefined;
    ports: string[];
    ipAddresses: Record<string, string>;
    mounts: Array<{
        type: string;
        source: string;
        destination: string;
        mode: string;
        readOnly: boolean;
        name?: string;
    }>;
    stats: undefined | DockerContainerStats;
}

/** Represents Docker container live stats. */
export interface DockerContainerStats {
    blockIO: string;
    cpu: string;
    id?: string;
    memory: string;
    memoryPercent: string;
    netIO: string;
    pids: string;
}

/** Represents Docker container details. */
export interface DockerContainerDetails extends DockerContainer {
    env: string[];
    labels: Record<string, string>;
    networks: Array<{
        name: string;
        ipAddress: string;
        gateway: string;
        macAddress: string;
    }>;
}

/** Represents Docker image. */
export interface DockerImage {
    id: string;
    repository: string;
    tag: string;
    containerName: string;
    platform: string;
    size: number;
    createdAt: string;
    lastTagTime: string;
    inUseBy: string[];
}

/** Represents Docker volume. */
export interface DockerVolume {
    name: string;
    driver: string;
    mountpoint: string;
    scope: string;
    size: string;
    labels: Record<string, string>;
    usedBy: string[];
}

/** Represents Docker exec job. */
export interface DockerExecJob {
    jobId: string;
    containerId: string;
    status: "running" | "done";
    code: number | undefined;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | undefined;
}

/** Represents Docker updater service. */
export interface DockerUpdaterService {
    id: number;
    appSlug: string;
    serviceName: string;
    composeImageRef: string | undefined;
    imageRepo: string;
    currentTag: string | undefined;
    currentDigest: string | undefined;
    latestTag: string | undefined;
    latestDigest: string | undefined;
    policy: string;
    pinMode: string;
    enabled: boolean;
    lastCheckedAt: string | undefined;
    lastUpdatedAt: string | undefined;
    lastStatus: string | undefined;
    updateAvailable: boolean;
    metadata: Record<string, unknown>;
}

/** Represents Docker updater event. */
export interface DockerUpdaterEvent {
    id: number;
    managedServiceId: number;
    appSlug: string;
    serviceName: string;
    eventType: string;
    fromTag: string | undefined;
    toTag: string | undefined;
    fromDigest: string | undefined;
    toDigest: string | undefined;
    message: string | undefined;
    details: Record<string, unknown>;
    createdAt: string;
}

/** Represents Docker updater summary. */
export interface DockerUpdaterSummary {
    total: number;
    enabled: number;
    updateAvailable: number;
    autoPolicy: number;
    notifyPolicy: number;
    failed: number;
}

/** Represents Docker manual update result. */
export interface DockerManualUpdateResult {
    isSuccess: boolean;
    service: DockerUpdaterService;
    result: {
        isOk: boolean;
        workflow: string;
        mode: string;
        summary: {
            eligible: number;
            updated: number;
            failed: number;
        };
        updated: Array<{
            eventId: number;
            appSlug: string;
            serviceName: string;
            targetImageRef: string;
        }>;
        failed: Array<{
            appSlug: string;
            serviceName: string;
            targetImageRef: string;
            error: string;
        }>;
    };
    stderr: string;
}

/** Represents Docker updater run step. */
export interface DockerUpdaterRunStep {
    step: string;
    isOk: boolean;
    stdout: string;
    stderr: string;
}

/** Represents Docker updater run result. */
export interface DockerUpdaterRunResult {
    isSuccess: boolean;
    steps: DockerUpdaterRunStep[];
}

export interface DockerSummaryCache {
    checkedAt: string;
    containers: DockerContainer[];
    images: DockerImage[];
    volumes: DockerVolume[];
    updaterServices: DockerUpdaterService[];
    updaterEvents: DockerUpdaterEvent[];
    updaterSummary: DockerUpdaterSummary;
}

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
    containerStats: ["docker", "containers", "stats"] as const,
};

function invalidateDockerSummary(queryClient: ReturnType<typeof useQueryClient>) {
    return queryClient.invalidateQueries({ queryKey: cacheKeys.entry("docker.summary") });
}

async function refreshDockerSummary(queryClient: ReturnType<typeof useQueryClient>) {
    try {
        await apiPostRequired("/cache/docker.summary/refresh");
    } catch (error) {
        console.warn("[Docker] Failed to refresh Docker summary cache:", error);
    }

    await invalidateDockerSummary(queryClient);
}

/** Fetches container. */
async function fetchContainer(containerId: string): Promise<DockerContainerDetails> {
    return apiFetchRequired<DockerContainerDetails>(
        `/docker/containers/${encodeURIComponent(containerId)}`
    );
}

/** Fetches container logs. */
async function fetchContainerLogs(containerId: string, tail: number): Promise<string> {
    const data = await apiFetchRequired<{ content: string }>(
        `/docker/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`
    );
    return data.content || "";
}

/** Fetches Docker exec job. */
async function fetchDockerExecJob(jobId: string): Promise<DockerExecJob> {
    return apiFetchRequired<DockerExecJob>(`/docker/exec/${encodeURIComponent(jobId)}`);
}

async function fetchDockerContainerStats(): Promise<DockerContainerStats[]> {
    const data = await apiFetchRequired<{ stats: DockerContainerStats[] }>(
        "/docker/containers/stats"
    );
    return data.stats;
}

/** Provides Docker containers. */
export function useDockerContainers() {
    const query = useCacheEntry<DockerSummaryCache>("docker.summary", 30_000, {
        refreshOnMissing: true,
    });
    const statsQuery = useQuery({
        queryKey: dockerKeys.containerStats,
        queryFn: fetchDockerContainerStats,
        refetchInterval: 5000,
        staleTime: 1000,
    });
    const statsById = new Map(
        (statsQuery.data ?? []).flatMap((stats) =>
            stats.id ? ([[stats.id, stats]] as const) : []
        )
    );
    const hasLiveStats = statsQuery.isSuccess;

    return {
        ...query,
        data: (query.data?.data.containers ?? []).map((container) => {
            const liveStats = statsById.get(container.id);
            return {
                ...container,
                stats: hasLiveStats ? liveStats : (liveStats ?? container.stats),
            };
        }),
    };
}

/** Provides Docker container. */
export function useDockerContainer(containerId: string | undefined) {
    return useQuery({
        queryKey: dockerKeys.container(containerId || ""),
        queryFn: () => fetchContainer(containerId!),
        enabled: Boolean(containerId),
        refetchInterval: 5000,
    });
}

/** Provides Docker container logs. */
export function useDockerContainerLogs(
    containerId: string | undefined,
    tail: number,
    isEnabled = true
) {
    return useQuery({
        queryKey: dockerKeys.containerLogs(containerId || "", tail),
        queryFn: () => fetchContainerLogs(containerId!, tail),
        enabled: isEnabled && Boolean(containerId),
        refetchInterval: 5000,
    });
}

/** Provides Docker images. */
export function useDockerImages() {
    const query = useCacheEntry<DockerSummaryCache>("docker.summary", 30_000, {
        refreshOnMissing: true,
    });
    return { ...query, data: query.data?.data.images ?? [] };
}

/** Provides Docker volumes. */
export function useDockerVolumes() {
    const query = useCacheEntry<DockerSummaryCache>("docker.summary", 30_000, {
        refreshOnMissing: true,
    });
    return { ...query, data: query.data?.data.volumes ?? [] };
}

/** Provides Docker exec job. */
export function useDockerExecJob(jobId: string | undefined) {
    return useQuery({
        queryKey: dockerKeys.execJob(jobId),
        queryFn: () => fetchDockerExecJob(jobId!),
        enabled: Boolean(jobId),
        refetchInterval: (query) => {
            const state = query.state.data as DockerExecJob | undefined;
            return state?.status === "done" ? false : 1000;
        },
    });
}

/** Provides Docker updater services. */
export function useDockerUpdaterServices() {
    const query = useCacheEntry<DockerSummaryCache>("docker.summary", 30_000, {
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

/** Provides Docker updater events. */
export function useDockerUpdaterEvents(limit = 25) {
    const query = useCacheEntry<DockerSummaryCache>("docker.summary", 30_000, {
        refreshOnMissing: true,
    });
    return { ...query, data: (query.data?.data.updaterEvents ?? []).slice(0, limit) };
}

/** Provides Docker summary refresh. */
export function useRefreshDockerSummary() {
    const queryClient = useQueryClient();
    return () => refreshDockerSummary(queryClient);
}

/** Provides Docker action. */
export function useDockerAction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ containerId, action }: { containerId: string; action: string }) =>
            apiPostRequired<{ output: string }>(
                `/docker/containers/${encodeURIComponent(containerId)}/action`,
                {
                    action,
                }
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

/** Provides Docker manual update. */
export function useDockerManualUpdate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (serviceId: number) =>
            apiPostRequired<DockerManualUpdateResult>(
                `/docker/updater/services/${encodeURIComponent(String(serviceId))}/update`
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

/** Provides run Docker updater. */
export function useRunDockerUpdater() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPostRequired<DockerUpdaterRunResult>("/docker/updater/run"),
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

/** Provides delete Docker image. */
export function useDeleteDockerImage() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (imageId: string) =>
            apiDeleteRequired<{ isSuccess: boolean }>(
                `/docker/images/${encodeURIComponent(imageId)}`
            ),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.images }),
            ]);
        },
    });
}

/** Provides delete Docker volume. */
export function useDeleteDockerVolume() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (volumeName: string) =>
            apiDeleteRequired<{ isSuccess: boolean }>(
                `/docker/volumes/${encodeURIComponent(volumeName)}`
            ),
        onSuccess: async () => {
            await Promise.all([
                refreshDockerSummary(queryClient),
                queryClient.invalidateQueries({ queryKey: dockerKeys.volumes }),
            ]);
        },
    });
}

/** Provides Docker prune. */
export function useDockerPrune() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (target: "images" | "volumes") =>
            apiPostRequired<{ isSuccess: boolean; output: string }>("/docker/prune", {
                target,
            }),
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

/** Performs start Docker exec. */
export function startDockerExec(containerId: string, command: string) {
    return apiPostRequired<{ jobId: string }>("/docker/exec/start", {
        containerId,
        command,
    });
}

/** Performs stop Docker exec. */
export function stopDockerExec(jobId: string) {
    return apiPostRequired<{ isSuccess: boolean }>(
        `/docker/exec/${encodeURIComponent(jobId)}/stop`
    );
}
