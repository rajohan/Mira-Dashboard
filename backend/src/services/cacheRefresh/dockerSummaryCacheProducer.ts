import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { getContainers, getImages, getVolumes } from "../docker/inventory.ts";
import {
    getDockerUpdaterEvents,
    getDockerUpdaterServices,
    getDockerUpdaterSummary,
} from "../docker/updaterProjection.ts";
import { nowIso } from "./cacheProducerSupport.ts";

export const DOCKER_SUMMARY_KEY = "docker.summary";

/**
 * Refreshes the combined Docker inventory and updater summary.
 * @returns Refreshed cache keys.
 */
export async function refreshDockerSummaryCache(): Promise<{ refreshed: string[] }> {
    const containers = await getContainers();
    const [images, volumes] = await Promise.all([
        getImages(containers),
        getVolumes(containers),
    ]);
    const updaterServices = getDockerUpdaterServices();
    const updaterEvents = getDockerUpdaterEvents(25);
    const payload = {
        checkedAt: nowIso(),
        containers,
        images,
        volumes,
        updaterServices,
        updaterEvents,
        updaterSummary: getDockerUpdaterSummary(updaterServices),
    };
    writeCacheSuccess({
        key: DOCKER_SUMMARY_KEY,
        data: payload,
        source: "backend",
        ttl: 45,
        ttlUnit: "minutes",
        metadata: {
            producer: "refreshCacheProducer",
            workflow: "Cache Foundation - Docker Summary",
            refreshIntervalMinutes: 30,
        },
    });
    return { refreshed: [DOCKER_SUMMARY_KEY] };
}
