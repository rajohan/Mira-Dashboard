import * as v from "valibot";

import {
    backupStatusCacheGroupKey,
    backupStatusCacheKeys,
    backupStatusCacheSchemaIds,
    backupStatusCacheSource,
    backupStatusCacheTtlMs,
    backupStatusPayloadMaximumBytes,
    kopiaBackupCachePayloadSchema,
    walgBackupCachePayloadSchema,
} from "../../../contracts/backups.ts";
import {
    cacheEntryKeySchema,
    cacheEntryPayloadMaximumBytes,
    cacheEntryPayloadSchema,
    cacheEntrySchemaIdSchema,
    cacheEntrySourceSchema,
    systemHostCachePayloadSchema,
} from "../../../contracts/cache.ts";
import {
    databaseObservabilityCacheKey,
    databaseObservabilityCachePayloadSchema,
    databaseObservabilityCacheSchemaId,
    databaseObservabilityCacheSource,
} from "../../../contracts/database.ts";
import {
    deliveryOverviewCacheKey,
    deliveryOverviewSectionIds,
    deliveryOverviewSectionKeys,
    deliveryOverviewSectionPayloadSchemas,
    deliveryOverviewSectionSchemaIds,
    deliveryOverviewSectionSources,
    deliveryPullRequestsPayloadMaximumBytes,
} from "../../../contracts/delivery.ts";
import {
    deliveryGitHubActionKey,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
} from "../../../contracts/deliveryWorker.ts";
import {
    dockerOverviewCacheKey,
    dockerOverviewCachePayloadSchema,
    dockerOverviewCacheSchemaId,
    dockerOverviewCacheSource,
} from "../../../contracts/docker.ts";
import {
    gitWorkspaceCacheKey,
    gitWorkspaceCachePayloadSchema,
    gitWorkspaceCacheSchemaId,
    gitWorkspaceCacheSource,
    gitWorkspaceCacheTtlMs,
} from "../../../contracts/gitWorkspace.ts";
import { moltbookDashboardCachePayloadSchema } from "../../../contracts/moltbook.ts";
import {
    quotaCacheKey,
    quotaCachePayloadSchema,
    quotaCacheSchemaId,
    quotaCacheSource,
    quotaCacheTtlMs,
} from "../../../contracts/quota.ts";
import type { ApplicationCapability } from "../../../contracts/security.ts";
import {
    openClawUpdateCacheKey,
    openClawUpdateCacheSchemaId,
    openClawUpdateCacheSource,
    openClawUpdateCacheTtlMs,
    openClawUpdateStatusSchema,
} from "../../../contracts/system.ts";
import {
    weatherCacheKey,
    weatherCachePayloadSchema,
    weatherCacheSchemaId,
    weatherCacheSource,
    weatherCacheTtlMs,
} from "../../../contracts/weather.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import type { JsonObject } from "../../../shared/json.ts";
import {
    databaseObservabilityCacheJobActionKey,
    databaseObservabilityCacheJobScheduleId,
    deliveryOverviewCacheJobActionKey,
    deliveryOverviewCacheJobScheduleId,
    dockerOverviewCacheJobActionKey,
    dockerOverviewCacheJobScheduleId,
    dockerOperationJobActionKey,
    dockerUpdaterJobActionKey,
    findJobActionDefinition,
    gitWorkspaceCacheJobActionKey,
    gitWorkspaceCacheJobScheduleId,
    moltbookDashboardCacheJobActionKey,
    moltbookDashboardCacheJobScheduleId,
    openClawUpdateCacheJobActionKey,
    openClawUpdateCacheJobScheduleId,
    backupStatusJobActionKey,
    backupStatusJobScheduleId,
    quotaCacheJobActionKey,
    quotaCacheJobScheduleId,
    weatherCacheJobActionKey,
    weatherCacheJobScheduleId,
} from "../jobs/actionRegistry.ts";

export interface CacheProviderDefinition {
    readonly additionalWriterActionKeys?: readonly string[];
    readonly actionPayloadKey?: string;
    readonly actionKey: string;
    readonly key: string;
    readonly manualRefresh: boolean;
    readonly payloadSchema: v.GenericSchema;
    readonly payloadMaximumBytes: number;
    readonly readCapability?: ApplicationCapability;
    readonly scheduleId: string;
    readonly schemaId: string;
    readonly source: string;
    readonly ttlMs: number;
}

