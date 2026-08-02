import { parseDockerSummaryCache } from "../../../../contracts/docker/summary.ts";
import { json, jsonWithEtag } from "../../http/core.ts";
import { getCacheEntry } from "../../lib/cacheStore.ts";
import { CoalescedSnapshot } from "../../lib/coalescedSnapshot.ts";
import { getContainers, getContainerStatsRows } from "../../services/docker/inventory.ts";
import { parseJsonField } from "./request.ts";

const dockerStatsSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof getContainerStatsRows>>
>({
    freshForMs: 2000,
    load: getContainerStatsRows,
    name: "docker.stats",
    staleForMs: 15_000,
});

const dockerStateSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof getContainers>>
>({
    freshForMs: 2000,
    load: async () => getContainers(await dockerStatsSnapshot.read()),
    name: "docker.state",
    staleForMs: 15_000,
});

/**
 * Reads the shared raw Docker stats sampler for polling routes.
 * @returns Current Docker stats rows.
 */
export async function getDockerStatsSnapshot() {
    return await dockerStatsSnapshot.read();
}

/**
 * Returns the shared read-only container sampler for polling routes.
 * @returns the shared read-only container sampler for polling routes.
 */
export async function getDockerContainersSnapshot() {
    return await dockerStateSnapshot.read();
}

export function invalidateDockerReadSnapshots(): void {
    dockerStateSnapshot.invalidate();
    dockerStatsSnapshot.invalidate();
}

export function dockerSnapshotJson(
    request: Request | undefined,
    data: unknown
): Response {
    return request ? jsonWithEtag(request, data) : json(data);
}

export function getIsolatedDockerContainers() {
    const entry = getCacheEntry("docker.summary");
    const snapshot = parseJsonField<unknown>(entry?.data);
    if (!entry || snapshot === undefined) {
        throw new Error("Isolated Docker snapshot is unavailable");
    }
    return parseDockerSummaryCache(snapshot, "docker.summary").containers;
}
