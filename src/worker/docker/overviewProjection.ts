import * as v from "valibot";

import {
    dockerOverviewCachePayloadSchema,
    type DockerContainer,
    type DockerContainerPort,
    type DockerContainerStats,
    type DockerImage,
    type DockerOverviewCachePayload,
    type DockerUpdaterEvent,
    type DockerUpdaterPolicy,
    type DockerUpdaterService,
    type DockerVolume,
} from "../../contracts/docker.ts";
import type {
    DockerComposeDiscoveredService,
    DockerComposeDiscoveryResult,
    DockerEngineComposeIdentity,
} from "./composeDiscovery.ts";
import type {
    DockerEngineInventoryAvailableContainer,
    DockerEngineInventorySnapshot,
    DockerEngineInventoryStats,
} from "./engineInventory.ts";

const zeroTimestampPattern = /^0001-01-01T00:00:00(?:\.0+)?Z$/u;
const imageTimestampPattern =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}:?\d{2}|Z)(?:\s+[A-Za-z]{1,10})?$/u;
const percentagePattern = /^(\d+(?:\.\d+)?)%$/u;
const sizePattern = /^(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b)$/iu;
const pairSeparatorPattern = /\s*\/\s*/u;

const sizeMultipliers: Readonly<Record<string, number>> = Object.freeze({
    b: 1,
    eb: 1000 ** 6,
    eib: 1024 ** 6,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    pb: 1000 ** 5,
    pib: 1024 ** 5,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
});

function fail(): never {
    throw new Error("Docker overview projection failed");
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function boundedInteger(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) fail();
    return value;
}

function timestampMs(value: string): number {
    if (zeroTimestampPattern.test(value)) fail();
    const direct = Date.parse(value);
    if (Number.isSafeInteger(direct) && direct >= 0) return direct;
    const match = imageTimestampPattern.exec(value.trim());
    if (match === null) fail();
    const [, date, time, rawOffset] = match;
    const offset =
        rawOffset === "Z" ? rawOffset : rawOffset!.replace(/(\d{2})(\d{2})$/u, "$1:$2");
    const parsed = Date.parse(`${date!}T${time!}${offset}`);
    if (!Number.isSafeInteger(parsed) || parsed < 0) fail();
    return parsed;
}

function optionalTimestampMs(value: string): number | undefined {
    return zeroTimestampPattern.test(value) ? undefined : timestampMs(value);
}

function sizeBytes(value: string): number {
    const match = sizePattern.exec(value.trim());
    if (match === null) fail();
    const amount = Number(match[1]);
    const multiplier = sizeMultipliers[match[2]!.toLowerCase()];
    if (!Number.isFinite(amount) || amount < 0 || multiplier === undefined) fail();
    return boundedInteger(Math.round(amount * multiplier));
}

function sizePair(value: string): readonly [number, number] {
    const pair = value.split(pairSeparatorPattern);
    if (pair.length !== 2) fail();
    const result: [number, number] = [sizeBytes(pair[0]!), sizeBytes(pair[1]!)];
    return Object.freeze(result);
}

function percentage(value: string, maximum: number): number {
    const match = percentagePattern.exec(value.trim());
    if (match === null) fail();
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) fail();
    return parsed;
}

function hostScope(address: string): DockerContainerPort["hostScope"] {
    if (address === "127.0.0.1" || address === "::1") return "loopback";
    if (address === "0.0.0.0" || address === "::") return "all-interfaces";
    return "other";
}

function ports(
    container: DockerEngineInventoryAvailableContainer
): DockerContainerPort[] {
    const projected = new Map<string, DockerContainerPort>();
    for (const port of container.publishedPorts) {
        const value = Object.freeze({
            containerPort: port.containerPort,
            hostPort: port.hostPort,
            hostScope: hostScope(port.hostAddress),
            protocol: port.protocol,
        });
        projected.set(
            `${value.containerPort}\0${value.protocol}\0${value.hostPort}\0${value.hostScope}`,
            value
        );
    }
    return [...projected.values()].toSorted(
        (left, right) =>
            left.containerPort - right.containerPort ||
            compareStrings(left.protocol, right.protocol) ||
            (left.hostPort ?? 0) - (right.hostPort ?? 0) ||
            compareStrings(left.hostScope ?? "", right.hostScope ?? "")
    );
}

