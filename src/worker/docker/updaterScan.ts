import * as v from "valibot";

import {
    dockerOverviewCachePayloadSchema,
    dockerUpdaterEventMaximum,
    type DockerOverviewCachePayload,
    type DockerUpdaterEvent,
    type DockerUpdaterService,
    type DockerUpdaterStatus,
} from "../../contracts/docker.ts";
import type { DockerComposeDiscoveryResult } from "./composeDiscovery.ts";
import {
    lookupDockerRegistryImage,
    type DockerRegistryClientOptions,
    type DockerRegistryLookup,
} from "./registryClient.ts";
import type { DockerImageReference, DockerTagPolicy } from "./tagPolicy.ts";

export interface DockerUpdaterRegistryLookupInput {
    readonly image: DockerImageReference;
    readonly platform: string;
    readonly policy: DockerTagPolicy;
    readonly signal?: AbortSignal;
}

export type DockerUpdaterRegistryLookup = (
    input: DockerUpdaterRegistryLookupInput
) => Promise<DockerRegistryLookup>;

export interface DockerUpdaterScanOptions {
    readonly generateId?: () => string;
    readonly lookup?: DockerUpdaterRegistryLookup;
    readonly lookupConcurrency?: number;
    readonly nowMs?: () => number;
    readonly platform?: string;
    readonly registry?: Omit<DockerRegistryClientOptions, "signal">;
}

const lookupConcurrencyMaximum = 8;

function fail(): never {
    throw new Error("Docker updater scan failed");
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function currentPlatform(): string {
    if (process.arch === "x64") return "linux/amd64";
    if (process.arch === "arm64") return "linux/arm64/v8";
    return fail();
}

function candidateReference(
    image: DockerImageReference,
    pinMode: "digest" | "tag",
    candidate: DockerRegistryLookup
): string {
    const tagged = `${image.name}:${candidate.tag}`;
    return pinMode === "digest" ? `${tagged}@${candidate.digest}` : tagged;
}

function updateIsAvailable(
    image: DockerImageReference,
    pinMode: "digest" | "tag",
    candidate: DockerRegistryLookup
): boolean {
    return pinMode === "digest"
        ? image.digest !== candidate.digest
        : image.tag !== candidate.tag;
}

function hasEligibleRuntime(
    payload: DockerOverviewCachePayload,
    project: string,
    service: string
): boolean {
    const containers = payload.containers.filter(
        (container) => container.project === project && container.service === service
    );
    if (containers.length === 0) return false;
    const imageIds = new Set(containers.map(({ imageId }) => imageId));
    return (
        imageIds.size === 1 &&
        containers.every(
            ({ health, state }) =>
                state === "running" && health !== "starting" && health !== "unhealthy"
        )
    );
}

function eventOrder(left: DockerUpdaterEvent, right: DockerUpdaterEvent): number {
    return right.atMs - left.atMs || compareStrings(left.id, right.id);
}

function appendEvents(
    current: readonly DockerUpdaterEvent[],
    added: readonly DockerUpdaterEvent[]
): DockerUpdaterEvent[] {
    return [...current, ...added]
        .toSorted(eventOrder)
        .slice(0, dockerUpdaterEventMaximum);
}

interface ServiceScan {
    readonly service: DockerUpdaterService;
    readonly status?: DockerUpdaterStatus;
    readonly unavailable: boolean;
}

async function mapConcurrent<TInput, TOutput>(
    values: readonly TInput[],
    concurrency: number,
    map: (value: TInput) => Promise<TOutput>
): Promise<readonly TOutput[]> {
    const results = new Map<number, TOutput>();
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < values.length) {
            const index = next;
            next += 1;
            results.set(index, await map(values[index]!));
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, worker)
    );
    if (results.size !== values.length) fail();
    return values.map((_value, index) => {
        const result = results.get(index);
        return result === undefined ? fail() : result;
    });
}

/**
 * Scans only dynamically discovered, explicitly opted-in Compose services.
 * Registry failures are isolated per service and revoke candidate authority.
 * @param compose Current trusted Compose discovery paired to the payload.
 * @param payload Current strict Docker overview payload.
 * @param signal Optional parent cancellation signal.
 * @param options Bounded registry, clock, identity, platform, and concurrency options.
 * @returns Updated payload and newly emitted transition events.
 */
