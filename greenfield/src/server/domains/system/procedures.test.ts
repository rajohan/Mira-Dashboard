import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type { SystemMetrics } from "../../../contracts/system.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import {
    SystemMetricsUnavailableError,
    type SystemMetricsRuntimeService,
} from "./systemMetricsService.ts";

const metrics = Object.freeze({
    cpu: {
        loadAverage: [2, 1, 0.5],
        loadPercent: 50,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 400,
        totalBytes: 1000,
        usedBytes: 600,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 250,
        totalBytes: 1000,
        usedBytes: 750,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 800,
        state: "ready",
        uploadBitsPerSecond: 400,
    },
    sampledAtMs: 1_800_000_000_000,
    uptimeSeconds: 12,
} as const satisfies SystemMetrics);

async function caller(
    authentication = createTestSessionAuthentication([]),
    systemMetrics: SystemMetricsRuntimeService = Object.freeze({
        read: () => Promise.resolve(metrics),
    })
) {
    const context = await createTestRequestContext(
        authentication,
        createTestApplicationRuntime({ systemMetrics })
    );
    return appRouter.createCaller(context).system;
}

describe("system metrics procedure", () => {
    test("returns the runtime snapshot to an authenticated browser session", async () => {
        const system = await caller();
        expect(await system.metrics()).toEqual(metrics);
    });

    test("rejects anonymous and automation principals before reading metrics", async () => {
        let readCount = 0;
        const systemMetrics = Object.freeze({
            read: () => {
                readCount += 1;
                return Promise.resolve(metrics);
            },
        });
        const anonymous = await caller({ kind: "anonymous" }, systemMetrics);
        const automation = await caller(
            createTestAutomationAuthentication([]),
            systemMetrics
        );
        const anonymousFailure = await captureFailure(() => anonymous.metrics());
        const automationFailure = await captureFailure(() => automation.metrics());

        expect(anonymousFailure).toMatchObject({ code: "UNAUTHORIZED" });
        expect(automationFailure).toMatchObject({ code: "FORBIDDEN" });
        expect(readCount).toBe(0);
    });

    test("maps only typed collection outages to a fixed safe failure", async () => {
        const rawFailure = new TypeError("private /proc failure detail");
        const system = await caller(
            createTestSessionAuthentication([]),
            Object.freeze({
                read: () => Promise.reject(new SystemMetricsUnavailableError(rawFailure)),
            })
        );
        const failure = await captureFailure(() => system.metrics());

        expect(failure).toBeInstanceOf(TRPCError);
        expect(failure).toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            message: "System metrics are temporarily unavailable",
        });
        expect((failure as Error).message).not.toContain(rawFailure.message);
    });
});
