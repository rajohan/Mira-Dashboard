import { afterEach, describe, expect, it, jest } from "bun:test";

import { agentRoutes } from "../../src/routes/agentRoutes.ts";
import { auditRoutes } from "../../src/routes/auditRoutes.ts";
import { dockerRoutes } from "../../src/routes/dockerRoutes.ts";
import { notificationRoutes } from "../../src/routes/notificationRoutes.ts";
import { opsRoutes } from "../../src/routes/opsRoutes.ts";
import { reportRoutes } from "../../src/routes/reportRoutes.ts";
import { settingsRoutes } from "../../src/routes/settingsRoutes.ts";
import { ttsRoutes } from "../../src/routes/ttsRoutes.ts";
import * as agentService from "../../src/services/agents/statusService.ts";
import { type JobExecutionRecord } from "../../src/services/jobExecutionQueue/repository.ts";
import * as queuedJobExecution from "../../src/services/queuedJobExecution.ts";
import * as reportService from "../../src/services/reports.ts";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
});

function setEnvironment(key: string, value: string | undefined): void {
    const original = process.env[key];
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
    cleanupCallbacks.push(() => {
        if (original === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = original;
        }
    });
}

function parameterRequest<T extends Record<string, string>>(
    route: string,
    params: T,
    init?: RequestInit
): Request & { params: T } {
    return Object.assign(new Request(`https://test.local${route}`, init), { params });
}

