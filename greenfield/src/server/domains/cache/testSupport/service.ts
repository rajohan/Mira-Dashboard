import { Effect } from "effect";

import { CacheService } from "../service.ts";

function unexpectedCacheServiceCall(method: string): () => Effect.Effect<never> {
    return () =>
        Effect.die(
            new Error(`Test cache service received an unexpected call: ${method}`)
        );
}

/**
 * Creates a fail-closed cache service for unrelated router and server tests.
 * @param overrides Exact methods exercised by the current test.
 * @returns Complete cache-domain test double.
 */
export function createTestCacheService(
    overrides: Partial<CacheService["Service"]> = {}
): CacheService["Service"] {
    return CacheService.of({
        getEntry: unexpectedCacheServiceCall("getEntry"),
        getStatus: unexpectedCacheServiceCall("getStatus"),
        refreshEntry: unexpectedCacheServiceCall("refreshEntry"),
        ...overrides,
    });
}
