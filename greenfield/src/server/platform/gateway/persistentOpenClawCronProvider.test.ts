import { describe, expect, test } from "bun:test";

import { openClawCronPageMaximum } from "../../../contracts/openClawCron.ts";
import { createInMemoryOpenClawCronIntentStore } from "../../domains/openClawCron/intentStore.ts";
import { OpenClawCronProviderError } from "../../domains/openClawCron/provider.ts";
import {
    createOpenClawCronService,
    openClawCronHeartbeatInventoryMaximumBytes,
} from "../../domains/openClawCron/service.ts";
import type {
    PersistentGatewayAdminMethod,
    PersistentGatewayReadWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    PersistentGatewayAbortError,
    PersistentGatewayCapacityError,
    persistentGatewayCronJobChangedReason,
    PersistentGatewayRequestError,
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayRequestOptions,
    PersistentGatewayTimeoutError,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";
import {
    createPersistentOpenClawCronProvider,
    persistentOpenClawCronMutationTimeoutMs,
    persistentOpenClawCronReadTimeoutMs,
    type PersistentOpenClawCronTransport,
} from "./persistentOpenClawCronProvider.ts";

interface CapturedRequest {
    readonly lane: "admin" | "persistent";
    readonly method: string;
    readonly options?: PersistentGatewayRequestOptions;
    readonly parameters: Readonly<Record<string, unknown>>;
}

interface QueuedResponse {
    readonly method: string;
    readonly onRespond?: () => void;
    readonly value: unknown;
}

class TestPersistentOpenClawCronTransport implements PersistentOpenClawCronTransport {
    readonly calls: CapturedRequest[] = [];
    readonly responses: QueuedResponse[] = [];
    currentSnapshot: PersistentGatewayConnectionSnapshot = {
        connectedAtMs: 1_800_000_000_000,
        connectionGeneration: 7,
        phase: "connected",
        reconnectAttempt: 0,
    };

    get snapshot(): PersistentGatewayConnectionSnapshot {
        return this.currentSnapshot;
    }

    request(
        method: PersistentGatewayReadWriteMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        return this.respond({ lane: "persistent", method, options, parameters });
    }

    requestAdmin(
        method: PersistentGatewayAdminMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        return this.respond({ lane: "admin", method, options, parameters });
    }

    private respond(request: CapturedRequest): Promise<unknown> {
        this.calls.push(request);
        const response = this.responses.shift();
        if (response === undefined) {
            return Promise.reject(new Error(`Missing response for ${request.method}`));
        }
        if (response.method !== request.method) {
            return Promise.reject(
                new Error(
                    `Expected ${response.method} request, received ${request.method}`
                )
            );
        }
        response.onRespond?.();
        if (response.value instanceof Error) return Promise.reject(response.value);
        const encoded = JSON.stringify({
            id: "fixture-response",
            ok: true,
            payload: response.value,
            type: "res",
        });
        try {
            request.options?.onResponseBytes?.(Buffer.byteLength(encoded, "utf8"));
        } catch {
            // Mirrors transport bookkeeping isolation.
        }
        return Promise.resolve(response.value);
    }
}

function queue(
    transport: TestPersistentOpenClawCronTransport,
    method: string,
    value: unknown,
    onRespond?: () => void
): void {
    transport.responses.push({
        method,
        ...(onRespond === undefined ? {} : { onRespond }),
        value,
    });
}

function upstreamJob(
    id = "cron-job-1",
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        agentId: "main",
        configRevision: "definition-revision-1",
        createdAtMs: 1_800_000_000_000,
        delivery: {
            accountId: "operations",
            bestEffort: true,
            channel: "slack",
            completionDestination: {
                mode: "webhook",
                to: "https://example.test/completed",
            },
            failureDestination: {
                accountId: "alerts",
                mode: "webhook",
                to: "https://example.test/failed",
            },
            mode: "announce",
            threadId: 42,
            to: "C012345",
        },
        description: "Daily bounded operation",
        enabled: true,
        id,
        name: "Daily operation",
        payload: {
            kind: "agentTurn",
            lightContext: true,
            message: "Perform the operation",
            model: "openai/gpt-5.6-sol",
            thinking: "medium",
            timeoutSeconds: 120,
            toolsAllow: ["read"],
        },
        schedule: { expr: "0 6 * * *", kind: "cron", tz: "Europe/Oslo" },
        sessionTarget: "isolated",
        state: {
            consecutiveErrors: 0,
            lastDeliveryStatus: "delivered",
            lastDurationMs: 400,
            lastRunAtMs: 1_800_000_000_500,
            lastRunStatus: "ok",
            nextRunAtMs: 1_800_086_400_000,
        },
        updatedAtMs: 1_800_000_000_100,
        wakeMode: "now",
        ...overrides,
    };
}

