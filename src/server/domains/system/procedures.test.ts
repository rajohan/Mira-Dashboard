import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import {
    systemHttpMetricOverflowProcedure,
    systemHttpMetricProcedureNames,
    type SystemHealthDiagnostics,
    type SystemMetrics,
} from "../../../contracts/system.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import type { SystemHealthDiagnosticsService } from "./healthDiagnosticsService.ts";
import {
    SystemMetricsUnavailableError,
    type SystemMetricsRuntimeService,
} from "./systemMetricsService.ts";

const metrics = Object.freeze({
    application: {
        cache: { state: "unavailable" },
        chat: { state: "unavailable" },
        gateway: { state: "unavailable" },
        http: {
            procedures: [
                ...systemHttpMetricProcedureNames,
                systemHttpMetricOverflowProcedure,
            ].map((procedure) => ({
                errorCount: 0,
                maximumDurationMs: 0,
                procedure,
                requestCount: 0,
                totalDurationMs: 0,
            })),
            state: "observed",
        },
        jobs: { state: "unavailable" },
        operations: { state: "unavailable" },
        realtime: { state: "unavailable" },
        sqlite: { state: "unavailable" },
        web: { state: "unavailable" },
    },
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

const healthDiagnostics = Object.freeze({
    checkedAtMs: 1_800_000_000_000,
    checks: {
        application: { status: "not-ready" },
        database: { status: "unavailable" },
        frontend: { status: "ready" },
        release: { status: "verified" },
        worker: { status: "unavailable" },
    },
    dependencies: {
        gateway: { status: "unavailable" },
        sessions: { state: "unavailable" },
    },
    queue: { status: "unavailable" },
    status: "not-ready",
} as const satisfies SystemHealthDiagnostics);

async function caller(
    authentication = createTestSessionAuthentication([]),
    systemMetrics: SystemMetricsRuntimeService = Object.freeze({
        configureApplicationReader: () => {},
        recordHttpRequest: () => {},
        read: () => Promise.resolve(metrics),
    }),
    systemHealthDiagnosticsService: SystemHealthDiagnosticsService = Object.freeze({
        read: () => healthDiagnostics,
    })
) {
    const context = await createTestRequestContext(
        authentication,
        createTestApplicationRuntime({ systemMetrics }),
        { systemHealthDiagnosticsService }
    );
    return appRouter.createCaller(context).system;
}

describe("system health diagnostics procedure", () => {
    test("returns degraded diagnostics successfully to a browser session", async () => {
        const system = await caller();

        expect(await system.healthDiagnostics()).toEqual(healthDiagnostics);
    });

    test("rejects anonymous and automation principals before reading health", async () => {
        let readCount = 0;
        const service = Object.freeze({
            read: () => {
                readCount += 1;
                return healthDiagnostics;
            },
        });
        const anonymous = await caller({ kind: "anonymous" }, undefined, service);
        const automation = await caller(
            createTestAutomationAuthentication([]),
            undefined,
            service
        );
        const anonymousFailure = await captureFailure(() =>
            anonymous.healthDiagnostics()
        );
        const automationFailure = await captureFailure(() =>
            automation.healthDiagnostics()
        );

        expect(anonymousFailure).toMatchObject({ code: "UNAUTHORIZED" });
        expect(automationFailure).toMatchObject({ code: "FORBIDDEN" });
        expect(readCount).toBe(0);
    });
});

describe("system documentation reference procedure", () => {
    test("serves generated documentation only to a browser session", async () => {
        const system = await caller();
        const documents = await system.documentationReference();
        expect(documents).toContainEqual(
            expect.objectContaining({
                kind: "markdown",
                path: "generated/README.md",
            })
        );

        const anonymous = await caller({ kind: "anonymous" });
        const automation = await caller(createTestAutomationAuthentication([]));
        expect(
            await captureFailure(() => anonymous.documentationReference())
        ).toMatchObject({ code: "UNAUTHORIZED" });
        expect(
            await captureFailure(() => automation.documentationReference())
        ).toMatchObject({ code: "FORBIDDEN" });
    });
});

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
