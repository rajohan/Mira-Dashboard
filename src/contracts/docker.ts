import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    lowercaseSha256Schema,
    lowercaseUuidV7Schema,
    noNulStringAction,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { jobIdempotencyKeySchema, jobRunIdSchema } from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";
import { emptyInputSchema } from "./system.ts";

/** Durable cache identity reserved for the worker-owned Docker snapshot. */
export const dockerOverviewCacheKey = "docker.overview";
/** Current Docker cache-payload identity. */
export const dockerOverviewCacheSchemaId = "docker.overview.v1";
/** Source identity for bounded Engine and Compose discovery. */
export const dockerOverviewCacheSource = "docker-engine.compose";

export const dockerContainerMaximum = 256;
export const dockerContainerMountMaximum = 128;
export const dockerContainerNetworkMaximum = 32;
export const dockerContainerNetworkAddressMaximum = 2;
export const dockerImageMaximum = 512;
export const dockerVolumeMaximum = 256;
export const dockerUpdaterServiceMaximum = 256;
export const dockerUpdaterEventMaximum = 100;
export const dockerContainerLogTailDefault = 200;
export const dockerContainerLogTailMaximum = 500;
export const dockerContainerLogLineMaximumCharacters = 4096;
export const dockerContainerLogsMaximumBytes = 256 * 1024;
/** Never exceeds the generic cache row's 256 KiB payload budget. */
export const dockerOverviewCachePayloadMaximumBytes = 256 * 1024;
export const dockerPrunePreviewTicketTtlMs = 5 * 60 * 1000;

const dockerTimestampSchema = timestampMillisecondsSchema("Docker timestamp is invalid");
const dockerCountSchema = nonnegativeSafeIntegerSchema("Docker count is invalid");
const dockerByteCountSchema = nonnegativeSafeIntegerSchema(
    "Docker byte count is invalid"
);
const dockerPortSchema = v.pipe(
    positiveSafeIntegerSchema("Docker port is invalid"),
    v.maxValue(65_535, "Docker port is invalid")
);
const dockerPercentSchema = v.pipe(
    v.number("Docker percentage is invalid"),
    v.finite("Docker percentage is invalid"),
    v.minValue(0, "Docker percentage is invalid"),
    v.maxValue(100_000, "Docker percentage is invalid")
);
const dockerRatioPercentSchema = v.pipe(
    v.number("Docker percentage is invalid"),
    v.finite("Docker percentage is invalid"),
    v.minValue(0, "Docker percentage is invalid"),
    v.maxValue(100, "Docker percentage is invalid")
);

/** Exact immutable Docker object digest, including its algorithm prefix. */
export const dockerObjectIdSchema = v.pipe(
    v.string("Docker object id is invalid"),
    v.regex(/^sha256:[0-9a-f]{64}$/u, "Docker object id is invalid")
);

/** Exact full Engine container ID; short or name-based selectors are forbidden. */
export const dockerContainerIdSchema = v.pipe(
    v.string("Docker container id is invalid"),
    v.regex(/^[0-9a-f]{64}$/u, "Docker container id is invalid")
);

/** Strong revision of one complete discovered Engine/Compose source state. */
export const dockerSourceRevisionSchema = lowercaseSha256Schema(
    "Docker source revision is invalid"
);

/** Opaque stable updater identity; it does not expose a Compose path. */
export const dockerUpdaterServiceIdSchema = lowercaseSha256Schema(
    "Docker updater service id is invalid"
);

export const dockerVolumeNameSchema = v.pipe(
    v.string("Docker volume name is invalid"),
    v.minLength(1, "Docker volume name is invalid"),
    v.maxLength(255, "Docker volume name is invalid"),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u, "Docker volume name is invalid")
);

const dockerDisplayNameSchema = boundedControlSafeTextSchema(
    255,
    "Docker display name is invalid"
);
export const dockerImageReferenceSchema = boundedControlSafeTextSchema(
    512,
    "Docker image reference is invalid"
);
const dockerProjectNameSchema = boundedControlSafeTextSchema(
    255,
    "Docker project name is invalid"
);
const dockerServiceNameSchema = boundedControlSafeTextSchema(
    255,
    "Docker service name is invalid"
);

export const dockerContainerPortSchema = v.strictObject({
    containerPort: dockerPortSchema,
    hostPort: v.optional(dockerPortSchema),
    hostScope: v.optional(
        v.picklist(
            ["all-interfaces", "loopback", "other"],
            "Docker port scope is invalid"
        )
    ),
    protocol: v.picklist(["sctp", "tcp", "udp"], "Docker port protocol is invalid"),
});

