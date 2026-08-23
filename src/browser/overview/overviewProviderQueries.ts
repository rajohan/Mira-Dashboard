import { queryOptions } from "@tanstack/react-query";
import * as v from "valibot";

import type { CacheEntry } from "../../contracts/cache.ts";
import {
    gitWorkspaceCacheKey,
    gitWorkspaceCachePayloadSchema,
    gitWorkspaceCacheSchemaId,
    gitWorkspaceCacheSource,
} from "../../contracts/gitWorkspace.ts";
import {
    quotaCacheKey,
    quotaCachePayloadSchema,
    quotaCacheSchemaId,
    quotaCacheSource,
} from "../../contracts/quota.ts";
import {
    weatherCacheKey,
    weatherCachePayloadSchema,
    weatherCacheSchemaId,
    weatherCacheSource,
} from "../../contracts/weather.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    cacheEntryQueryKey,
    cacheStatusRefreshIntervalMs,
} from "../cache/cacheQueries.ts";

interface OverviewProviderContract<TPayload> {
    readonly key: string;
    readonly payloadSchema: v.BaseSchema<unknown, TPayload, v.BaseIssue<unknown>>;
    readonly schemaId: string;
    readonly source: string;
}

const gitContract: OverviewProviderContract<
    v.InferOutput<typeof gitWorkspaceCachePayloadSchema>
> = {
    key: gitWorkspaceCacheKey,
    payloadSchema: gitWorkspaceCachePayloadSchema,
    schemaId: gitWorkspaceCacheSchemaId,
    source: gitWorkspaceCacheSource,
};

const quotaContract: OverviewProviderContract<
    v.InferOutput<typeof quotaCachePayloadSchema>
> = {
    key: quotaCacheKey,
    payloadSchema: quotaCachePayloadSchema,
    schemaId: quotaCacheSchemaId,
    source: quotaCacheSource,
};

const weatherContract: OverviewProviderContract<
    v.InferOutput<typeof weatherCachePayloadSchema>
> = {
    key: weatherCacheKey,
    payloadSchema: weatherCachePayloadSchema,
    schemaId: weatherCacheSchemaId,
    source: weatherCacheSource,
};

export interface OverviewProviderProjection<TPayload> {
    readonly entry: CacheEntry;
    readonly payload: TPayload;
}

function projectProviderEntry<TPayload>(
    entry: CacheEntry,
    contract: OverviewProviderContract<TPayload>
): OverviewProviderProjection<TPayload> {
    if (
        entry.key !== contract.key ||
        entry.schemaId !== contract.schemaId ||
        entry.source !== contract.source ||
        entry.payload === undefined
    ) {
        throw new TypeError("Overview provider projection is unavailable");
    }
    const parsed = v.safeParse(contract.payloadSchema, entry.payload);
    if (!parsed.success) {
        throw new TypeError("Overview provider projection is invalid");
    }
    return { entry, payload: parsed.output };
}

function providerQueryOptions<TPayload>(
    client: DashboardTrpcClient,
    contract: OverviewProviderContract<TPayload>
) {
    return queryOptions({
        queryFn: ({ signal }) =>
            client.query("cache.getEntry", { key: contract.key }, { signal }),
        queryKey: cacheEntryQueryKey(contract.key),
        refetchInterval: cacheStatusRefreshIntervalMs,
        refetchOnMount: "always",
        select: (entry) => projectProviderEntry(entry, contract),
        staleTime: cacheStatusRefreshIntervalMs,
    });
}

/** @returns Exact query options for the managed Git overview projection. */
export function gitOverviewQueryOptions(client: DashboardTrpcClient) {
    return providerQueryOptions(client, gitContract);
}

/** @returns Exact query options for the normalized provider-quota projection. */
export function quotaOverviewQueryOptions(client: DashboardTrpcClient) {
    return providerQueryOptions(client, quotaContract);
}

/** @returns Exact query options for the fixed Spydeberg weather projection. */
export function weatherOverviewQueryOptions(client: DashboardTrpcClient) {
    return providerQueryOptions(client, weatherContract);
}
