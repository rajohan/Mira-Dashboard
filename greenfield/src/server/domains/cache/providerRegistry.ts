import * as v from "valibot";

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
    dockerOverviewCacheKey,
    dockerOverviewCachePayloadSchema,
    dockerOverviewCacheSchemaId,
    dockerOverviewCacheSource,
} from "../../../contracts/docker.ts";
import { moltbookDashboardCachePayloadSchema } from "../../../contracts/moltbook.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import type { JsonObject } from "../../../shared/json.ts";
import {
    databaseObservabilityCacheJobActionKey,
    databaseObservabilityCacheJobScheduleId,
    deliveryOverviewCacheJobActionKey,
    deliveryOverviewCacheJobScheduleId,
    dockerOverviewCacheJobActionKey,
    dockerOverviewCacheJobScheduleId,
    findJobActionDefinition,
    moltbookDashboardCacheJobActionKey,
    moltbookDashboardCacheJobScheduleId,
} from "../jobs/actionRegistry.ts";

export interface CacheProviderDefinition {
    readonly actionPayloadKey?: string;
    readonly actionKey: string;
    readonly key: string;
    readonly manualRefresh: boolean;
    readonly payloadSchema: v.GenericSchema;
    readonly payloadExposure: "cache-read" | "domain-only";
    readonly payloadMaximumBytes: number;
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
    if (
        action === undefined ||
        action.scheduleId !== definition.scheduleId ||
        action.manualExposure !==
            (definition.manualRefresh ? "cache-write" : "cache-internal") ||
        action.actionPayload.key !== (definition.actionPayloadKey ?? definition.key)
    ) {
        throw new Error("Cache provider does not match its exact job action definition");
    }
    return Object.freeze({ ...definition });
}

const systemHostProvider = validateCacheProviderDefinition({
    actionKey: "cache.refresh.system-host",
    key: "system.host",
    manualRefresh: true,
    payloadSchema: systemHostCachePayloadSchema,
    payloadExposure: "cache-read",
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: "cache.system-host",
    schemaId: "system.host.v1",
    source: "system.host",
    ttlMs: 86_400_000,
});

const moltbookDashboardProvider = validateCacheProviderDefinition({
    actionKey: moltbookDashboardCacheJobActionKey,
    key: "moltbook.dashboard",
    manualRefresh: true,
    payloadSchema: moltbookDashboardCachePayloadSchema,
    payloadExposure: "cache-read",
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: moltbookDashboardCacheJobScheduleId,
    schemaId: "moltbook.dashboard.v1",
    source: "moltbook.api",
    ttlMs: 30 * 60_000,
});

const databaseObservabilityProvider = validateCacheProviderDefinition({
    actionKey: databaseObservabilityCacheJobActionKey,
    key: databaseObservabilityCacheKey,
    manualRefresh: false,
    payloadSchema: databaseObservabilityCachePayloadSchema,
    payloadExposure: "domain-only",
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: databaseObservabilityCacheJobScheduleId,
    schemaId: databaseObservabilityCacheSchemaId,
    source: databaseObservabilityCacheSource,
    ttlMs: 90 * 60_000,
});

const dockerOverviewProvider = validateCacheProviderDefinition({
    actionKey: dockerOverviewCacheJobActionKey,
    key: dockerOverviewCacheKey,
    manualRefresh: true,
    payloadSchema: dockerOverviewCachePayloadSchema,
    payloadExposure: "domain-only",
    payloadMaximumBytes: cacheEntryPayloadMaximumBytes,
    scheduleId: dockerOverviewCacheJobScheduleId,
    schemaId: dockerOverviewCacheSchemaId,
    source: dockerOverviewCacheSource,
    ttlMs: 5 * 60_000,
});

const deliveryOverviewProviders = deliveryOverviewSectionIds.map((section) =>
    validateCacheProviderDefinition({
        actionKey: deliveryOverviewCacheJobActionKey,
        actionPayloadKey: deliveryOverviewCacheKey,
        key: deliveryOverviewSectionKeys[section],
        manualRefresh: false,
        payloadSchema: deliveryOverviewSectionPayloadSchemas[section],
        payloadExposure: "domain-only",
        payloadMaximumBytes:
            section === "pull-requests"
                ? deliveryPullRequestsPayloadMaximumBytes
                : cacheEntryPayloadMaximumBytes,
        scheduleId: deliveryOverviewCacheJobScheduleId,
        schemaId: deliveryOverviewSectionSchemaIds[section],
        source: deliveryOverviewSectionSources[section],
        ttlMs: 5 * 60_000,
    })
);

/** Complete local-only provider directory for the implemented cache slice. */
export const cacheProviderDefinitions = Object.freeze([
    systemHostProvider,
    moltbookDashboardProvider,
    databaseObservabilityProvider,
    ...deliveryOverviewProviders,
    dockerOverviewProvider,
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