function validateCacheProviderDefinition(
    definition: CacheProviderDefinition
): CacheProviderDefinition {
    v.parse(cacheEntryKeySchema, definition.key);
    v.parse(cacheEntrySchemaIdSchema, definition.schemaId);
    v.parse(cacheEntrySourceSchema, definition.source);
    if (!Number.isSafeInteger(definition.ttlMs) || definition.ttlMs < 60_000) {
        throw new RangeError("Cache provider TTL is invalid");
    }
    if (
        !Number.isSafeInteger(definition.payloadMaximumBytes) ||
        definition.payloadMaximumBytes < 2 ||
        definition.payloadMaximumBytes > deliveryPullRequestsPayloadMaximumBytes
    ) {
        throw new RangeError("Cache provider payload budget is invalid");
    }
    const action = findJobActionDefinition(definition.actionKey);
    const additionalWriterActionKeys = Object.freeze([
        ...(definition.additionalWriterActionKeys ?? []),
    ]);
    if (
        action === undefined ||
        action.scheduleId !== definition.scheduleId ||
        action.manualExposure !==
            (definition.manualRefresh ? "cache-write" : "cache-internal") ||
        action.actionPayload.key !== (definition.actionPayloadKey ?? definition.key)
    ) {
        throw new Error("Cache provider does not match its exact job action definition");
    }
    if (
        new Set(additionalWriterActionKeys).size !== additionalWriterActionKeys.length ||
        additionalWriterActionKeys.includes(definition.actionKey)
    ) {
        throw new Error("Cache provider additional writer authority is invalid");
    }
    return Object.freeze({ ...definition, additionalWriterActionKeys });
}

const systemHostProvider = validateCacheProviderDefinition({
    actionKey: "cache.refresh.system-host",
    key: "system.host",
    manualRefresh: true,
    payloadSchema: systemHostCachePayloadSchema,
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: "cache.system-host",
    schemaId: "system.host.v1",
    source: "system.host",
    ttlMs: 86_400_000,
});

const openClawUpdateProvider = validateCacheProviderDefinition({
    actionKey: openClawUpdateCacheJobActionKey,
    key: openClawUpdateCacheKey,
    manualRefresh: false,
    payloadSchema: openClawUpdateStatusSchema,
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: openClawUpdateCacheJobScheduleId,
    schemaId: openClawUpdateCacheSchemaId,
    source: openClawUpdateCacheSource,
    ttlMs: openClawUpdateCacheTtlMs,
});

const moltbookDashboardProvider = validateCacheProviderDefinition({
    actionKey: moltbookDashboardCacheJobActionKey,
    key: "moltbook.dashboard",
    manualRefresh: true,
    payloadSchema: moltbookDashboardCachePayloadSchema,
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: moltbookDashboardCacheJobScheduleId,
    schemaId: "moltbook.dashboard.v1",
    source: "moltbook.api",
    ttlMs: 30 * 60_000,
});

const overviewProviders = [
    {
        actionKey: gitWorkspaceCacheJobActionKey,
        key: gitWorkspaceCacheKey,
        payloadSchema: gitWorkspaceCachePayloadSchema,
        scheduleId: gitWorkspaceCacheJobScheduleId,
        schemaId: gitWorkspaceCacheSchemaId,
        source: gitWorkspaceCacheSource,
        ttlMs: gitWorkspaceCacheTtlMs,
    },
    {
        actionKey: quotaCacheJobActionKey,
        key: quotaCacheKey,
        payloadSchema: quotaCachePayloadSchema,
        scheduleId: quotaCacheJobScheduleId,
        schemaId: quotaCacheSchemaId,
        source: quotaCacheSource,
        ttlMs: quotaCacheTtlMs,
    },
    {
        actionKey: weatherCacheJobActionKey,
        key: weatherCacheKey,
        payloadSchema: weatherCachePayloadSchema,
        scheduleId: weatherCacheJobScheduleId,
        schemaId: weatherCacheSchemaId,
        source: weatherCacheSource,
        ttlMs: weatherCacheTtlMs,
    },
].map((provider) =>
    validateCacheProviderDefinition({
        ...provider,
        manualRefresh: true,
        payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    })
);

const databaseObservabilityProvider = validateCacheProviderDefinition({
    actionKey: databaseObservabilityCacheJobActionKey,
    key: databaseObservabilityCacheKey,
    manualRefresh: false,
    payloadSchema: databaseObservabilityCachePayloadSchema,
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    readCapability: "database:read",
    scheduleId: databaseObservabilityCacheJobScheduleId,
    schemaId: databaseObservabilityCacheSchemaId,
    source: databaseObservabilityCacheSource,
    ttlMs: 90 * 60_000,
});

const dockerOverviewProvider = validateCacheProviderDefinition({
    additionalWriterActionKeys: Object.freeze([
        dockerOperationJobActionKey,
        dockerUpdaterJobActionKey,
    ]),
    actionKey: dockerOverviewCacheJobActionKey,
    key: dockerOverviewCacheKey,
    manualRefresh: true,
    payloadSchema: dockerOverviewCachePayloadSchema,
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    readCapability: "docker:read",
    scheduleId: dockerOverviewCacheJobScheduleId,
    schemaId: dockerOverviewCacheSchemaId,
    source: dockerOverviewCacheSource,
    ttlMs: 5 * 60_000,
});