function compareContainerPorts(
    left: v.InferOutput<typeof dockerContainerPortSchema>,
    right: v.InferOutput<typeof dockerContainerPortSchema>
): number {
    return (
        left.containerPort - right.containerPort ||
        compareStrings(left.protocol, right.protocol) ||
        (left.hostPort ?? 0) - (right.hostPort ?? 0) ||
        compareStrings(left.hostScope ?? "", right.hostScope ?? "")
    );
}

/**
 * @param ports Projected container ports.
 * @returns Whether projected ports have matching host fields and canonical order.
 */
export function dockerContainerPortsAreCanonical(
    ports: v.InferOutput<typeof dockerContainerPortSchema>[]
): boolean {
    return ports.every(
        (port, index) =>
            (port.hostPort === undefined) === (port.hostScope === undefined) &&
            (index === 0 || compareContainerPorts(ports[index - 1]!, port) < 0)
    );
}

const dockerContainerPortsSchema = v.pipe(
    v.array(dockerContainerPortSchema, "Docker container ports are invalid"),
    v.maxLength(128, "Docker container ports are outside their budget"),
    v.check(dockerContainerPortsAreCanonical, "Docker container ports are not canonical")
);

/**
 * @param values Projected Docker string values.
 * @returns Whether strings are unique and strictly ordered.
 */
export function dockerStringListIsCanonical(values: string[]): boolean {
    return (
        hasUniqueArrayItems(values) &&
        values.every(
            (value, index) => index === 0 || compareStrings(values[index - 1]!, value) < 0
        )
    );
}

const dockerContainerNetworkAddressSchema = v.pipe(
    boundedControlSafeTextSchema(64, "Docker container network address is invalid"),
    v.ip("Docker container network address is invalid")
);

export const dockerContainerNetworkSchema = v.strictObject({
    addresses: v.pipe(
        v.array(
            dockerContainerNetworkAddressSchema,
            "Docker container network addresses are invalid"
        ),
        v.maxLength(
            dockerContainerNetworkAddressMaximum,
            "Docker container network addresses are outside their budget"
        ),
        v.check(
            dockerStringListIsCanonical,
            "Docker container network addresses are not canonical"
        )
    ),
    name: boundedControlSafeTextSchema(255, "Docker container network name is invalid"),
});

export type DockerContainerNetwork = v.InferOutput<typeof dockerContainerNetworkSchema>;

/**
 * @param networks Projected container networks.
 * @returns Whether network rows are strictly ordered by name.
 */
export function dockerContainerNetworksAreCanonical(
    networks: DockerContainerNetwork[]
): boolean {
    return networks.every(
        (network, index) =>
            index === 0 || compareStrings(networks[index - 1]!.name, network.name) < 0
    );
}

const dockerContainerNetworksSchema = v.pipe(
    v.array(dockerContainerNetworkSchema, "Docker container networks are invalid"),
    v.maxLength(
        dockerContainerNetworkMaximum,
        "Docker container networks are outside their budget"
    ),
    v.check(
        dockerContainerNetworksAreCanonical,
        "Docker container networks are not canonical"
    )
);

/**
 * @param value Projected container-mount destination.
 * @returns Whether the destination is an absolute path.
 */
export function dockerContainerMountDestinationIsAbsolute(value: string): boolean {
    return value.startsWith("/");
}

export const dockerContainerMountSchema = v.strictObject({
    destination: v.pipe(
        boundedControlSafeTextSchema(
            4096,
            "Docker container mount destination is invalid"
        ),
        v.check(
            dockerContainerMountDestinationIsAbsolute,
            "Docker container mount destination is invalid"
        )
    ),
    name: v.optional(dockerVolumeNameSchema),
    readOnly: v.boolean("Docker container mount access is invalid"),
    type: boundedControlSafeTextSchema(64, "Docker container mount type is invalid"),
});

export type DockerContainerMount = v.InferOutput<typeof dockerContainerMountSchema>;

function compareContainerMounts(
    left: DockerContainerMount,
    right: DockerContainerMount
): number {
    return (
        compareStrings(left.destination, right.destination) ||
        compareStrings(left.name ?? "", right.name ?? "") ||
        compareStrings(left.type, right.type) ||
        Number(left.readOnly) - Number(right.readOnly)
    );
}

/**
 * @param mounts Projected container mounts.
 * @returns Whether mount rows are unique and strictly ordered.
 */
export function dockerContainerMountsAreCanonical(
    mounts: DockerContainerMount[]
): boolean {
    return mounts.every(
        (mount, index) =>
            index === 0 || compareContainerMounts(mounts[index - 1]!, mount) < 0
    );
}