describe("API route error contracts", () => {
    it("validates audit pagination limits and cursors", async () => {
        const defaultPage = auditRoutes["/api/audit-events"].GET(
            new Request("https://test.local/api/audit-events")
        );
        expect(defaultPage.status).toBe(200);

        const malformedLimit = auditRoutes["/api/audit-events"].GET(
            new Request("https://test.local/api/audit-events?limit=many")
        );
        expect(malformedLimit.status).toBe(400);

        const outOfRangeLimit = auditRoutes["/api/audit-events"].GET(
            new Request("https://test.local/api/audit-events?limit=0")
        );
        expect(outOfRangeLimit.status).toBe(400);

        const invalidCursor = auditRoutes["/api/audit-events"].GET(
            new Request("https://test.local/api/audit-events?before=not-a-cursor")
        );
        expect(invalidCursor.status).toBe(400);
        expect(await invalidCursor.json()).toMatchObject({
            error: { message: "Invalid audit cursor" },
        });
    });

    it("maps report validation, missing records, and service failures", async () => {
        const invalidGet = reportRoutes["/api/reports/:id"].GET(
            parameterRequest("/api/reports/invalid", { id: "invalid" })
        );
        expect(invalidGet.status).toBe(400);

        const missingGet = reportRoutes["/api/reports/:id"].GET(
            parameterRequest("/api/reports/2147483647", { id: "2147483647" })
        );
        expect(missingGet.status).toBe(404);

        const invalidDelete = reportRoutes["/api/reports/:id"].DELETE(
            parameterRequest("/api/reports/invalid", { id: "invalid" })
        );
        expect(invalidDelete.status).toBe(400);

        const invalidCreate = await reportRoutes["/api/reports"].POST(
            new Request("https://test.local/api/reports", {
                body: JSON.stringify({ type: "unknown" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(invalidCreate.status).toBe(400);

        const listFailure = jest
            .spyOn(reportService, "listReports")
            .mockImplementationOnce(() => {
                throw new Error("Report store unavailable");
            });
        const failedList = reportRoutes["/api/reports"].GET(
            new Request("https://test.local/api/reports")
        );
        expect(failedList.status).toBe(500);
        listFailure.mockRestore();

        const lookupFailure = jest
            .spyOn(reportService, "getReport")
            .mockImplementationOnce(() => {
                throw new Error("Report store unavailable");
            });
        const failedLookup = reportRoutes["/api/reports/:id"].GET(
            parameterRequest("/api/reports/2147483647", { id: "2147483647" })
        );
        expect(failedLookup.status).toBe(500);
        lookupFailure.mockRestore();

        const deleteFailure = jest
            .spyOn(reportService, "deleteReport")
            .mockImplementationOnce(() => {
                throw new Error("Report store unavailable");
            });
        const failedDelete = reportRoutes["/api/reports/:id"].DELETE(
            parameterRequest("/api/reports/2147483647", { id: "2147483647" })
        );
        expect(failedDelete.status).toBe(500);
        deleteFailure.mockRestore();
    });

    it("maps invalid agent identifiers, missing config, and metadata failures", async () => {
        const invalidMetadata = await agentRoutes["/api/agents/:id/metadata"].PUT(
            parameterRequest(
                "/api/agents/invalid%2Fid/metadata",
                { id: "invalid/id" },
                {
                    body: JSON.stringify({ currentTask: "Ignored" }),
                    headers: { "Content-Type": "application/json" },
                    method: "PUT",
                }
            )
        );
        expect(invalidMetadata.status).toBe(400);

        const invalidStatus = await agentRoutes["/api/agents/:id/status"].GET(
            parameterRequest("/api/agents/invalid%2Fid/status", {
                id: "invalid/id",
            })
        );
        expect(invalidStatus.status).toBe(400);

        const missingConfig = jest
            .spyOn(agentService, "parseAgentsConfig")
            .mockReturnValueOnce(undefined);
        const configResponse = agentRoutes["/api/agents/config"].GET();
        expect(configResponse.status).toBe(404);
        missingConfig.mockRestore();

        const metadataFailure = jest
            .spyOn(agentService, "updateAgentCurrentTask")
            .mockRejectedValueOnce(new Error("Metadata store unavailable"));
        const failedMetadata = await agentRoutes["/api/agents/:id/metadata"].PUT(
            parameterRequest(
                "/api/agents/main/metadata",
                { id: "main" },
                {
                    body: JSON.stringify({ currentTask: "Coverage" }),
                    headers: { "Content-Type": "application/json" },
                    method: "PUT",
                }
            )
        );
        expect(failedMetadata.status).toBe(500);
        metadataFailure.mockRestore();
    });

    it("maps successful and failed queued log-rotation executions", async () => {
        const timestamp = "2026-07-29T12:00:00.000Z";
        const execution: JobExecutionRecord = {
            actionKey: "ops.log-rotation",
            attempt: 1,
            availableAt: timestamp,
            cancelRequestedAt: undefined,
            cancellable: false,
            displayName: "Log rotation dry run",
            finishedAt: timestamp,
            heartbeatAt: timestamp,
            id: Bun.randomUUIDv7(),
            leaseExpiresAt: undefined,
            leaseOwner: undefined,
            message: undefined,
            output: {
                logRotation: {
                    result: {
                        checkedFiles: 1,
                        checkedGroups: 1,
                        compressedFiles: 0,
                        deletedArchives: 0,
                        errors: [],
                        finishedAt: timestamp,
                        groups: [],
                        isDryRun: true,
                        isOk: true,
                        rotatedFiles: 0,
                        skippedFiles: 0,
                        startedAt: timestamp,
                        warnings: [],
                    },
                    stderr: "",
                },
            },
            payload: { isDryRun: true },
            priority: 50,
            queuedAt: timestamp,
            resourceClass: "host-heavy",
            scheduledJobId: undefined,
            scheduledRunId: undefined,
            startedAt: timestamp,
            status: "success",
            timeoutMs: 10 * 60 * 1000,
            triggerType: "manual",
        };
        const executionMock = jest
            .spyOn(queuedJobExecution, "enqueueAndWaitForJobExecution")
            .mockResolvedValueOnce(execution)
            .mockRejectedValueOnce(new Error("Log rotation unavailable"));

        const successful = await opsRoutes["/api/ops/log-rotation/dry-run"].POST(
            new Request("https://test.local/api/ops/log-rotation/dry-run", {
                method: "POST",
            })
        );
        expect(successful.status).toBe(200);
        expect(await successful.json()).toMatchObject({
            isSuccess: true,
            result: { isDryRun: true, isOk: true },
            stderr: "",
        });

        const failed = await opsRoutes["/api/ops/log-rotation/run"].POST(
            new Request("https://test.local/api/ops/log-rotation/run", {
                method: "POST",
            })
        );
        expect(failed.status).toBe(500);
        executionMock.mockRestore();
    });

    it("validates notification mutations before touching storage", async () => {
        const invalidCreate = await notificationRoutes["/api/notifications"].POST(
            new Request("https://test.local/api/notifications", {
                body: JSON.stringify({ title: "" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(invalidCreate.status).toBe(400);

        const invalidRead = notificationRoutes["/api/notifications/:id/read"].POST(
            parameterRequest("/api/notifications/invalid/read", {
                id: "invalid",
            })
        );
        expect(invalidRead.status).toBe(400);

        const invalidDelete = notificationRoutes["/api/notifications/:id"].DELETE(
            parameterRequest("/api/notifications/invalid", { id: "invalid" })
        );
        expect(invalidDelete.status).toBe(400);
    });

    it("maps invalid settings storage paths for reads and writes", async () => {
        setEnvironment("HOME", "/");

        const failedRead = await settingsRoutes["/api/settings"].GET();
        expect(failedRead.status).toBe(500);

        const failedWrite = await settingsRoutes["/api/settings"].PUT(
            new Request("https://test.local/api/settings", {
                body: JSON.stringify({ theme: "light" }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(failedWrite.status).toBe(500);
    });

    it("reports a missing Docker exec job consistently on stop", () => {
        const response = dockerRoutes["/api/docker/exec/:jobId/stop"].POST(
            parameterRequest("/api/docker/exec/missing/stop", {
                jobId: "missing",
            })
        );
        expect(response.status).toBe(404);
    });

    it("serves the copied Docker snapshot without host access in safe mode", async () => {
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", "1");
        setEnvironment("NODE_ENV", "test");
        const { database } = await import("../../src/database/connection.ts");
        const { writeCacheSuccess } =
            await import("../../src/services/cacheEntryWriter.ts");
        database.run("SAVEPOINT isolated_docker_route");
        try {
            writeCacheSuccess({
                data: {
                    checkedAt: "2026-07-29T16:00:00.000Z",
                    containers: [],
                    images: [],
                    updaterEvents: [],
                    updaterServices: [],
                    updaterSummary: {
                        autoPolicy: 0,
                        enabled: 0,
                        failed: 0,
                        notifyPolicy: 0,
                        total: 0,
                        updateAvailable: 0,
                    },
                    volumes: [],
                },
                key: "docker.summary",
                metadata: {},
                source: "test",
                ttl: 1,
                ttlUnit: "hours",
            });

            const response = await dockerRoutes["/api/docker/containers"].GET(
                new Request("https://test.local/api/docker/containers")
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                containers: [],
                mode: "isolated",
            });
        } finally {
            database.run("ROLLBACK TO isolated_docker_route");
            database.run("RELEASE isolated_docker_route");
        }
    });

    it("distinguishes TTS generation failures from request timeouts", async () => {
        setEnvironment("ELEVENLABS_API_KEY", "test-key");
        const fetchMock = jest
            .spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(new Error("ElevenLabs unavailable"))
            .mockRejectedValueOnce(new Error("Request aborted"));

        const failed = await ttsRoutes["/api/tts/speak"].POST(
            new Request("https://test.local/api/tts/speak", {
                body: JSON.stringify({ text: "Hello" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(failed.status).toBe(500);

        const timeoutMock = jest.spyOn(globalThis, "setTimeout").mockImplementationOnce(((
            callback: () => void
        ) => {
            callback();
            return 0;
        }) as unknown as typeof setTimeout);
        const timedOut = await ttsRoutes["/api/tts/speak"].POST(
            new Request("https://test.local/api/tts/speak", {
                body: JSON.stringify({ text: "Hello" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(timedOut.status).toBe(504);
        timeoutMock.mockRestore();
        fetchMock.mockRestore();
    });
});
