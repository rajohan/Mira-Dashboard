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

export type DockerOverviewDiscoveryStage =
    | "compose-discovery"
    | "engine-inventory"
    | "overview-projection";

export class DockerOverviewDiscoveryError extends Error {
    public readonly stage: DockerOverviewDiscoveryStage;

    public constructor(stage: DockerOverviewDiscoveryStage, cause: unknown) {
        super("Docker overview discovery failed", { cause });
        this.name = "DockerOverviewDiscoveryError";
        this.stage = stage;
    }
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
        let engineSnapshot: Awaited<ReturnType<typeof engine.collect>>;
        try {
            engineSnapshot = await engine.collect(signal);
        } catch (error) {
            signal?.throwIfAborted();
            throw new DockerOverviewDiscoveryError("engine-inventory", error);
        }
        signal?.throwIfAborted();
        let compose: DockerComposeDiscoveryResult;
        try {
            compose = discoverCompose(dockerEngineComposeIdentities(engineSnapshot));
        } catch (error) {
            signal?.throwIfAborted();
            throw new DockerOverviewDiscoveryError("compose-discovery", error);
        }
        signal?.throwIfAborted();
        let payload: DockerOverviewCachePayload;
        try {
            const retained = previousPayload(previous);
            payload = projectDockerOverview({
                compose,
                engine: engineSnapshot,
                observedAtMs: nowMs(),
                ...(retained === undefined ? {} : { previous: retained }),
            });
        } catch (error) {
            signal?.throwIfAborted();
            throw new DockerOverviewDiscoveryError("overview-projection", error);
        }
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