const dockerContainerMountsSchema = v.pipe(
    v.array(dockerContainerMountSchema, "Docker container mounts are invalid"),
    v.maxLength(
        dockerContainerMountMaximum,
        "Docker container mounts are outside their budget"
    ),
    v.check(
        dockerContainerMountsAreCanonical,
        "Docker container mounts are not canonical"
    )
);

export const dockerContainerStatsSchema = v.strictObject({
    blockReadBytes: dockerByteCountSchema,
    blockWrittenBytes: dockerByteCountSchema,
    cpuPercent: dockerPercentSchema,
    memoryLimitBytes: dockerByteCountSchema,
    memoryPercent: dockerRatioPercentSchema,
    memoryUsedBytes: dockerByteCountSchema,
    networkReceivedBytes: dockerByteCountSchema,
    networkSentBytes: dockerByteCountSchema,
    pids: dockerCountSchema,
});

const dockerContainerObjectSchema = v.strictObject({
    createdAtMs: dockerTimestampSchema,
    finishedAtMs: v.optional(dockerTimestampSchema),
    health: v.picklist(
        ["healthy", "none", "starting", "unhealthy"],
        "Docker container health is invalid"
    ),
    id: dockerContainerIdSchema,
    image: dockerImageReferenceSchema,
    imageId: dockerObjectIdSchema,
    mounts: dockerContainerMountsSchema,
    name: dockerDisplayNameSchema,
    networks: dockerContainerNetworksSchema,
    ports: dockerContainerPortsSchema,
    project: v.optional(dockerProjectNameSchema),
    restartCount: dockerCountSchema,
    service: v.optional(dockerServiceNameSchema),
    startedAtMs: v.optional(dockerTimestampSchema),
    state: v.picklist(
        ["created", "dead", "exited", "paused", "removing", "restarting", "running"],
        "Docker container state is invalid"
    ),
    stats: v.optional(dockerContainerStatsSchema),
});

export type DockerContainer = v.InferOutput<typeof dockerContainerObjectSchema>;

/** @returns Whether one container projection has causal lifecycle and Compose identity. */
export function dockerContainerIsConsistent(container: DockerContainer): boolean {
    const composeIdentityIsComplete =
        (container.project === undefined) === (container.service === undefined);
    const lifecycleIsCausal =
        (container.startedAtMs === undefined ||
            container.startedAtMs >= container.createdAtMs) &&
        (container.finishedAtMs === undefined ||
            container.finishedAtMs >= (container.startedAtMs ?? container.createdAtMs));
    const statsArePlausible =
        container.stats === undefined ||
        container.stats.memoryLimitBytes === 0 ||
        container.stats.memoryUsedBytes <= container.stats.memoryLimitBytes;
    return composeIdentityIsComplete && lifecycleIsCausal && statsArePlausible;
}

export const dockerContainerSchema = v.pipe(
    dockerContainerObjectSchema,
    v.check(dockerContainerIsConsistent, "Docker container projection is inconsistent")
);

const dockerImageReferencesSchema = v.pipe(
    v.array(dockerImageReferenceSchema, "Docker image references are invalid"),
    v.maxLength(64, "Docker image references are outside their budget"),
    v.check(dockerStringListIsCanonical, "Docker image references are not canonical")
);

export const dockerImageSchema = v.strictObject({
    createdAtMs: dockerTimestampSchema,
    id: dockerObjectIdSchema,
    references: dockerImageReferencesSchema,
    sizeBytes: dockerByteCountSchema,
    usedByContainerIds: v.pipe(
        v.array(dockerContainerIdSchema, "Docker image users are invalid"),
        v.maxLength(
            dockerContainerMaximum,
            "Docker image users are outside their budget"
        ),
        v.check(dockerStringListIsCanonical, "Docker image users are not canonical")
    ),
});

export const dockerVolumeSchema = v.strictObject({
    createdAtMs: v.optional(dockerTimestampSchema),
    driver: boundedControlSafeTextSchema(128, "Docker volume driver is invalid"),
    name: dockerVolumeNameSchema,
    scope: v.picklist(["global", "local"], "Docker volume scope is invalid"),
    sizeBytes: v.optional(dockerByteCountSchema),
    usedByContainerIds: v.pipe(
        v.array(dockerContainerIdSchema, "Docker volume users are invalid"),
        v.maxLength(
            dockerContainerMaximum,
            "Docker volume users are outside their budget"
        ),
        v.check(dockerStringListIsCanonical, "Docker volume users are not canonical")
    ),
});

