import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    cacheRealtimeChangeSchema,
    cacheRealtimeEventContract,
    cacheRealtimeRoutingSchema,
    cacheRealtimeTopic,
    cacheRealtimeTopicDefinition,
} from "./cacheRealtime.ts";

describe("cache realtime contract", () => {
    test("registers exact read authorization and bounded status snapshot", () => {
        expect(cacheRealtimeTopicDefinition).toMatchObject({
            capability: "cache:read",
            entityTypes: ["cache-entry"],
            operations: ["created", "updated"],
            topic: cacheRealtimeTopic,
        });
        expect(cacheRealtimeEventContract.snapshotProcedure).toBe("cache.getStatus");
    });

    test("accepts only matching cache entry invalidations", () => {
        expect(
            v.parse(cacheRealtimeRoutingSchema, {
                entityType: "cache-entry",
                operation: "created",
                topic: cacheRealtimeTopic,
            })
        ).toBeDefined();
        expect(
            v.parse(cacheRealtimeChangeSchema, {
                entityId: "system.host",
                entityType: "cache-entry",
                occurredAtMs: 1000,
                operation: "updated",
                payload: { key: "system.host" },
                topic: cacheRealtimeTopic,
            })
        ).toBeDefined();
        expect(
            v.safeParse(cacheRealtimeChangeSchema, {
                entityId: "system.host",
                entityType: "cache-entry",
                occurredAtMs: 1000,
                operation: "updated",
                payload: { key: "system.other" },
                topic: cacheRealtimeTopic,
            }).success
        ).toBeFalse();
    });
});