function networks(
    container: DockerEngineInventoryAvailableContainer
): DockerContainer["networks"] {
    return container.networks
        .map((network) =>
            Object.freeze({
                addresses: [...network.addresses].toSorted(compareStrings),
                name: network.name,
            })
        )
        .toSorted((left, right) => compareStrings(left.name, right.name));
}

function mounts(
    container: DockerEngineInventoryAvailableContainer
): DockerContainer["mounts"] {
    return container.mounts
        .map((mount) =>
            Object.freeze({
                destination: mount.destination,
                ...(mount.name === undefined ? {} : { name: mount.name }),
                readOnly: mount.readOnly,
                type: mount.type,
            })
        )
        .toSorted(
            (left, right) =>
                compareStrings(left.destination, right.destination) ||
                compareStrings(left.name ?? "", right.name ?? "") ||
                compareStrings(left.type, right.type) ||
                Number(left.readOnly) - Number(right.readOnly)
        );
}

function stats(row: DockerEngineInventoryStats): DockerContainerStats {
    const [memoryUsedBytes, memoryLimitBytes] = sizePair(row.memoryUsage);
    const [networkReceivedBytes, networkSentBytes] = sizePair(row.networkIo);
    const [blockReadBytes, blockWrittenBytes] = sizePair(row.blockIo);
    return Object.freeze({
        blockReadBytes,
        blockWrittenBytes,
        cpuPercent: percentage(row.cpuPercent, 100_000),
        memoryLimitBytes,
        memoryPercent: percentage(row.memoryPercent, 100),
        memoryUsedBytes,
        networkReceivedBytes,
        networkSentBytes,
        pids: boundedInteger(row.pids),
    });
}

function containerState(value: string): DockerContainer["state"] {
    switch (value) {
        case "created":
        case "dead":
        case "exited":
        case "paused":
        case "removing":
        case "restarting":
        case "running": {
            return value;
        }
        default: {
            return fail();
        }
    }
}

function containerHealth(value: string | null): DockerContainer["health"] {
    switch (value) {
        case null:
        case "":
        case "none": {
            return "none";
        }
        case "healthy":
        case "starting":
        case "unhealthy": {
            return value;
        }
        default: {
            return fail();
        }
    }
}

function composeIdentity(
    container: DockerEngineInventoryAvailableContainer
): DockerEngineComposeIdentity | undefined {
    const project = container.labels["com.docker.compose.project"];
    const service = container.labels["com.docker.compose.service"];
    const configFiles = container.labels["com.docker.compose.project.config_files"];
    if (project === undefined && service === undefined && configFiles === undefined) {
        return undefined;
    }
    if (project === undefined || service === undefined || configFiles === undefined)
        fail();
    const paths = configFiles
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path !== "");
    if (paths.length === 0 || new Set(paths).size !== paths.length) fail();
    return Object.freeze({
        configFiles: Object.freeze(paths.toSorted(compareStrings)),
        project,
        service,
    });
}

/**
 * Projects only complete Compose identities from the current Engine snapshot.
 * @param snapshot Current all-or-nothing Engine snapshot.
 * @returns Canonical dynamically discovered Compose identities.
 */
export function dockerEngineComposeIdentities(
    snapshot: DockerEngineInventorySnapshot
): readonly DockerEngineComposeIdentity[] {
    if (snapshot.containers.some(({ availability }) => availability === "disappeared")) {
        fail();
    }
    const identities = new Map<string, DockerEngineComposeIdentity>();
    for (const raw of snapshot.containers) {
        if (raw.availability !== "available") continue;
        const identity = composeIdentity(raw);
        if (identity === undefined) continue;
        const key = `${identity.project}\0${identity.service}\0${JSON.stringify(identity.configFiles)}`;
        identities.set(key, identity);
    }
    return Object.freeze(
        [...identities.values()].toSorted(
            (left, right) =>
                compareStrings(left.project, right.project) ||
                compareStrings(left.service, right.service) ||
                compareStrings(
                    JSON.stringify(left.configFiles),
                    JSON.stringify(right.configFiles)
                )
        )
    );
}