export const dockerUpdaterPolicySchema = v.variant("state", [
    v.strictObject({
        automatic: v.boolean("Docker updater automatic policy is invalid"),
        state: v.literal("managed"),
        track: v.picklist(["digest", "tag"], "Docker updater tracking policy is invalid"),
    }),
    v.strictObject({
        reason: v.picklist(
            ["ambiguous-source", "disabled", "invalid-policy", "missing-opt-in"],
            "Docker updater inventory-only reason is invalid"
        ),
        state: v.literal("inventory-only"),
    }),
]);

export const dockerUpdaterStatusSchema = v.variant("state", [
    v.strictObject({ state: v.literal("not-checked") }),
    v.strictObject({ state: v.literal("current") }),
    v.strictObject({
        candidateImage: dockerImageReferenceSchema,
        state: v.literal("update-available"),
    }),
    v.strictObject({ state: v.literal("unavailable") }),
]);

export const dockerUpdaterServiceSchema = v.strictObject({
    currentImage: dockerImageReferenceSchema,
    id: dockerUpdaterServiceIdSchema,
    policy: dockerUpdaterPolicySchema,
    project: dockerProjectNameSchema,
    service: dockerServiceNameSchema,
    status: dockerUpdaterStatusSchema,
});

export const dockerUpdaterEventKinds = [
    "discovery-failed",
    "scan-completed",
    "scan-failed",
    "source-sync-pending",
    "update-available",
    "update-failed",
    "update-outcome-unknown",
    "update-succeeded",
] as const;

export const dockerUpdaterEventSchema = v.strictObject({
    atMs: dockerTimestampSchema,
    id: lowercaseUuidV7Schema("Docker updater event id is invalid"),
    jobRunId: v.optional(jobRunIdSchema),
    kind: v.picklist(dockerUpdaterEventKinds, "Docker updater event kind is invalid"),
    serviceId: v.optional(dockerUpdaterServiceIdSchema),
    summary: boundedControlSafeTextSchema(500, "Docker updater event summary is invalid"),
});

function canonicalArrayBy<TValue>(
    values: TValue[],
    identity: (value: TValue) => string
): boolean {
    const ids = values.map((value) => identity(value));
    return (
        hasUniqueArrayItems(ids) &&
        ids.every((id, index) => index === 0 || compareStrings(ids[index - 1]!, id) < 0)
    );
}

/**
 * @param values Projected Docker rows with stable IDs.
 * @returns Whether ID-bearing rows are unique and strictly ordered by ID.
 */
export function dockerObjectsByIdAreCanonical<TValue extends { id: string }>(
    values: TValue[]
): boolean {
    return canonicalArrayBy(values, ({ id }) => id);
}

/**
 * @param values Projected Docker rows with stable names.
 * @returns Whether name-bearing rows are unique and strictly ordered by name.
 */
export function dockerObjectsByNameAreCanonical<TValue extends { name: string }>(
    values: TValue[]
): boolean {
    return canonicalArrayBy(values, ({ name }) => name);
}

/**
 * @param events Projected updater events.
 * @returns Whether updater events are unique and canonically newest-first.
 */
export function dockerUpdaterEventsAreCanonical(
    events: v.InferOutput<typeof dockerUpdaterEventSchema>[]
): boolean {
    return (
        hasUniqueArrayItems(events.map(({ id }) => id)) &&
        events.every((event, index) => {
            if (index === 0) return true;
            const previous = events[index - 1]!;
            return (
                previous.atMs > event.atMs ||
                (previous.atMs === event.atMs &&
                    compareStrings(previous.id, event.id) < 0)
            );
        })
    );
}

const dockerContainersSchema = v.pipe(
    v.array(dockerContainerSchema, "Docker containers are invalid"),
    v.maxLength(
        dockerContainerMaximum,
        "Docker container inventory is outside its budget"
    ),
    v.check(dockerObjectsByIdAreCanonical, "Docker container inventory is not canonical")
);
const dockerImagesSchema = v.pipe(
    v.array(dockerImageSchema, "Docker images are invalid"),
    v.maxLength(dockerImageMaximum, "Docker image inventory is outside its budget"),
    v.check(dockerObjectsByIdAreCanonical, "Docker image inventory is not canonical")
);
const dockerVolumesSchema = v.pipe(
    v.array(dockerVolumeSchema, "Docker volumes are invalid"),
    v.maxLength(dockerVolumeMaximum, "Docker volume inventory is outside its budget"),
    v.check(dockerObjectsByNameAreCanonical, "Docker volume inventory is not canonical")
);
const dockerUpdaterServicesSchema = v.pipe(
    v.array(dockerUpdaterServiceSchema, "Docker updater services are invalid"),
    v.maxLength(
        dockerUpdaterServiceMaximum,
        "Docker updater service inventory is outside its budget"
    ),
    v.check(
        dockerObjectsByIdAreCanonical,
        "Docker updater service inventory is not canonical"
    )
);
const dockerUpdaterEventsSchema = v.pipe(
    v.array(dockerUpdaterEventSchema, "Docker updater events are invalid"),
    v.maxLength(
        dockerUpdaterEventMaximum,
        "Docker updater events are outside their budget"
    ),
    v.check(dockerUpdaterEventsAreCanonical, "Docker updater events are not canonical")
);

