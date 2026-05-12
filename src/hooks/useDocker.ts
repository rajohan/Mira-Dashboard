import {
    keepPreviousData,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiFetch, apiPost } from "./useApi";

/** Describes docker container. */
export interface DockerContainer {
    id: string;
    name: string;
    image: string;
    imageId: string;
    command: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    runningFor: string;
    state: string;
    status: string;
    health: string;
    restartCount: number;
    service: string | null;
    project: string | null;
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
    stats: {
        cpu: string;
        memory: string;
        memoryPercent: string;
        netIO: string;
        blockIO: string;
        pids: string;
    } | null;
}

/** Describes docker container details. */
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

/** Describes docker image. */
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

/** Describes docker volume. */
export interface DockerVolume {
    name: string;
    driver: string;
    mountpoint: string;
    scope: string;
    size: string;
    labels: Record<string, string>;
    usedBy: string[];
}

/** Describes docker exec job. */
export interface DockerExecJob {
    jobId: string;
    containerId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
}

/** Describes docker updater service. */
export interface DockerUpdaterService {
    id: number;
    appSlug: string;
    serviceName: string;
    composeImageRef: string | null;
    imageRepo: string;
    currentTag: string | null;
    currentDigest: string | null;
    latestTag: string | null;
    latestDigest: string | null;
    policy: string;
    pinMode: string;
    enabled: boolean;
    lastCheckedAt: string | null;
    lastUpdatedAt: string | null;
    lastStatus: string | null;
    updateAvailable: boolean;
    metadata: Record<string, unknown>;
}

/** Describes docker updater event. */
export interface DockerUpdaterEvent {
    id: number;
    managedServiceId: number;
    appSlug: string;
    serviceName: string;
    eventType: string;
    fromTag: string | null;
    toTag: string | null;
    fromDigest: string | null;
    toDigest: string | null;
    message: string | null;
    details: Record<string, unknown>;
    createdAt: string;
}

/** Describes docker updater summary. */
export interface DockerUpdaterSummary {
    total: number;
    enabled: number;
    updateAvailable: number;
    autoPolicy: number;
    notifyPolicy: number;
    failed: number;
}