function containers(snapshot: DockerEngineInventorySnapshot): DockerContainer[] {
    if (snapshot.containers.some(({ availability }) => availability === "disappeared")) {
        fail();
    }
    const statsById = new Map(snapshot.stats.map((row) => [row.id, row]));
    return snapshot.containers.map((raw): DockerContainer => {
        if (raw.availability !== "available") return fail();
        const project = raw.labels["com.docker.compose.project"];
        const service = raw.labels["com.docker.compose.service"];
        if ((project === undefined) !== (service === undefined)) fail();
        const statsRow = statsById.get(raw.id);
        // Docker retains the previous stop timestamp after a container is started
        // again. A running container therefore has no causal current finish time.
        const finishedAtMs = raw.status.running
            ? undefined
            : optionalTimestampMs(raw.finishedAt);
        const startedAtMs = optionalTimestampMs(raw.startedAt);
        return Object.freeze({
            createdAtMs: timestampMs(raw.createdAt),
            ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
            health: containerHealth(raw.health),
            id: raw.id,
            image: raw.imageReference,
            imageId: raw.imageId,
            mounts: mounts(raw),
            name: raw.name,
            networks: networks(raw),
            ports: ports(raw),
            ...(project === undefined ? {} : { project, service }),
            restartCount: boundedInteger(raw.restartCount),
            ...(startedAtMs === undefined ? {} : { startedAtMs }),
            state: containerState(raw.state),
            ...(statsRow === undefined ? {} : { stats: stats(statsRow) }),
        });
    });
}

interface MutableImage {
    createdAtMs: number;
    readonly id: string;
    readonly references: Set<string>;
    sizeBytes: number;
    readonly usedByContainerIds: Set<string>;
}

function images(
    snapshot: DockerEngineInventorySnapshot,
    projectedContainers: readonly DockerContainer[]
): readonly DockerImage[] {
    const byId = new Map<string, MutableImage>();
    for (const raw of snapshot.images) {
        const createdAtMs = timestampMs(raw.createdAt);
        const bytes = sizeBytes(raw.size);
        const current = byId.get(raw.id) ?? {
            createdAtMs,
            id: raw.id,
            references: new Set<string>(),
            sizeBytes: bytes,
            usedByContainerIds: new Set<string>(),
        };
        if (current.createdAtMs !== createdAtMs || current.sizeBytes !== bytes) fail();
        if (raw.repository !== "<none>" && raw.tag !== "<none>") {
            current.references.add(`${raw.repository}:${raw.tag}`);
        }
        byId.set(raw.id, current);
    }
    for (const container of projectedContainers) {
        const image = byId.get(container.imageId);
        if (image === undefined) fail();
        image.usedByContainerIds.add(container.id);
        if (!container.image.includes("@sha256:") && container.image !== "") {
            image.references.add(container.image);
        }
    }
    return Object.freeze(
        [...byId.values()]
            .map((image): DockerImage =>
                Object.freeze({
                    createdAtMs: image.createdAtMs,
                    id: image.id,
                    references: [...image.references].toSorted(compareStrings),
                    sizeBytes: image.sizeBytes,
                    usedByContainerIds: [...image.usedByContainerIds].toSorted(
                        compareStrings
                    ),
                })
            )
            .toSorted((left, right) => compareStrings(left.id, right.id))
    );
}

function volumes(
    snapshot: DockerEngineInventorySnapshot,
    projectedContainers: readonly DockerContainer[]
): readonly DockerVolume[] {
    const availableById = new Map(
        snapshot.containers.flatMap((container) =>
            container.availability === "available" ? [[container.id, container]] : []
        )
    );
    return Object.freeze(
        snapshot.volumes
            .map((volume): DockerVolume => {
                const usedByContainerIds = projectedContainers
                    .filter((container) =>
                        availableById
                            .get(container.id)
                            ?.mounts.some((mount) => mount.name === volume.name)
                    )
                    .map(({ id }) => id)
                    .toSorted(compareStrings);
                if (volume.scope !== "global" && volume.scope !== "local") fail();
                return Object.freeze({
                    driver: volume.driver,
                    name: volume.name,
                    scope: volume.scope,
                    usedByContainerIds,
                });
            })
            .toSorted((left, right) => compareStrings(left.name, right.name))
    );
}