const dockerOverviewCachePayloadObjectSchema = v.strictObject({
    containers: dockerContainersSchema,
    images: dockerImagesSchema,
    observedAtMs: dockerTimestampSchema,
    sourceRevision: dockerSourceRevisionSchema,
    updaterSourceRevision: v.optional(dockerSourceRevisionSchema),
    updaterEvents: dockerUpdaterEventsSchema,
    updaterServices: dockerUpdaterServicesSchema,
    volumes: dockerVolumesSchema,
});

export type DockerOverviewCachePayload = v.InferOutput<
    typeof dockerOverviewCachePayloadObjectSchema
>;

/** @returns Whether all cross-resource references target this complete snapshot. */
export function dockerOverviewCachePayloadIsConsistent(
    payload: DockerOverviewCachePayload
): boolean {
    const containerIds = new Set(payload.containers.map(({ id }) => id));
    const imageIds = new Set(payload.images.map(({ id }) => id));
    return (
        payload.containers.every(({ imageId }) => imageIds.has(imageId)) &&
        payload.images.every(({ usedByContainerIds }) =>
            usedByContainerIds.every((id) => containerIds.has(id))
        ) &&
        payload.volumes.every(({ usedByContainerIds }) =>
            usedByContainerIds.every((id) => containerIds.has(id))
        ) &&
        utf8ByteLength(
            JSON.stringify({
                containers: payload.containers,
                images: payload.images,
                observedAtMs: payload.observedAtMs,
                sourceRevision: payload.sourceRevision,
                updaterSourceRevision: payload.updaterSourceRevision,
                updaterEvents: payload.updaterEvents,
                updaterServices: payload.updaterServices,
                volumes: payload.volumes,
            })
        ) <= dockerOverviewCachePayloadMaximumBytes
    );
}

/** Strict provider payload retained independently from public freshness metadata. */
export const dockerOverviewCachePayloadSchema = v.pipe(
    dockerOverviewCachePayloadObjectSchema,
    v.check(
        dockerOverviewCachePayloadIsConsistent,
        "Docker overview cache payload is inconsistent or outside its budget"
    )
);

const dockerOverviewPayloadEntries = dockerOverviewCachePayloadObjectSchema.entries;
const dockerOverviewVariantSchema = v.variant("state", [
    v.strictObject({
        checkedAtMs: dockerTimestampSchema,
        state: v.literal("unavailable"),
    }),
    v.strictObject({
        ...dockerOverviewPayloadEntries,
        checkedAtMs: dockerTimestampSchema,
        state: v.literal("fresh"),
    }),
    v.strictObject({
        ...dockerOverviewPayloadEntries,
        checkedAtMs: dockerTimestampSchema,
        staleSinceMs: dockerTimestampSchema,
        state: v.literal("last-known-good"),
    }),
]);

export type DockerOverview = v.InferOutput<typeof dockerOverviewVariantSchema>;

/** @returns Whether public freshness clocks and the embedded payload are causal. */
export function dockerOverviewIsConsistent(overview: DockerOverview): boolean {
    return (
        overview.state === "unavailable" ||
        (overview.observedAtMs <= overview.checkedAtMs &&
            dockerOverviewCachePayloadIsConsistent(overview) &&
            (overview.state === "fresh" ||
                (overview.staleSinceMs >= overview.observedAtMs &&
                    overview.staleSinceMs <= overview.checkedAtMs)))
    );
}

/** Complete bounded Docker projection with explicit fresh, retained, or unavailable state. */
export const dockerOverviewSchema = v.pipe(
    dockerOverviewVariantSchema,
    v.check(dockerOverviewIsConsistent, "Docker overview freshness is inconsistent")
);

/** Optional empty input for the read-only Docker overview query. */
export const dockerOverviewInputSchema = emptyInputSchema;

