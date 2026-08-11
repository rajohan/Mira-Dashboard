import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import { testMoltbookDashboardSnapshot } from "../../test/support/moltbook.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import { CacheNotFoundError } from "../cache/errors.ts";
import { createTestCacheService } from "../cache/testSupport/service.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";

function staleEntry() {
    return {
        consecutiveFailures: 1,
        expiresAtMs: 1_800_000,
        failureCode: "provider/moltbook-unavailable",
        failureMessage: "Moltbook dashboard projection could not be collected.",
        freshness: "stale" as const,
        key: "moltbook.dashboard",
        lastAttemptAtMs: 2_000_000,
        lastAttemptDurationMs: 20,
        lastAttemptNumber: 2,
        lastAttemptRunId: runId,
        lastAttemptStatus: "failed" as const,
        lastSuccessAtMs: 0,
        manualRunAvailable: true,
        metadata: { kind: "dashboard" },
        payload: testMoltbookDashboardSnapshot,
        schemaId: "moltbook.dashboard.v1",
        source: "moltbook.api",
        updatedAtMs: 2_000_000,
    };
}

async function expectCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<void> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe(code);
}

describe("Moltbook procedures", () => {
    test("serves every projection with explicit stale last-known-good status", async () => {
        const cacheService = createTestCacheService({
            getEntry: () => Effect.succeed(staleEntry()),
        });
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["cache:read"]),
                createTestApplicationRuntime(),
                { cacheService }
            )
        ).moltbook;

        expect(await caller.home({})).toMatchObject({
            home: testMoltbookDashboardSnapshot.home,
            status: {
                freshness: "stale",
                lastAttemptStatus: "failed",
                refreshFailureMessage:
                    "Moltbook dashboard projection could not be collected.",
            },
        });
        expect(await caller.feed({ sort: "new" })).toMatchObject({
            feed: { sort: "new" },
            status: { freshness: "stale" },
        });
        expect(await caller.profile({})).toMatchObject({
            profile: { name: "mira_2026" },
        });
        expect(await caller.listMyPosts({})).toMatchObject({
            content: { comments: [], posts: [] },
        });
    });

    test("requires a cache-capable browser session and sanitizes missing state", async () => {
        const automation = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["cache:read"])
            )
        ).moltbook;
        await expectCode(() => automation.home({}), "FORBIDDEN");

        const missing = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["cache:read"]),
                createTestApplicationRuntime(),
                {
                    cacheService: createTestCacheService({
                        getEntry: () =>
                            Effect.fail(
                                new CacheNotFoundError({
                                    key: "moltbook.dashboard",
                                })
                            ),
                    }),
                }
            )
        ).moltbook;
        await expectCode(() => missing.profile({}), "SERVICE_UNAVAILABLE");
    });
});