function listPage(
    jobs: readonly Readonly<Record<string, unknown>>[],
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        hasMore: false,
        jobs,
        limit: Math.max(1, jobs.length),
        nextOffset: null,
        offset: 0,
        snapshotRevision: `sha256:${"a".repeat(43)}`,
        total: jobs.length,
        ...overrides,
    };
}

function runEntry(
    id = "cron-job-1",
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        deliveryStatus: "delivered",
        durationMs: 400,
        jobId: id,
        model: "gpt-5.6-sol",
        provider: "openai",
        runAtMs: 1_800_000_000_100,
        runId: "run-1",
        status: "ok",
        summary: "Completed",
        ts: 1_800_000_000_500,
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        ignoredJobName: "Daily operation",
        ...overrides,
    };
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

describe("persistent OpenClaw cron provider", () => {
    test("lists full bounded rows through the persistent lane with exact filters", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        const abortController = new AbortController();
        queue(
            transport,
            "cron.list",
            listPage([upstreamJob()], {
                hasMore: true,
                limit: 1,
                nextOffset: 1,
                total: 2,
            })
        );
        const provider = createPersistentOpenClawCronProvider(transport);

        const page = await provider.list({
            compact: false,
            enabled: "enabled",
            includeDeliveryPreviews: false,
            lastRunStatus: "ok",
            limit: 1,
            offset: 0,
            query: "daily",
            scheduleKind: "cron",
            signal: abortController.signal,
            sortBy: "name",
            sortDir: "desc",
        });

        expect(transport.calls).toEqual([
            {
                lane: "persistent",
                method: "cron.list",
                options: {
                    onResponseBytes: expect.any(Function),
                    signal: abortController.signal,
                    timeoutMs: persistentOpenClawCronReadTimeoutMs,
                },
                parameters: {
                    compact: false,
                    enabled: "enabled",
                    includeDeliveryPreviews: false,
                    lastRunStatus: "ok",
                    limit: 1,
                    offset: 0,
                    query: "daily",
                    scheduleKind: "cron",
                    sortBy: "name",
                    sortDir: "desc",
                },
            },
        ]);
        expect(page).toMatchObject({
            hasMore: true,
            limit: 1,
            nextOffset: 1,
            offset: 0,
            total: 2,
        });
        expect(page.responseBytes).toBeGreaterThan(0);
        expect(page.jobs[0]).toEqual({
            agentId: "main",
            configRevision: "definition-revision-1",
            createdAtMs: 1_800_000_000_000,
            delivery: {
                accountId: "operations",
                bestEffort: true,
                channel: "slack",
                completionDestination: {
                    mode: "webhook",
                    to: "https://example.test/completed",
                },
                failureDestination: {
                    accountId: "alerts",
                    mode: "webhook",
                    to: "https://example.test/failed",
                },
                mode: "announce",
                threadId: 42,
                to: "C012345",
            },
            description: "Daily bounded operation",
            enabled: true,
            id: "cron-job-1",
            name: "Daily operation",
            payload: {
                kind: "agentTurn",
                lightContext: true,
                message: "Perform the operation",
                model: "openai/gpt-5.6-sol",
                thinking: "medium",
                timeoutSeconds: 120,
            },
            schedule: {
                expr: "0 6 * * *",
                kind: "cron",
                tz: "Europe/Oslo",
            },
            sessionTarget: "isolated",
            state: {
                consecutiveErrors: 0,
                lastDeliveryStatus: "delivered",
                lastDurationMs: 400,
                lastRunAtMs: 1_800_000_000_500,
                lastRunStatus: "ok",
                nextRunAtMs: 1_800_086_400_000,
            },
            updatedAtMs: 1_800_000_000_100,
            wakeMode: "now",
        });
        expect(Object.isFrozen(page)).toBe(true);
        expect(Object.isFrozen(page.jobs)).toBe(true);
    });

    test("budgets raw response frames before unknown job fields are stripped", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        const padding = "x".repeat(
            Math.floor(openClawCronHeartbeatInventoryMaximumBytes / 2) + 1024
        );
        const jobs = Array.from({ length: 201 }, (_, index) =>
            upstreamJob(`cron-job-${String(index).padStart(3, "0")}`)
        );
        const firstJobs = jobs.slice(0, 100);
        firstJobs[0] = upstreamJob("cron-job-000", { ignoredPadding: padding });
        const secondJobs = jobs.slice(100, 200);
        secondJobs[0] = upstreamJob("cron-job-100", { ignoredPadding: padding });
        queue(
            transport,
            "cron.list",
            listPage(firstJobs, {
                hasMore: true,
                limit: 100,
                nextOffset: 100,
                total: jobs.length,
            })
        );
        queue(
            transport,
            "cron.list",
            listPage(secondJobs, {
                hasMore: true,
                limit: 100,
                nextOffset: 200,
                offset: 100,
                total: jobs.length,
            })
        );
        queue(
            transport,
            "cron.list",
            listPage(jobs.slice(200), {
                limit: 100,
                offset: 200,
                total: jobs.length,
            })
        );
        const service = createOpenClawCronService({
            auditRequired: false,
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider: createPersistentOpenClawCronProvider(transport),
        });

        await service.refreshHeartbeatProjection();

        expect(transport.calls.map(({ parameters }) => parameters.offset)).toEqual([
            0, 100,
        ]);
        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
    });

    test("keeps broad read-only metadata complete and deep-freezes command arrays", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        const cronExpression = "e".repeat(300);
        const timezone = "z".repeat(200);
        const model = "model/" + "m".repeat(300);
        const thinking = "t".repeat(200);
        const at = `${"2".repeat(140)}Z`;
        const deliveryTarget = `https://example.test/private?value=${"s".repeat(5000)}`;
        const deliveryAccountId = "a".repeat(300);
        const deliveryChannel = "c".repeat(300);
        const deliveryThreadId = "t".repeat(600);
        const namedSessionTarget = `agent:${"private-session".repeat(40)}`;
        queue(
            transport,
            "cron.list",
            listPage(
                [
                    upstreamJob("cron-job-1", {
                        agentId: "agent-" + "a".repeat(300),
                        delivery: {
                            accountId: deliveryAccountId,
                            channel: deliveryChannel,
                            completionDestination: {
                                mode: "webhook",
                                to: deliveryTarget,
                            },
                            failureDestination: {
                                accountId: deliveryAccountId,
                                channel: deliveryChannel,
                                mode: "webhook",
                                to: deliveryTarget,
                            },
                            mode: "announce",
                            threadId: deliveryThreadId,
                            to: deliveryTarget,
                        },
                        payload: {
                            kind: "agentTurn",
                            message: "Perform the operation",
                            model,
                            thinking,
                        },
                        schedule: {
                            expr: cronExpression,
                            kind: "cron",
                            tz: timezone,
                        },
                        sessionTarget: namedSessionTarget,
                    }),
                    upstreamJob("cron-job-2", {
                        payload: {
                            argv: ["notify", "--token=private"],
                            kind: "command",
                        },
                        schedule: {
                            command: ["watch", "--token=private"],
                            kind: "stream",
                        },
                    }),
                    upstreamJob("cron-job-3", {
                        schedule: { at, kind: "at" },
                    }),
                ],
                { limit: 3, total: 3 }
            )
        );
        const provider = createPersistentOpenClawCronProvider(transport);

        const page = await provider.list({
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 3,
            offset: 0,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        });

        expect(page.jobs[0]).toMatchObject({
            agentId: "agent-" + "a".repeat(300),
            delivery: {
                accountId: deliveryAccountId,
                channel: deliveryChannel,
                completionDestination: { to: deliveryTarget },
                failureDestination: {
                    accountId: deliveryAccountId,
                    channel: deliveryChannel,
                    to: deliveryTarget,
                },
                threadId: deliveryThreadId,
                to: deliveryTarget,
            },
            payload: { model, thinking },
            schedule: { expr: cronExpression, tz: timezone },
            sessionTarget: namedSessionTarget,
        });
        expect(page.jobs[2]?.schedule).toEqual({ at, kind: "at" });
        const commandPayload = page.jobs[1]?.payload;
        const streamSchedule = page.jobs[1]?.schedule;
        expect(commandPayload?.kind).toBe("command");
        expect(streamSchedule?.kind).toBe("stream");
        if (commandPayload?.kind !== "command" || streamSchedule?.kind !== "stream") {
            throw new Error("Expected command payload and stream schedule");
        }
        expect(Object.isFrozen(commandPayload.argv)).toBeTrue();
        expect(Object.isFrozen(streamSchedule.command)).toBeTrue();
        expect(() => {
            (commandPayload.argv as string[])[0] = "mutated";
        }).toThrow();
        expect(() => {
            (streamSchedule.command as string[])[0] = "mutated";
        }).toThrow();
        expect(commandPayload.argv[0]).toBe("notify");
        expect(streamSchedule.command[0]).toBe("watch");
    });

    test("gets one exact job and fences cached process identity to the connection generation", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(transport, "system.info", {
            hostname: "gateway-host",
            processInstanceId: "gateway-process-1",
        });
        queue(transport, "cron.get", upstreamJob());
        const provider = createPersistentOpenClawCronProvider(transport);

        expect(provider.currentProcessInstanceId()).toBeUndefined();
        expect(await provider.get({ id: "cron-job-1" })).toMatchObject({
            id: "cron-job-1",
        });
        expect(provider.currentProcessInstanceId()).toBe("gateway-process-1");
        expect(transport.calls).toEqual([
            {
                lane: "persistent",
                method: "system.info",
                options: { timeoutMs: persistentOpenClawCronReadTimeoutMs },
                parameters: {},
            },
            {
                lane: "persistent",
                method: "cron.get",
                options: { timeoutMs: persistentOpenClawCronReadTimeoutMs },
                parameters: { id: "cron-job-1" },
            },
        ]);

        transport.currentSnapshot = {
            connectedAtMs: 1_800_000_001_000,
            connectionGeneration: 8,
            phase: "connected",
            reconnectAttempt: 0,
        };
        expect(provider.currentProcessInstanceId()).toBeUndefined();
        queue(transport, "system.info", {
            processInstanceId: "gateway-process-2",
        });
        queue(transport, "cron.get", upstreamJob());
        await provider.get({ id: "cron-job-1" });
        expect(provider.currentProcessInstanceId()).toBe("gateway-process-2");
    });

    test("reads and updates heartbeat scratch on the audited admin lane", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(transport, "system.info", { processInstanceId: "gateway-process-1" });
        queue(
            transport,
            "cron.get",
            upstreamJob("heartbeat-1", { payload: { kind: "heartbeat" } })
        );
        queue(transport, "cron.scratch.get", {
            currentRevision: 4,
            maxBytes: 262_144,
            scratch: {
                content: "Check services",
                revision: 4,
                updatedAtMs: 1_800_000_000_200,
            },
        });
        queue(transport, "cron.scratch.set", {
            currentRevision: 5,
            maxBytes: 262_144,
            ok: true,
            scratch: {
                content: "Check services and disk",
                revision: 5,
                updatedAtMs: 1_800_000_000_300,
            },
        });
        const provider = createPersistentOpenClawCronProvider(transport);

        expect(await provider.get({ id: "heartbeat-1" })).toMatchObject({
            scratch: { content: "Check services", revision: 4 },
        });
        expect(
            await provider.setScratch({
                content: "Check services and disk",
                expectedRevision: 4,
                id: "heartbeat-1",
            })
        ).toEqual({ revision: 5 });
        expect(transport.calls.slice(-2)).toEqual([
            {
                lane: "admin",
                method: "cron.scratch.get",
                options: { timeoutMs: persistentOpenClawCronReadTimeoutMs },
                parameters: { id: "heartbeat-1" },
            },
            {
                lane: "admin",
                method: "cron.scratch.set",
                options: { timeoutMs: persistentOpenClawCronMutationTimeoutMs },
                parameters: {
                    content: "Check services and disk",
                    expectedRevision: 4,
                    id: "heartbeat-1",
                },
            },
        ]);
    });

    test("does not invent an empty heartbeat scratch row when none is configured", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(transport, "system.info", { processInstanceId: "gateway-process-1" });
        queue(
            transport,
            "cron.get",
            upstreamJob("heartbeat-1", { payload: { kind: "heartbeat" } })
        );
        queue(transport, "cron.scratch.get", {
            currentRevision: 0,
            maxBytes: 262_144,
            scratch: null,
        });
        const provider = createPersistentOpenClawCronProvider(transport);

        expect(await provider.get({ id: "heartbeat-1" })).not.toHaveProperty("scratch");
    });

    test("returns undefined for the audited get rejection without leaking raw text", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(transport, "system.info", {
            processInstanceId: "gateway-process-1",
        });
        queue(
            transport,
            "cron.get",
            new PersistentGatewayRequestError({ code: "INVALID_REQUEST" })
        );
        const provider = createPersistentOpenClawCronProvider(transport);

        expect(await provider.get({ id: "cron-job-1" })).toBeUndefined();
        expect(transport.calls).toHaveLength(2);
    });

    test("invalidates process fencing when the Gateway generation changes during preflight", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(transport, "system.info", {
            processInstanceId: "gateway-process-1",
        });
        queue(transport, "cron.get", upstreamJob(), () => {
            transport.currentSnapshot = {
                connectedAtMs: 1_800_000_001_000,
                connectionGeneration: 8,
                phase: "connected",
                reconnectAttempt: 0,
            };
        });
        const provider = createPersistentOpenClawCronProvider(transport);

        expect(await provider.get({ id: "cron-job-1" })).toMatchObject({
            id: "cron-job-1",
        });
        expect(provider.currentProcessInstanceId()).toBeUndefined();
    });

    test("lists one bounded job-scoped run page through the persistent lane", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(transport, "cron.runs", {
            entries: [runEntry()],
            hasMore: true,
            limit: 1,
            nextOffset: 3,
            offset: 2,
            total: 4,
        });
        const provider = createPersistentOpenClawCronProvider(transport);

        const page = await provider.listRuns({
            deliveryStatuses: ["delivered", "not-requested"],
            id: "cron-job-1",
            limit: 1,
            offset: 2,
            sortDir: "desc",
            statuses: ["ok", "error"],
        });

        expect(transport.calls).toEqual([
            {
                lane: "persistent",
                method: "cron.runs",
                options: { timeoutMs: persistentOpenClawCronReadTimeoutMs },
                parameters: {
                    deliveryStatuses: ["delivered", "not-requested"],
                    id: "cron-job-1",
                    limit: 1,
                    offset: 2,
                    scope: "job",
                    sortDir: "desc",
                    statuses: ["ok", "error"],
                },
            },
        ]);
        expect(page.entries).toEqual([
            {
                deliveryStatus: "delivered",
                durationMs: 400,
                jobId: "cron-job-1",
                model: "gpt-5.6-sol",
                provider: "openai",
                runAtMs: 1_800_000_000_100,
                runId: "run-1",
                status: "ok",
                summary: "Completed",
                ts: 1_800_000_000_500,
                usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            },
        ]);
    });

    test("uses fresh admin lanes and exact acknowledgements for update run and remove", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        queue(
            transport,
            "cron.update",
            upstreamJob("cron-job-1", {
                configRevision: "definition-revision-2",
                description: "",
                name: "Renamed operation",
            })
        );
        queue(transport, "cron.run", {
            enqueued: true,
            ok: true,
            processInstanceId: "gateway-process-1",
            runId: "run-enqueued-1",
        });
        queue(transport, "cron.run", {
            ok: true,
            ran: false,
            reason: "already-running",
        });
        queue(transport, "cron.remove", { removed: true });
        const provider = createPersistentOpenClawCronProvider(transport);

        expect(
            await provider.update({
                expectedConfigRevision: "definition-revision-1",
                id: "cron-job-1",
                patch: {
                    delivery: {
                        accountId: null,
                        bestEffort: false,
                        channel: null,
                        completionDestination: null,
                        failureDestination: {
                            accountId: null,
                            channel: null,
                            mode: null,
                            to: null,
                        },
                        mode: "announce",
                        threadId: null,
                        to: null,
                    },
                    description: null,
                    name: "Renamed operation",
                },
            })
        ).toMatchObject({
            configRevision: "definition-revision-2",
            name: "Renamed operation",
        });
        expect(
            await provider.run({
                expectedProcessInstanceId: "gateway-process-1",
                id: "cron-job-1",
                mode: "force",
            })
        ).toEqual({ processInstanceId: "gateway-process-1", ran: true });
        expect(
            await provider.run({
                expectedProcessInstanceId: "gateway-process-1",
                id: "cron-job-1",
                mode: "force",
            })
        ).toEqual({
            processInstanceId: "gateway-process-1",
            ran: false,
            reason: "already-running",
        });
        expect(await provider.remove({ id: "cron-job-1" })).toEqual({
            removed: true,
        });

        expect(transport.calls).toEqual([
            {
                lane: "admin",
                method: "cron.update",
                options: { timeoutMs: persistentOpenClawCronMutationTimeoutMs },
                parameters: {
                    expectedConfigRevision: "definition-revision-1",
                    id: "cron-job-1",
                    patch: {
                        delivery: {
                            accountId: null,
                            bestEffort: false,
                            channel: null,
                            completionDestination: null,
                            failureDestination: {
                                accountId: null,
                                channel: null,
                                mode: null,
                                to: null,
                            },
                            mode: "announce",
                            threadId: null,
                            to: null,
                        },
                        description: "",
                        name: "Renamed operation",
                    },
                },
            },
            {
                lane: "admin",
                method: "cron.run",
                options: { timeoutMs: persistentOpenClawCronMutationTimeoutMs },
                parameters: {
                    expectedProcessInstanceId: "gateway-process-1",
                    id: "cron-job-1",
                    mode: "force",
                },
            },
            {
                lane: "admin",
                method: "cron.run",
                options: { timeoutMs: persistentOpenClawCronMutationTimeoutMs },
                parameters: {
                    expectedProcessInstanceId: "gateway-process-1",
                    id: "cron-job-1",
                    mode: "force",
                },
            },
            {
                lane: "admin",
                method: "cron.remove",
                options: { timeoutMs: persistentOpenClawCronMutationTimeoutMs },
                parameters: { id: "cron-job-1" },
            },
        ]);
    });

    test("rejects malformed and inconsistent provider pages without truncating", async () => {
        for (const response of [
            { jobs: "private malformed payload" },
            listPage([upstreamJob(), upstreamJob()], { limit: 2, total: 2 }),
            listPage(
                [
                    upstreamJob("cron-job-1", {
                        delivery: {
                            mode: "announce",
                            privateDestination: "must-not-cross",
                        },
                    }),
                    upstreamJob("cron-job-2"),
                ],
                { limit: 2, total: 2 }
            ),
            listPage(
                [
                    upstreamJob("cron-job-1", {
                        delivery: { mode: "webhook" },
                    }),
                    upstreamJob("cron-job-2"),
                ],
                { limit: 2, total: 2 }
            ),
            listPage([upstreamJob()], {
                hasMore: false,
                limit: 1,
                nextOffset: null,
                total: 2,
            }),
            listPage([upstreamJob()], {
                hasMore: true,
                limit: 1,
                nextOffset: 2,
                total: 2,
            }),
            listPage([upstreamJob("x".repeat(257))]),
        ]) {
            const transport = new TestPersistentOpenClawCronTransport();
            queue(transport, "cron.list", response);
            const provider = createPersistentOpenClawCronProvider(transport);
            const error = await captureFailure(() =>
                provider.list({
                    compact: false,
                    enabled: "all",
                    includeDeliveryPreviews: false,
                    lastRunStatus: "all",
                    limit: response === undefined ? 1 : 2,
                    offset: 0,
                    scheduleKind: "all",
                    sortBy: "nextRunAtMs",
                    sortDir: "asc",
                })
            );
            expect(error).toEqual(new OpenClawCronProviderError("invalid-data"));
            expect(String(error)).not.toContain("private");
        }

        const transport = new TestPersistentOpenClawCronTransport();
        queue(
            transport,
            "cron.list",
            listPage(
                Array.from({ length: openClawCronPageMaximum + 1 }, (_, index) =>
                    upstreamJob(`cron-${index}`)
                ),
                {
                    limit: openClawCronPageMaximum,
                    total: openClawCronPageMaximum + 1,
                }
            )
        );
        const provider = createPersistentOpenClawCronProvider(transport);
        expect(
            await captureFailure(() =>
                provider.list({
                    compact: false,
                    enabled: "all",
                    includeDeliveryPreviews: false,
                    lastRunStatus: "all",
                    limit: openClawCronPageMaximum,
                    offset: 0,
                    scheduleKind: "all",
                    sortBy: "nextRunAtMs",
                    sortDir: "asc",
                })
            )
        ).toEqual(new OpenClawCronProviderError("invalid-data"));
    });

    test("rejects malformed run pages and acknowledgements safely", async () => {
        const wrongRunTransport = new TestPersistentOpenClawCronTransport();
        queue(wrongRunTransport, "cron.runs", {
            entries: [runEntry("different-job")],
            hasMore: false,
            limit: 1,
            nextOffset: null,
            offset: 0,
            total: 1,
        });
        const wrongRunProvider = createPersistentOpenClawCronProvider(wrongRunTransport);
        expect(
            await captureFailure(() =>
                wrongRunProvider.listRuns({
                    id: "cron-job-1",
                    limit: 1,
                    offset: 0,
                    sortDir: "desc",
                })
            )
        ).toEqual(new OpenClawCronProviderError("invalid-data"));

        for (const response of [
            {
                ok: true,
                processInstanceId: "gateway-process-1",
                ran: true,
                runId: "legacy-shape",
            },
            {
                enqueued: true,
                ok: true,
                processInstanceId: "gateway-process-1",
            },
            {
                enqueued: true,
                processInstanceId: "different-process",
            },
            {
                ok: true,
                ran: false,
                reason: "private-future-reason",
            },
        ]) {
            const transport = new TestPersistentOpenClawCronTransport();
            queue(transport, "cron.run", response);
            const provider = createPersistentOpenClawCronProvider(transport);
            const error = await captureFailure(() =>
                provider.run({
                    expectedProcessInstanceId: "gateway-process-1",
                    id: "cron-job-1",
                    mode: "force",
                })
            );
            expect(error).toEqual(new OpenClawCronProviderError("unknown-outcome"));
            expect(String(error)).not.toContain("private");
        }

        const removeTransport = new TestPersistentOpenClawCronTransport();
        queue(removeTransport, "cron.remove", { ok: true, removed: false });
        const removeProvider = createPersistentOpenClawCronProvider(removeTransport);
        expect(
            await captureFailure(() => removeProvider.remove({ id: "cron-job-1" }))
        ).toEqual(new OpenClawCronProviderError("unknown-outcome"));

        const updateTransport = new TestPersistentOpenClawCronTransport();
        queue(updateTransport, "cron.update", upstreamJob("different-job"));
        const updateProvider = createPersistentOpenClawCronProvider(updateTransport);
        expect(
            await captureFailure(() =>
                updateProvider.update({
                    expectedConfigRevision: "definition-revision-1",
                    id: "cron-job-1",
                    patch: { enabled: false },
                })
            )
        ).toEqual(new OpenClawCronProviderError("unknown-outcome"));
    });

    test("maps audited conflicts and ambiguous mutations to sanitized provider errors", async () => {
        const conflictTransport = new TestPersistentOpenClawCronTransport();
        queue(
            conflictTransport,
            "cron.update",
            new PersistentGatewayRequestError({
                code: "INVALID_REQUEST",
                reason: persistentGatewayCronJobChangedReason,
            })
        );
        const conflictProvider = createPersistentOpenClawCronProvider(conflictTransport);
        expect(
            await captureFailure(() =>
                conflictProvider.update({
                    expectedConfigRevision: "definition-revision-1",
                    id: "cron-job-1",
                    patch: { enabled: false },
                })
            )
        ).toEqual(new OpenClawCronProviderError("conflict"));

        const timeoutTransport = new TestPersistentOpenClawCronTransport();
        queue(
            timeoutTransport,
            "cron.remove",
            new PersistentGatewayTimeoutError("cron.remove")
        );
        const timeoutProvider = createPersistentOpenClawCronProvider(timeoutTransport);
        expect(
            await captureFailure(() => timeoutProvider.remove({ id: "cron-job-1" }))
        ).toEqual(new OpenClawCronProviderError("unavailable"));

        for (const operation of ["remove", "run", "set-scratch", "update"] as const) {
            const method =
                operation === "set-scratch" ? "cron.scratch.set" : `cron.${operation}`;
            const abortTransport = new TestPersistentOpenClawCronTransport();
            queue(abortTransport, method, new PersistentGatewayAbortError());
            const abortProvider = createPersistentOpenClawCronProvider(abortTransport);
            let work: () => Promise<unknown>;
            if (operation === "remove") {
                work = () => abortProvider.remove({ id: "cron-job-1" });
            } else if (operation === "run") {
                work = () =>
                    abortProvider.run({
                        expectedProcessInstanceId: "gateway-process-1",
                        id: "cron-job-1",
                        mode: "force",
                    });
            } else if (operation === "set-scratch") {
                work = () =>
                    abortProvider.setScratch({
                        content: "updated scratch",
                        expectedRevision: 7,
                        id: "cron-job-1",
                    });
            } else {
                work = () =>
                    abortProvider.update({
                        expectedConfigRevision: "definition-revision-1",
                        id: "cron-job-1",
                        patch: { enabled: false },
                    });
            }
            expect(await captureFailure(work)).toEqual(
                new OpenClawCronProviderError("unavailable")
            );

            const unknownTransport = new TestPersistentOpenClawCronTransport();
            queue(unknownTransport, method, new PersistentGatewayUnknownOutcomeError());
            const unknownProvider =
                createPersistentOpenClawCronProvider(unknownTransport);
            let unknownWork: () => Promise<unknown>;
            if (operation === "remove") {
                unknownWork = () => unknownProvider.remove({ id: "cron-job-1" });
            } else if (operation === "run") {
                unknownWork = () =>
                    unknownProvider.run({
                        expectedProcessInstanceId: "gateway-process-1",
                        id: "cron-job-1",
                        mode: "force",
                    });
            } else if (operation === "set-scratch") {
                unknownWork = () =>
                    unknownProvider.setScratch({
                        content: "updated scratch",
                        expectedRevision: 7,
                        id: "cron-job-1",
                    });
            } else {
                unknownWork = () =>
                    unknownProvider.update({
                        expectedConfigRevision: "definition-revision-1",
                        id: "cron-job-1",
                        patch: { enabled: false },
                    });
            }
            expect(await captureFailure(unknownWork)).toEqual(
                new OpenClawCronProviderError("unknown-outcome")
            );
        }

        const capacityTransport = new TestPersistentOpenClawCronTransport();
        queue(capacityTransport, "cron.run", new PersistentGatewayCapacityError());
        const capacityProvider = createPersistentOpenClawCronProvider(capacityTransport);
        expect(
            await captureFailure(() =>
                capacityProvider.run({
                    expectedProcessInstanceId: "gateway-process-1",
                    id: "cron-job-1",
                    mode: "force",
                })
            )
        ).toEqual(new OpenClawCronProviderError("unavailable"));
    });

    test("honors caller abort without exposing the abort reason or touching transport", async () => {
        const transport = new TestPersistentOpenClawCronTransport();
        const abortController = new AbortController();
        abortController.abort("private caller reason");
        const provider = createPersistentOpenClawCronProvider(transport);

        const error = await captureFailure(() =>
            provider.list({
                compact: false,
                enabled: "all",
                includeDeliveryPreviews: false,
                lastRunStatus: "all",
                limit: 50,
                offset: 0,
                scheduleKind: "all",
                signal: abortController.signal,
                sortBy: "nextRunAtMs",
                sortDir: "asc",
            })
        );
        expect(error).toBeInstanceOf(PersistentGatewayAbortError);
        expect(String(error)).not.toContain("private");
        expect(transport.calls).toHaveLength(0);
    });
});