export const dockerGetContainerLogsInputSchema = v.strictObject({
    containerId: dockerContainerIdSchema,
    sourceRevision: dockerSourceRevisionSchema,
    tail: v.optional(
        v.pipe(
            positiveSafeIntegerSchema("Docker log tail is invalid"),
            v.maxValue(
                dockerContainerLogTailMaximum,
                "Docker log tail is outside its budget"
            )
        ),
        dockerContainerLogTailDefault
    ),
});

const dockerContainerLogLineSchema = v.pipe(
    v.string("Docker log line is invalid"),
    v.maxLength(
        dockerContainerLogLineMaximumCharacters,
        "Docker log line is outside its budget"
    ),
    noNulStringAction("Docker log line is invalid")
);

const dockerGetContainerLogsResultObjectSchema = v.strictObject({
    containerId: dockerContainerIdSchema,
    lines: v.pipe(
        v.array(dockerContainerLogLineSchema, "Docker log lines are invalid"),
        v.maxLength(
            dockerContainerLogTailMaximum,
            "Docker log lines are outside their budget"
        )
    ),
    observedAtMs: dockerTimestampSchema,
    redacted: v.literal(true, "Docker log redaction state is invalid"),
    sourceRevision: dockerSourceRevisionSchema,
    truncated: v.boolean("Docker log truncation state is invalid"),
});

/**
 * @param result Sanitized Docker log projection.
 * @returns Whether the serialized sanitized log projection fits its byte budget.
 */
export function dockerGetContainerLogsResultFitsBudget(
    result: v.InferOutput<typeof dockerGetContainerLogsResultObjectSchema>
): boolean {
    return utf8ByteLength(JSON.stringify(result)) <= dockerContainerLogsMaximumBytes;
}

/** Sanitized bounded log output; raw process output is never a public field. */
export const dockerGetContainerLogsResultSchema = v.pipe(
    dockerGetContainerLogsResultObjectSchema,
    v.check(
        dockerGetContainerLogsResultFitsBudget,
        "Docker log result is outside its byte budget"
    )
);

export const dockerPruneTargets = ["images", "volumes"] as const;
export const dockerPruneTargetSchema = v.picklist(
    dockerPruneTargets,
    "Docker prune target is invalid"
);

export const dockerPreparePruneInputSchema = v.strictObject({
    sourceRevision: dockerSourceRevisionSchema,
    target: dockerPruneTargetSchema,
});

const dockerPruneTicketBase = {
    expiresAtMs: dockerTimestampSchema,
    issuedAtMs: dockerTimestampSchema,
    sourceRevision: dockerSourceRevisionSchema,
    ticketId: lowercaseUuidV7Schema("Docker prune ticket id is invalid"),
};

const dockerImagePrunePreviewItemSchema = v.strictObject({
    id: dockerObjectIdSchema,
    references: dockerImageReferencesSchema,
    sizeBytes: dockerByteCountSchema,
});
const dockerVolumePrunePreviewItemSchema = v.strictObject({
    name: dockerVolumeNameSchema,
    sizeBytes: v.optional(dockerByteCountSchema),
});

const dockerImagePrunePreviewItemsSchema = v.pipe(
    v.array(dockerImagePrunePreviewItemSchema, "Docker image prune preview is invalid"),
    v.maxLength(dockerImageMaximum, "Docker image prune preview is outside its budget"),
    v.check(dockerObjectsByIdAreCanonical, "Docker image prune preview is not canonical")
);
const dockerVolumePrunePreviewItemsSchema = v.pipe(
    v.array(dockerVolumePrunePreviewItemSchema, "Docker volume prune preview is invalid"),
    v.maxLength(dockerVolumeMaximum, "Docker volume prune preview is outside its budget"),
    v.check(
        dockerObjectsByNameAreCanonical,
        "Docker volume prune preview is not canonical"
    )
);

/** Worker-to-web prune projection before an actor-bound one-time ticket is minted. */
export const dockerPrunePreviewResultSchema = v.variant("target", [
    v.strictObject({
        estimatedReclaimableBytes: dockerByteCountSchema,
        items: dockerImagePrunePreviewItemsSchema,
        sourceRevision: dockerSourceRevisionSchema,
        target: v.literal("images"),
    }),
    v.strictObject({
        estimatedReclaimableBytes: dockerByteCountSchema,
        items: dockerVolumePrunePreviewItemsSchema,
        sourceRevision: dockerSourceRevisionSchema,
        target: v.literal("volumes"),
    }),
]);