export async function scanDockerUpdates(
    compose: DockerComposeDiscoveryResult,
    payload: DockerOverviewCachePayload,
    signal?: AbortSignal,
    options: DockerUpdaterScanOptions = {}
): Promise<{
    readonly events: readonly DockerUpdaterEvent[];
    readonly payload: DockerOverviewCachePayload;
}> {
    signal?.throwIfAborted();
    const concurrency = options.lookupConcurrency ?? 4;
    if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > lookupConcurrencyMaximum
    ) {
        fail();
    }
    const platform = options.platform ?? currentPlatform();
    const nowMs = options.nowMs ?? Date.now;
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const lookup =
        options.lookup ??
        ((input: DockerUpdaterRegistryLookupInput) =>
            lookupDockerRegistryImage(input.image, input.policy, input.platform, {
                ...options.registry,
                signal: input.signal,
            }));
    const publicByIdentity = new Map(
        payload.updaterServices.map((service) => [
            `${service.project}\0${service.service}`,
            service,
        ])
    );
    if (publicByIdentity.size !== payload.updaterServices.length) fail();
    const scans = await mapConcurrent<(typeof compose.services)[number], ServiceScan>(
        compose.services,
        concurrency,
        async (source) => {
            signal?.throwIfAborted();
            const service = publicByIdentity.get(`${source.project}\0${source.service}`);
            if (service === undefined) fail();
            if (
                !source.enabled ||
                source.image === undefined ||
                source.tagPolicy === undefined
            ) {
                return Object.freeze({ service, unavailable: false });
            }
            if (!hasEligibleRuntime(payload, source.project, source.service)) {
                return Object.freeze({
                    service,
                    status: { state: "not-checked" as const },
                    unavailable: false,
                });
            }
            try {
                const candidate = await lookup({
                    image: source.image,
                    platform,
                    policy: source.tagPolicy,
                    ...(signal === undefined ? {} : { signal }),
                });
                signal?.throwIfAborted();
                const status: DockerUpdaterStatus = updateIsAvailable(
                    source.image,
                    source.pinMode,
                    candidate
                )
                    ? {
                          candidateImage: candidateReference(
                              source.image,
                              source.pinMode,
                              candidate
                          ),
                          state: "update-available",
                      }
                    : { state: "current" };
                return Object.freeze({ service, status, unavailable: false });
            } catch (error) {
                if (signal?.aborted === true) throw error;
                return Object.freeze({ service, unavailable: true });
            }
        }
    );
    if (scans.length !== compose.services.length) fail();

    const scannedById = new Map(scans.map((scan) => [scan.service.id, scan]));
    const services = payload.updaterServices.map((service): DockerUpdaterService => {
        const scan = scannedById.get(service.id);
        if (scan === undefined) return service;
        if (scan.unavailable) return { ...service, status: { state: "unavailable" } };
        if (scan.status === undefined) return service;
        return { ...service, status: scan.status };
    });
    const availableCount = services.filter(
        ({ status }) => status.state === "update-available"
    ).length;
    const unavailableCount = scans.filter(({ unavailable }) => unavailable).length;
    const atMs = nowMs();
    if (!Number.isSafeInteger(atMs) || atMs < 0) fail();
    const events: DockerUpdaterEvent[] = [];
    for (const service of services) {
        if (service.status.state !== "update-available") continue;
        const previous = payload.updaterServices.find(({ id }) => id === service.id);
        const previousStatus = previous?.status;
        if (
            previousStatus?.state === "update-available" &&
            previousStatus.candidateImage === service.status.candidateImage
        ) {
            continue;
        }
        events.push({
            atMs,
            id: generateId(),
            kind: "update-available",
            serviceId: service.id,
            summary: `An update is available for ${service.project}/${service.service}.`,
        });
    }
    events.push({
        atMs,
        id: generateId(),
        kind: unavailableCount === 0 ? "scan-completed" : "scan-failed",
        summary:
            unavailableCount === 0
                ? `Scanned ${scans.length} managed or inventory-only services; ${availableCount} updates are available.`
                : `Registry lookup was unavailable for ${unavailableCount} of ${scans.length} services; stale candidates cannot authorize updates.`,
    });

    const updated = v.parse(dockerOverviewCachePayloadSchema, {
        ...payload,
        updaterEvents: appendEvents(payload.updaterEvents, events),
        updaterServices: services,
    });
    return Object.freeze({ events: Object.freeze(events), payload: updated });
}
