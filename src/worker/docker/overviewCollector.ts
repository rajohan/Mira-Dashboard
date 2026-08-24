import * as v from "valibot";

import {
    dockerOverviewCachePayloadSchema,
    type DockerOverviewCachePayload,
} from "../../contracts/docker.ts";
import {
    discoverDockerComposeServices,
    type DockerComposeDiscoveryResult,
    type DockerEngineComposeIdentity,
} from "./composeDiscovery.ts";
import {
    createDockerEngineInventoryCollector,
    type DockerEngineInventoryCollector,
} from "./engineInventory.ts";
import {
    dockerEngineComposeIdentities,
    projectDockerOverview,
} from "./overviewProjection.ts";

export interface DockerOverviewCollector {
    readonly collect: (
        previous?: unknown,
        signal?: AbortSignal
    ) => Promise<DockerOverviewCachePayload>;
    readonly discover: (
        previous?: unknown,
        signal?: AbortSignal
    ) => Promise<DockerOverviewDiscovery>;
}

export interface DockerOverviewDiscovery {
    readonly compose: DockerComposeDiscoveryResult;
    readonly payload: DockerOverviewCachePayload;
}

export interface DockerOverviewCollectorOptions {
    readonly discoverCompose?: (
        identities: readonly DockerEngineComposeIdentity[]
    ) => DockerComposeDiscoveryResult;
    readonly engine?: DockerEngineInventoryCollector;
    readonly nowMs?: () => number;
}

function previousPayload(value: unknown): DockerOverviewCachePayload | undefined {
    const parsed = v.safeParse(dockerOverviewCachePayloadSchema, value, {
        abortEarly: true,
    });
    return parsed.success ? parsed.output : undefined;
}

/**
 * Creates the worker-owned all-or-nothing Docker overview collector.
 * @param options Injectable read-only Engine, Compose, and clock boundaries.
 * @returns Collector that rediscovers topology on every refresh.
 */
export function createDockerOverviewCollector(
    options: DockerOverviewCollectorOptions = {}
): DockerOverviewCollector {
    const engine = options.engine ?? createDockerEngineInventoryCollector();
    const discoverCompose = options.discoverCompose ?? discoverDockerComposeServices;
    const nowMs = options.nowMs ?? Date.now;
    const discover = async (
        previous?: unknown,
        signal?: AbortSignal
    ): Promise<DockerOverviewDiscovery> => {
        signal?.throwIfAborted();
        const engineSnapshot = await engine.collect(signal);
        signal?.throwIfAborted();
        const compose = discoverCompose(dockerEngineComposeIdentities(engineSnapshot));
        signal?.throwIfAborted();
        const retained = previousPayload(previous);
        const payload = projectDockerOverview({
            compose,
            engine: engineSnapshot,
            observedAtMs: nowMs(),
            ...(retained === undefined ? {} : { previous: retained }),
        });
        return Object.freeze({ compose, payload });
    };
    return Object.freeze({
        async collect(previous?: unknown, signal?: AbortSignal) {
            const discovered = await discover(previous, signal);
            return discovered.payload;
        },
        discover,
    });
}