const dockerPreparePruneResultVariantSchema = v.variant("target", [
    v.strictObject({
        ...dockerPruneTicketBase,
        estimatedReclaimableBytes: dockerByteCountSchema,
        items: dockerImagePrunePreviewItemsSchema,
        target: v.literal("images"),
    }),
    v.strictObject({
        ...dockerPruneTicketBase,
        estimatedReclaimableBytes: dockerByteCountSchema,
        items: dockerVolumePrunePreviewItemsSchema,
        target: v.literal("volumes"),
    }),
]);

export type DockerPreparePruneResult = v.InferOutput<
    typeof dockerPreparePruneResultVariantSchema
>;
export type DockerPrunePreviewResult = v.InferOutput<
    typeof dockerPrunePreviewResultSchema
>;

/** @returns Whether one actor-bound prune ticket has a short causal lifetime. */
export function dockerPrunePreviewTicketIsConsistent(
    ticket: DockerPreparePruneResult
): boolean {
    return (
        ticket.expiresAtMs > ticket.issuedAtMs &&
        ticket.expiresAtMs - ticket.issuedAtMs <= dockerPrunePreviewTicketTtlMs
    );
}

export const dockerPreparePruneResultSchema = v.pipe(
    dockerPreparePruneResultVariantSchema,
    v.check(
        dockerPrunePreviewTicketIsConsistent,
        "Docker prune preview ticket lifetime is invalid"
    )
);

export const dockerOperationIds = [
    "container-restart",
    "container-start",
    "container-stop",
    "image-delete",
    "prune-execute",
    "stack-restart",
    "stack-start",
    "stack-stop",
    "updater-run",
    "updater-scan",
    "updater-update-service",
    "volume-delete",
] as const;
export const dockerOperationIdSchema = v.picklist(
    dockerOperationIds,
    "Docker operation id is invalid"
);

const dockerOperationBase = {
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: dockerSourceRevisionSchema,
};

const dockerContainerOperationOptions = [
    ["container-restart", "restart-docker-container"],
    ["container-start", "start-docker-container"],
    ["container-stop", "stop-docker-container"],
] as const;
const dockerStackOperationOptions = [
    ["stack-restart", "restart-docker-stack"],
    ["stack-start", "start-docker-stack"],
    ["stack-stop", "stop-docker-stack"],
] as const;

const dockerContainerOperationSchemas = dockerContainerOperationOptions.map(
    ([operation, confirmation]) =>
        v.strictObject({
            confirmation: v.literal(confirmation, "Docker confirmation is invalid"),
            containerId: dockerContainerIdSchema,
            operation: v.literal(operation),
            ...dockerOperationBase,
        })
);
const dockerStackOperationSchemas = dockerStackOperationOptions.map(
    ([operation, confirmation]) =>
        v.strictObject({
            confirmation: v.literal(confirmation, "Docker confirmation is invalid"),
            operation: v.literal(operation),
            ...dockerOperationBase,
        })
);

const dockerPruneExecuteObjectSchema = v.strictObject({
    confirmation: v.picklist(
        ["prune-docker-images", "prune-docker-volumes"],
        "Docker prune confirmation is invalid"
    ),
    operation: v.literal("prune-execute"),
    ...dockerOperationBase,
    target: dockerPruneTargetSchema,
    ticketId: lowercaseUuidV7Schema("Docker prune ticket id is invalid"),
});

/**
 * @param operation Actor-confirmed Docker prune operation.
 * @returns Whether destructive prune confirmation names the selected target.
 */
export function dockerPruneConfirmationMatchesTarget(
    operation: v.InferOutput<typeof dockerPruneExecuteObjectSchema>
): boolean {
    return operation.confirmation === `prune-docker-${operation.target}`;
}

const dockerPruneExecuteSchema = v.pipe(
    dockerPruneExecuteObjectSchema,
    v.check(
        dockerPruneConfirmationMatchesTarget,
        "Docker prune confirmation does not match its target"
    )
);

