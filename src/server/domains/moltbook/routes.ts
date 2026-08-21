import { TRPCError } from "@trpc/server";
import { Effect } from "effect";
import * as v from "valibot";

import type { CacheEntry } from "../../../contracts/cache.ts";
import {
    moltbookDashboardCachePayloadSchema,
    moltbookFeedInputSchema,
    moltbookFeedResultSchema,
    moltbookHomeResultSchema,
    moltbookOwnContentResultSchema,
    moltbookProfileResultSchema,
    moltbookSnapshotResultSchema,
    moltbookSnapshotStatusSchema,
} from "../../../contracts/moltbook.ts";
import { emptyInputSchema } from "../../../contracts/system.ts";
import { sessionCapabilityProcedure } from "../../trpc/trpc.ts";
import { CacheNotFoundError } from "../cache/errors.ts";
import type { CacheService } from "../cache/service.ts";

const moltbookCacheKey = "moltbook.dashboard";
const moltbookCacheSchemaId = "moltbook.dashboard.v1";

function unavailable(): TRPCError {
    return new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "Moltbook data is temporarily unavailable",
    });
}

async function readSnapshot(cacheService: CacheService["Service"]) {
    let entry: CacheEntry;
    try {
        entry = await Effect.runPromise(cacheService.getEntry({ key: moltbookCacheKey }));
    } catch (error) {
        if (error instanceof CacheNotFoundError) throw unavailable();
        throw error;
    }
    if (
        entry.freshness === "missing" ||
        entry.payload === undefined ||
        entry.lastSuccessAtMs === undefined ||
        entry.schemaId !== moltbookCacheSchemaId
    ) {
        throw unavailable();
    }
    try {
        const snapshot = v.parse(moltbookDashboardCachePayloadSchema, entry.payload);
        const status = v.parse(moltbookSnapshotStatusSchema, {
            freshness: entry.freshness,
            lastAttemptAtMs: entry.lastAttemptAtMs,
            lastAttemptStatus: entry.lastAttemptStatus,
            lastSuccessAtMs: entry.lastSuccessAtMs,
            ...(entry.lastAttemptStatus === "failed"
                ? { refreshFailureMessage: entry.failureMessage }
                : {}),
        });
        return { snapshot, status };
    } catch (error) {
        if (v.isValiError(error)) throw unavailable();
        throw error;
    }
}

const moltbookReadProcedure = sessionCapabilityProcedure("cache:read");

/** Session-only projections over one bounded last-known-good Moltbook snapshot. */
export const moltbookRoutes = {
    feed: moltbookReadProcedure
        .input(moltbookFeedInputSchema)
        .output(moltbookFeedResultSchema)
        .query(async ({ ctx, input }) => {
            const { snapshot, status } = await readSnapshot(ctx.cacheService);
            return { feed: snapshot.feeds[input.sort], status };
        }),
    home: moltbookReadProcedure
        .input(emptyInputSchema)
        .output(moltbookHomeResultSchema)
        .query(async ({ ctx }) => {
            const { snapshot, status } = await readSnapshot(ctx.cacheService);
            return { home: snapshot.home, status };
        }),
    listMyPosts: moltbookReadProcedure
        .input(emptyInputSchema)
        .output(moltbookOwnContentResultSchema)
        .query(async ({ ctx }) => {
            const { snapshot, status } = await readSnapshot(ctx.cacheService);
            return { content: snapshot.myContent, status };
        }),
    profile: moltbookReadProcedure
        .input(emptyInputSchema)
        .output(moltbookProfileResultSchema)
        .query(async ({ ctx }) => {
            const { snapshot, status } = await readSnapshot(ctx.cacheService);
            return {
                ...(snapshot.profile === undefined ? {} : { profile: snapshot.profile }),
                status,
            };
        }),
    snapshot: moltbookReadProcedure
        .input(moltbookFeedInputSchema)
        .output(moltbookSnapshotResultSchema)
        .query(async ({ ctx, input }) => {
            const { snapshot, status } = await readSnapshot(ctx.cacheService);
            return {
                content: snapshot.myContent,
                feed: snapshot.feeds[input.sort],
                home: snapshot.home,
                ...(snapshot.profile === undefined ? {} : { profile: snapshot.profile }),
                status,
            };
        }),
};