function serviceId(service: DockerComposeDiscoveredService): string {
    return new Bun.CryptoHasher("sha256")
        .update(`${service.project}\0${service.service}`)
        .digest("hex");
}

function updaterPolicy(service: DockerComposeDiscoveredService): DockerUpdaterPolicy {
    if (service.sourceAmbiguous === true) {
        return Object.freeze({
            reason: "ambiguous-source",
            state: "inventory-only",
        });
    }
    if (service.enabled) {
        return Object.freeze({
            automatic: service.autoUpdate,
            state: "managed",
            track: service.pinMode,
        });
    }
    const requested = service.labels["mira.updater.enabled"];
    let reason: "disabled" | "invalid-policy" | "missing-opt-in";
    if (requested === undefined) {
        reason = "missing-opt-in";
    } else if (requested === "false") {
        reason = "disabled";
    } else {
        reason = "invalid-policy";
    }
    return Object.freeze({
        reason,
        state: "inventory-only",
    });
}

function updaterPoliciesMatch(
    left: DockerUpdaterPolicy,
    right: DockerUpdaterPolicy
): boolean {
    if (left.state !== right.state) return false;
    if (left.state === "inventory-only") {
        return right.state === "inventory-only" && left.reason === right.reason;
    }
    return (
        right.state === "managed" &&
        left.automatic === right.automatic &&
        left.track === right.track
    );
}

function updaterServices(
    compose: DockerComposeDiscoveryResult,
    previous: DockerOverviewCachePayload | undefined,
    currentSourceRevision: string
): readonly DockerUpdaterService[] {
    const previousById = new Map(
        (previous?.updaterServices ?? []).map((service) => [service.id, service])
    );
    return Object.freeze(
        compose.services
            .map((service): DockerUpdaterService => {
                const id = serviceId(service);
                const prior = previousById.get(id);
                const policy = updaterPolicy(service);
                return Object.freeze({
                    currentImage: service.imageReference,
                    id,
                    policy,
                    project: service.project,
                    service: service.service,
                    status:
                        previous?.sourceRevision === currentSourceRevision &&
                        prior?.currentImage === service.imageReference &&
                        updaterPoliciesMatch(prior.policy, policy)
                            ? prior.status
                            : Object.freeze({ state: "unavailable" }),
                });
            })
            .toSorted((left, right) => compareStrings(left.id, right.id))
    );
}

function updaterEvents(
    previous: DockerOverviewCachePayload | undefined
): readonly DockerUpdaterEvent[] {
    return Object.freeze([...(previous?.updaterEvents ?? [])]);
}

function sourceRevision(
    engine: DockerEngineInventorySnapshot,
    compose: DockerComposeDiscoveryResult
): string {
    return new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify({
                compose: compose.sourceRevision,
                engine: engine.sourceRevision,
            })
        )
        .digest("hex");
}

/**
 * Converts one all-or-nothing Engine/Compose discovery into the strict public cache payload.
 * Previous updater state is retained only for an unchanged dynamically discovered service.
 * @param input Current Engine/Compose state, observation clock, and optional prior payload.
 * @returns Strict bounded cache payload without raw Docker or Compose authority.
 */
export function projectDockerOverview(input: {
    readonly compose: DockerComposeDiscoveryResult;
    readonly engine: DockerEngineInventorySnapshot;
    readonly observedAtMs: number;
    readonly previous?: DockerOverviewCachePayload;
}): DockerOverviewCachePayload {
    boundedInteger(input.observedAtMs);
    const projectedContainers = containers(input.engine);
    const currentSourceRevision = sourceRevision(input.engine, input.compose);
    return v.parse(dockerOverviewCachePayloadSchema, {
        containers: projectedContainers,
        images: images(input.engine, projectedContainers),
        observedAtMs: input.observedAtMs,
        sourceRevision: currentSourceRevision,
        updaterEvents: updaterEvents(input.previous),
        updaterServices: updaterServices(
            input.compose,
            input.previous,
            currentSourceRevision
        ),
        volumes: volumes(input.engine, projectedContainers),
    });
}