/** Describes docker manual update result. */
export interface DockerManualUpdateResult {
    success: boolean;
    service: DockerUpdaterService;
    result: {
        ok: boolean;
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

/** Describes docker updater run step. */
export interface DockerUpdaterRunStep {
    step: string;
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Describes docker updater run result. */
export interface DockerUpdaterRunResult {
    success: boolean;
    steps: DockerUpdaterRunStep[];
}

/** Stores docker keys. */
export const dockerKeys = {
    containers: ["docker", "containers"] as const,
    container: (containerId: string) => ["docker", "container", containerId] as const,
    containerLogs: (containerId: string, tail: number) =>
        ["docker", "container-logs", containerId, tail] as const,
    images: ["docker", "images"] as const,
    volumes: ["docker", "volumes"] as const,
    execJob: (jobId: string | null) => ["docker", "exec", jobId] as const,
    updaterServices: ["docker", "updater", "services"] as const,
    updaterEvents: (limit: number) => ["docker", "updater", "events", limit] as const,
};

/** Handles fetch containers. */
async function fetchContainers(): Promise<DockerContainer[]> {
    const data = await apiFetch<{ containers: DockerContainer[] }>("/docker/containers");
    return data.containers || [];
}

/** Handles fetch container. */
async function fetchContainer(containerId: string): Promise<DockerContainerDetails> {
    return apiFetch<DockerContainerDetails>(
        `/docker/containers/${encodeURIComponent(containerId)}`
    );
}

/** Handles fetch container logs. */
async function fetchContainerLogs(containerId: string, tail: number): Promise<string> {
    const data = await apiFetch<{ content: string }>(
        `/docker/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`
    );
    return data.content || "";
}

/** Handles fetch images. */
async function fetchImages(): Promise<DockerImage[]> {
    const data = await apiFetch<{ images: DockerImage[] }>("/docker/images");
    return data.images || [];
}

/** Handles fetch volumes. */
async function fetchVolumes(): Promise<DockerVolume[]> {
    const data = await apiFetch<{ volumes: DockerVolume[] }>("/docker/volumes");
    return data.volumes || [];
}

/** Handles fetch docker exec job. */
async function fetchDockerExecJob(jobId: string): Promise<DockerExecJob> {
    return apiFetch<DockerExecJob>(`/docker/exec/${encodeURIComponent(jobId)}`);
}

/** Handles fetch docker updater services. */
async function fetchDockerUpdaterServices(): Promise<{
    services: DockerUpdaterService[];
    summary: DockerUpdaterSummary;
}> {
    return apiFetch<{ services: DockerUpdaterService[]; summary: DockerUpdaterSummary }>(
        "/docker/updater/services"
    );
}

/** Handles fetch docker updater events. */
async function fetchDockerUpdaterEvents(limit: number): Promise<DockerUpdaterEvent[]> {
    const data = await apiFetch<{ events: DockerUpdaterEvent[] }>(
        `/docker/updater/events?limit=${limit}`
    );
    return data.events || [];
}

/** Handles use docker containers. */
export function useDockerContainers() {
    return useQuery({
        queryKey: dockerKeys.containers,
        queryFn: fetchContainers,
        placeholderData: keepPreviousData,
        staleTime: 5_000,
        refetchInterval: 10_000,
        refetchOnWindowFocus: false,
    });
}

/** Handles use docker container. */
export function useDockerContainer(containerId: string | null) {
    return useQuery({
        queryKey: dockerKeys.container(containerId || ""),
        queryFn: () => fetchContainer(containerId!),
        enabled: Boolean(containerId),
        refetchInterval: 15_000,
    });
}

/** Handles use docker container logs. */
export function useDockerContainerLogs(
    containerId: string | null,
    tail: number,
    enabled = true
) {
    return useQuery({
        queryKey: dockerKeys.containerLogs(containerId || "", tail),
        queryFn: () => fetchContainerLogs(containerId!, tail),
        enabled: enabled && Boolean(containerId),
        refetchInterval: 5_000,
    });
}

/** Handles use docker images. */
export function useDockerImages() {
    return useQuery({
        queryKey: dockerKeys.images,
        queryFn: fetchImages,
        placeholderData: keepPreviousData,
        staleTime: 10_000,
        refetchInterval: 30_000,
        refetchOnWindowFocus: false,
    });
}

/** Handles use docker volumes. */
export function useDockerVolumes() {
    return useQuery({
        queryKey: dockerKeys.volumes,
        queryFn: fetchVolumes,
        placeholderData: keepPreviousData,
        staleTime: 10_000,
        refetchInterval: 30_000,
        refetchOnWindowFocus: false,
    });
}

/** Handles use docker exec job. */
export function useDockerExecJob(jobId: string | null) {
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

/** Handles use docker updater services. */
export function useDockerUpdaterServices() {
    return useQuery({
        queryKey: dockerKeys.updaterServices,
        queryFn: fetchDockerUpdaterServices,
        refetchInterval: 30_000,
        staleTime: 10_000,
        refetchOnWindowFocus: false,
    });
}

/** Handles use docker updater events. */
export function useDockerUpdaterEvents(limit = 50) {
    return useQuery({
        queryKey: dockerKeys.updaterEvents(limit),
        queryFn: () => fetchDockerUpdaterEvents(limit),
        refetchInterval: 30_000,
        staleTime: 10_000,
        refetchOnWindowFocus: false,
    });
}

/** Handles use docker action. */
export function useDockerAction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ containerId, action }: { containerId: string; action: string }) =>
            apiPost<{ output: string }>(
                `/docker/containers/${encodeURIComponent(containerId)}/action`,
                {
                    action,
                }
            ),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: dockerKeys.containers }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.images }),
                queryClient.invalidateQueries({ queryKey: dockerKeys.volumes }),
            ]);
        },
    });
}

/** Handles use docker manual update. */
export function useDockerManualUpdate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (serviceId: number) =>
            apiPost<DockerManualUpdateResult>(
                `/docker/updater/services/${encodeURIComponent(String(serviceId))}/update`
            ),
        onSuccess: async () => {
            await Promise.all([
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

/** Handles use run docker updater. */
export function useRunDockerUpdater() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiPost<DockerUpdaterRunResult>("/docker/updater/run"),
        onSuccess: async () => {
            await Promise.all([
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

/** Handles use delete docker image. */
export function useDeleteDockerImage() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (imageId: string) =>
            apiDelete<{ success: boolean }>(
                `/docker/images/${encodeURIComponent(imageId)}`
            ),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: dockerKeys.images });
        },
    });
}

/** Handles use delete docker volume. */
export function useDeleteDockerVolume() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (volumeName: string) =>
            apiDelete<{ success: boolean }>(
                `/docker/volumes/${encodeURIComponent(volumeName)}`
            ),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: dockerKeys.volumes });
        },
    });
}

/** Handles use docker prune. */
export function useDockerPrune() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (target: "images" | "volumes") =>
            apiPost<{ success: boolean; output: string }>("/docker/prune", { target }),
        onSuccess: async (_, target) => {
            if (target === "images") {
                await queryClient.invalidateQueries({ queryKey: dockerKeys.images });
            }
            if (target === "volumes") {
                await queryClient.invalidateQueries({ queryKey: dockerKeys.volumes });
            }
            await queryClient.invalidateQueries({ queryKey: dockerKeys.containers });
        },
    });
}

/** Handles start docker exec. */
export function startDockerExec(containerId: string, command: string) {
    return apiPost<{ jobId: string }>("/docker/exec/start", { containerId, command });
}

/** Handles stop docker exec. */
export function stopDockerExec(jobId: string) {
    return apiPost<{ success: boolean }>(
        `/docker/exec/${encodeURIComponent(jobId)}/stop`
    );
}
