import * as v from "valibot";

import {
    cacheEntryKeySchema,
    cacheEntryPayloadSchema,
    cacheEntrySchemaIdSchema,
    cacheEntrySourceSchema,
    systemHostCachePayloadSchema,
} from "../../../contracts/cache.ts";
import { moltbookDashboardCachePayloadSchema } from "../../../contracts/moltbook.ts";
import type { JsonObject } from "../../../shared/json.ts";
import {
    findJobActionDefinition,
    moltbookDashboardCacheJobActionKey,
    moltbookDashboardCacheJobScheduleId,
} from "../jobs/actionRegistry.ts";

export interface CacheProviderDefinition {
    readonly actionKey: string;
    readonly key: string;
    readonly payloadSchema: v.GenericSchema;
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
    const action = findJobActionDefinition(definition.actionKey);
    if (
        action === undefined ||
        action.scheduleId !== definition.scheduleId ||
        action.manualExposure !== "cache-write" ||
        action.actionPayload.key !== definition.key
    ) {
        throw new Error("Cache provider does not match its exact job action definition");
    }
    return Object.freeze({ ...definition });
}

const systemHostProvider = validateCacheProviderDefinition({
    actionKey: "cache.refresh.system-host",
    key: "system.host",
    payloadSchema: systemHostCachePayloadSchema,
    scheduleId: "cache.system-host",
    schemaId: "system.host.v1",
    source: "system.host",
    ttlMs: 86_400_000,
});

const moltbookDashboardProvider = validateCacheProviderDefinition({
    actionKey: moltbookDashboardCacheJobActionKey,
    key: "moltbook.dashboard",
    payloadSchema: moltbookDashboardCachePayloadSchema,
    scheduleId: moltbookDashboardCacheJobScheduleId,
    schemaId: "moltbook.dashboard.v1",
    source: "moltbook.api",
    ttlMs: 30 * 60_000,
});

/** Complete local-only provider directory for the implemented cache slice. */
export const cacheProviderDefinitions = Object.freeze([
    systemHostProvider,
    moltbookDashboardProvider,
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
    return v.parse(cacheEntryPayloadSchema, v.parse(definition.payloadSchema, payload));
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
        action?.manualExposure === "cache-write" &&
        action.scheduleId === provider.scheduleId
    );
}