/** Recent-MFA, idempotent, exact-target request; no generic command surface exists. */
export const dockerRequestOperationInputSchema = v.variant("operation", [
    ...dockerContainerOperationSchemas,
    v.strictObject({
        confirmation: v.literal("delete-docker-image"),
        imageId: dockerObjectIdSchema,
        operation: v.literal("image-delete"),
        ...dockerOperationBase,
    }),
    dockerPruneExecuteSchema,
    ...dockerStackOperationSchemas,
    v.strictObject({
        confirmation: v.literal("run-docker-updates"),
        operation: v.literal("updater-run"),
        ...dockerOperationBase,
    }),
    v.strictObject({
        confirmation: v.literal("scan-docker-updates"),
        operation: v.literal("updater-scan"),
        ...dockerOperationBase,
    }),
    v.strictObject({
        candidateImage: dockerImageReferenceSchema,
        confirmation: v.literal("update-docker-service"),
        currentImage: dockerImageReferenceSchema,
        operation: v.literal("updater-update-service"),
        ...dockerOperationBase,
        serviceId: dockerUpdaterServiceIdSchema,
    }),
    v.strictObject({
        confirmation: v.literal("delete-docker-volume"),
        operation: v.literal("volume-delete"),
        ...dockerOperationBase,
        volumeName: dockerVolumeNameSchema,
    }),
]);

export const dockerRequestOperationResultSchema = v.strictObject({
    jobRunId: jobRunIdSchema,
    operation: dockerOperationIdSchema,
    queued: v.literal(true, "Docker operation queue result is invalid"),
});

export type DockerContainerStats = v.InferOutput<typeof dockerContainerStatsSchema>;
export type DockerContainerPort = v.InferOutput<typeof dockerContainerPortSchema>;
export type DockerGetContainerLogsInput = v.InferOutput<
    typeof dockerGetContainerLogsInputSchema
>;
export type DockerGetContainerLogsResult = v.InferOutput<
    typeof dockerGetContainerLogsResultSchema
>;
export type DockerImage = v.InferOutput<typeof dockerImageSchema>;
export type DockerOperationId = v.InferOutput<typeof dockerOperationIdSchema>;
export type DockerPreparePruneInput = v.InferOutput<typeof dockerPreparePruneInputSchema>;
export type DockerRequestOperationInput = v.InferOutput<
    typeof dockerRequestOperationInputSchema
>;
export type DockerRequestOperationResult = v.InferOutput<
    typeof dockerRequestOperationResultSchema
>;
export type DockerUpdaterEvent = v.InferOutput<typeof dockerUpdaterEventSchema>;
export type DockerUpdaterPolicy = v.InferOutput<typeof dockerUpdaterPolicySchema>;
export type DockerUpdaterService = v.InferOutput<typeof dockerUpdaterServiceSchema>;
export type DockerUpdaterStatus = v.InferOutput<typeof dockerUpdaterStatusSchema>;
export type DockerVolume = v.InferOutput<typeof dockerVolumeSchema>;

const dockerReadAccess = {
    capabilities: ["docker:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const dockerWriteAccess = {
    capabilities: ["docker:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const dockerQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const dockerMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

/** Docker read and recent-MFA mutation metadata for explicit router composition. */
export const dockerProcedureContracts = [
    {
        access: dockerReadAccess,
        domain: "docker",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: dockerOverviewInputSchema,
        inputSchemaId: "docker.overview.input",
        kind: "query",
        name: "docker.overview",
        output: dockerOverviewSchema,
        outputSchemaId: "docker.overview.output",
        summary:
            "Reads one bounded Engine/Compose snapshot without environment, raw labels, host mount sources, arguments, or provider failures.",
        transport: dockerQueryTransport,
    },
    {
        access: dockerReadAccess,
        domain: "docker",
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: dockerGetContainerLogsInputSchema,
        inputSchemaId: "docker.getContainerLogs.input",
        kind: "query",
        name: "docker.getContainerLogs",
        output: dockerGetContainerLogsResultSchema,
        outputSchemaId: "docker.getContainerLogs.output",
        summary: "Reads a bounded redacted tail from one exact full container identity.",
        transport: dockerQueryTransport,
    },
    {
        access: dockerReadAccess,
        domain: "docker",
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: dockerPreparePruneInputSchema,
        inputSchemaId: "docker.preparePrune.input",
        kind: "query",
        name: "docker.preparePrune",
        output: dockerPreparePruneResultSchema,
        outputSchemaId: "docker.preparePrune.output",
        summary:
            "Previews an exact bounded image or volume prune and issues a short ticket.",
        transport: dockerQueryTransport,
    },
    {
        access: dockerWriteAccess,
        domain: "docker",
        errorReasons: [
            "mfa_enrollment_required",
            "operation_outcome_unknown",
            "step_up_required",
        ],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: dockerRequestOperationInputSchema,
        inputSchemaId: "docker.requestOperation.input",
        kind: "mutation",
        name: "docker.requestOperation",
        output: dockerRequestOperationResultSchema,
        outputSchemaId: "docker.requestOperation.output",
        summary:
            "Queues one exact idempotent Docker operation after recent MFA and source-revision validation.",
        transport: dockerMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];