const backupStatusProviders = [
    {
        key: backupStatusCacheKeys.kopia,
        payloadSchema: kopiaBackupCachePayloadSchema,
        schemaId: backupStatusCacheSchemaIds.kopia,
    },
    {
        key: backupStatusCacheKeys.walg,
        payloadSchema: walgBackupCachePayloadSchema,
        schemaId: backupStatusCacheSchemaIds.walg,
    },
].map(({ key, payloadSchema, schemaId }) =>
    validateCacheProviderDefinition({
        actionKey: backupStatusJobActionKey,
        actionPayloadKey: backupStatusCacheGroupKey,
        key,
        manualRefresh: false,
        payloadSchema,
        payloadMaximumBytes: backupStatusPayloadMaximumBytes,
        readCapability: "backups:read",
        scheduleId: backupStatusJobScheduleId,
        schemaId,
        source: backupStatusCacheSource,
        ttlMs: backupStatusCacheTtlMs,
    })
);

const deliveryOverviewProviders = deliveryOverviewSectionIds.map((section) =>
    validateCacheProviderDefinition({
        additionalWriterActionKeys: Object.freeze([
            deliveryGitHubActionKey,
            deliveryPreviewActionKey,
            deliveryProductionActionKey,
        ]),
        actionKey: deliveryOverviewCacheJobActionKey,
        actionPayloadKey: deliveryOverviewCacheKey,
        key: deliveryOverviewSectionKeys[section],
        manualRefresh: false,
        payloadSchema: deliveryOverviewSectionPayloadSchemas[section],
        payloadMaximumBytes:
            section === "pull-requests"
                ? deliveryPullRequestsPayloadMaximumBytes
                : cacheEntryPayloadMaximumBytes,
        readCapability: "delivery:read",
        scheduleId: deliveryOverviewCacheJobScheduleId,
        schemaId: deliveryOverviewSectionSchemaIds[section],
        source: deliveryOverviewSectionSources[section],
        ttlMs: 5 * 60_000,
    })
);

/** Complete local-only provider directory for the implemented cache slice. */
export const cacheProviderDefinitions = Object.freeze([
    systemHostProvider,
    openClawUpdateProvider,
    moltbookDashboardProvider,
    ...overviewProviders,
    databaseObservabilityProvider,
    ...deliveryOverviewProviders,
    dockerOverviewProvider,
    ...backupStatusProviders,
]);

const providerByKey = new Map(
    cacheProviderDefinitions.map((definition) => [definition.key, definition])
);
if (providerByKey.size !== cacheProviderDefinitions.length) {
    throw new Error("Cache provider registry contains duplicate keys");
}

/**
 * Resolves one exact release-owned cache provider.
 * @param key Canonical cache entry key.
 * @returns The matching provider definition when registered.
 */
export function findCacheProviderDefinition(
    key: string
): CacheProviderDefinition | undefined {
    return providerByKey.get(key);
}

/**
 * Resolves the additional domain grant required to read one provider through the generic cache API.
 * Providers without a domain boundary remain covered by the route's mandatory cache:read grant.
 * @param key Canonical cache entry key.
 * @returns The owning domain's read capability when the payload has an additional boundary.
 */
export function cacheProviderReadCapability(
    key: string
): ApplicationCapability | undefined {
    return findCacheProviderDefinition(key)?.readCapability;
}

/**
 * @param key Canonical cache entry key.
 * @param actionKey Claimed job action key.
 * @param payloadJson Immutable claimed job payload.
 * @returns Whether one claimed job snapshot may commit this provider's cache key.
 */
export function cacheProviderAcceptsWriter(
    key: string,
    actionKey: string,
    payloadJson: string
): boolean {
    const provider = findCacheProviderDefinition(key);
    if (provider === undefined) return false;
    if (provider.additionalWriterActionKeys?.includes(actionKey)) return true;
    const action = findJobActionDefinition(provider.actionKey);
    return (
        action?.actionKey === actionKey &&
        JSON.stringify(action.actionPayload) === payloadJson
    );
}

/**
 * Validates one provider payload before it enters a cache write transaction.
 * @param definition Provider definition that owns the payload schema.
 * @param payload Structured provider payload.
 * @returns The payload parsed through the provider's exact schema.
 */
export function parseCacheProviderPayload(
    definition: CacheProviderDefinition,
    payload: JsonObject
): JsonObject {
    const parsed = v.parse(definition.payloadSchema, payload) as JsonObject;
    if (utf8ByteLength(JSON.stringify(parsed)) > definition.payloadMaximumBytes) {
        throw new RangeError("Cache provider payload is outside its budget");
    }
    return definition.payloadMaximumBytes === cacheEntryPayloadMaximumBytes
        ? v.parse(cacheEntryPayloadSchema, parsed)
        : parsed;
}

/**
 * Derives manual refresh availability from the exact current action definition.
 * @param key Canonical cache entry key.
 * @returns Whether the provider's current job action permits cache-triggered runs.
 */
export function cacheManualRunAvailable(key: string): boolean {
    const provider = findCacheProviderDefinition(key);
    if (provider === undefined) return false;
    const action = findJobActionDefinition(provider.actionKey);
    return (
        provider.manualRefresh &&
        action?.manualExposure === "cache-write" &&
        action.scheduleId === provider.scheduleId
    );
}
