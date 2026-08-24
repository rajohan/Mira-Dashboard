import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createChatRepository } from "../../domains/chat/repository.ts";
import { createChatService, ChatServiceError } from "../../domains/chat/service.ts";
import { createInMemoryOpenClawCronIntentStore } from "../../domains/openClawCron/intentStore.ts";
import { createOpenClawCronService } from "../../domains/openClawCron/service.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { captureFailure, rejectOnAbort } from "../../test/support/promise.ts";
import { createInMemoryChatMediaReferences } from "../chat/inMemoryChatMediaReferences.ts";
import { createPersistentGatewayChatProvider } from "./persistentGatewayChatProvider.ts";
import {
    persistentGatewayAdminMethods,
    persistentGatewayChatReadMutationMethods,
    persistentGatewayChatWriteMethods,
    persistentGatewayOpenClawSettingsWriteMethods,
    persistentGatewayTaskWriteMethods,
} from "./persistentGatewayProtocol.ts";
import {
    PersistentGatewayCapacityError,
    PersistentGatewayRequestError,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";
import { createPersistentOpenClawCronProvider } from "./persistentOpenClawCronProvider.ts";
import {
    createSourceDevelopmentChatWriteCapability,
    createSourceDevelopmentGatewayTransport,
} from "./sourceDevelopmentGatewayTransport.ts";

const temporaryRoots: string[] = [];

function authorizeDispatch(): Promise<void> {
    return Promise.resolve();
}

afterEach(async () => {
    await Promise.all(
        temporaryRoots
            .splice(0)
            .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true }))
    );
});

async function developmentStateRoot(): Promise<string> {
    const stateRoot = await mkdtemp(
        path.join(tmpdir(), "mira-dashboard-source-gateway-")
    );
    temporaryRoots.push(stateRoot);
    await writeFile(
        path.join(stateRoot, ".mira-dashboard-development-state.json"),
        JSON.stringify({
            formatVersion: 1,
            owner: "mira-dashboard-source-development-v1",
        }),
        { mode: 0o600 }
    );
    return stateRoot;
}

function readTransport(calls: string[]): PersistentGatewayTransport {
    const unavailableWrite = (method: string): Promise<never> => {
        calls.push(`REAL-WRITE:${method}`);
        return Promise.reject(new Error("Real write lane was reached"));
    };
    const transport: PersistentGatewayTransport = {
        snapshot: Object.freeze({
            connectionGeneration: 7,
            phase: "connected" as const,
            reconnectAttempt: 0,
        }),
        request(method) {
            calls.push(`read:${method}`);
            return Promise.resolve(
                method === "system.info"
                    ? { processInstanceId: "live-process" }
                    : Object.freeze({})
            );
        },
        requestAdmin(method) {
            if (method === "cron.scratch.get") {
                calls.push(`read:${method}`);
                return Promise.resolve({
                    currentRevision: 0,
                    maxBytes: 64 * 1024,
                    scratch: null,
                });
            }
            return unavailableWrite(method);
        },
        requestChatRead(method) {
            calls.push(`read:${method}`);
            return Promise.resolve(Object.freeze({ exchanges: Object.freeze([]) }));
        },
        requestChatReadMutation: (method) => unavailableWrite(method),
        requestChatWrite: (method) => unavailableWrite(method),
        requestOpenClawSettingsRead(method) {
            calls.push(`read:${method}`);
            return Promise.resolve(
                method === "config.get"
                    ? Object.freeze({
                          config: Object.freeze({
                              agents: Object.freeze({
                                  defaults: Object.freeze({
                                      heartbeat: Object.freeze({ every: "60s" }),
                                  }),
                              }),
                          }),
                          configRevisionHash: "A".repeat(42) + "A",
                          hash: "a".repeat(64),
                          includedPaths: Object.freeze([]),
                          issues: Object.freeze([]),
                          legacyIssues: Object.freeze([]),
                          parsed: Object.freeze({}),
                          sourceConfig: Object.freeze({}),
                          valid: true,
                      })
                    : Object.freeze({ skills: Object.freeze([]) })
            );
        },
        requestOpenClawSettingsWrite: (method) => unavailableWrite(method),
        requestTaskRead(method) {
            calls.push(`read:${method}`);
            return Promise.resolve(Object.freeze({ tasks: Object.freeze([]) }));
        },
        requestTaskWrite: (method) => unavailableWrite(method),
        start() {
            calls.push("read:start");
        },
        stop() {
            calls.push("read:stop");
            return Promise.resolve();
        },
        subscribe() {
            return () => {};
        },
        subscribeChat() {
            return () => {};
        },
    };
    return Object.freeze(transport);
}

function upstreamCronJob(id = "cron-1"): Readonly<Record<string, unknown>> {
    return Object.freeze({
        configRevision: "revision-1",
        createdAtMs: 1_800_000_000_000,
        enabled: true,
        id,
        name: `Development cron ${id}`,
        payload: Object.freeze({
            kind: "agentTurn",
            message: "Exercise development parity.",
        }),
        schedule: Object.freeze({
            expr: "0 7 * * *",
            kind: "cron",
            tz: "Europe/Oslo",
        }),
        sessionTarget: "isolated",
        state: Object.freeze({ nextRunAtMs: 1_800_086_400_000 }),
        updatedAtMs: 1_800_000_000_100,
        wakeMode: "now",
    });
}

function cronReadTransport(
    calls: string[],
    jobs: readonly Readonly<Record<string, unknown>>[] = [upstreamCronJob()],
    listRequests: Array<Readonly<{ limit: number; offset: number }>> = [],
    listRequestOptions: PersistentGatewayRequestOptions[] = []
): PersistentGatewayTransport {
    const base = readTransport(calls);
    const request: PersistentGatewayTransport["request"] = (
        method,
        parameters,
        options
    ) => {
        calls.push(`read:${method}`);
        let response: unknown = Object.freeze({});
        if (method === "system.info") {
            response = Object.freeze({ processInstanceId: "live-process" });
        } else if (method === "cron.get") {
            response =
                jobs.find((job) => asTestRecord(job).id === parameters.id) ??
                Object.freeze({});
        } else if (method === "cron.list") {
            const limit = Number(parameters.limit);
            const offset = Number(parameters.offset);
            listRequests.push(Object.freeze({ limit, offset }));
            listRequestOptions.push(options ?? {});
            const pageJobs = jobs.slice(offset, offset + limit);
            const consumed = offset + pageJobs.length;
            const hasMore = consumed < jobs.length;
            response = Object.freeze({
                hasMore,
                jobs: Object.freeze(pageJobs),
                limit,
                nextOffset: hasMore ? consumed : null,
                offset,
                snapshotRevision: `sha256:${"a".repeat(40)}${String(jobs.length).padStart(3, "0")}`,
                total: jobs.length,
            });
        }
        options?.onResponseBytes?.(Buffer.byteLength(JSON.stringify(response), "utf8"));
        return Promise.resolve(response);
    };
    return Object.freeze({
        ...base,
        request,
    });
}

function asTestRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Readonly<Record<string, unknown>>;
}

describe("source-development Gateway transport", () => {
    test("replaces an expired chat write capability", async () => {
        const stateRoot = await developmentStateRoot();
        const expired = createSourceDevelopmentChatWriteCapability({
            expiresAtMs: 1_800_000_001_000,
            nowMs: 1_800_000_000_000,
            sessionKey: "agent:main:expired",
            stateRoot,
        });
        const replacement = createSourceDevelopmentChatWriteCapability({
            expiresAtMs: 1_800_000_061_000,
            nowMs: 1_800_000_001_000,
            sessionKey: "agent:main:replacement",
            stateRoot,
        });
        expired.revoke();
        expect(() =>
            createSourceDevelopmentChatWriteCapability({
                expiresAtMs: 1_800_000_062_000,
                nowMs: 1_800_000_002_000,
                sessionKey: "agent:main:blocked-by-replacement",
                stateRoot,
            })
        ).toThrow();
        replacement.revoke();
    });

    test("delegates chat writes only for one short-lived E2E session capability", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const base = readTransport(calls);
        const live = Object.freeze({
            ...base,
            requestChatWrite(method: "chat.abort" | "chat.send") {
                calls.push(`REAL-WRITE:${method}`);
                return Promise.resolve(
                    method === "chat.send"
                        ? Object.freeze({ runId: "provider-run-1", status: "started" })
                        : Object.freeze({
                              aborted: true,
                              ok: true,
                              runIds: ["provider-run-1"],
                          })
                );
            },
        }) satisfies PersistentGatewayTransport;
        const transport = createSourceDevelopmentGatewayTransport({
            nowMs: () => 1_800_000_000_000,
            readTransport: live,
            stateRoot,
        });
        const capability = createSourceDevelopmentChatWriteCapability({
            expiresAtMs: 1_800_000_060_000,
            nowMs: 1_800_000_000_000,
            sessionKey: "agent:main:chat-e2e-openai",
            stateRoot,
        });

        expect(
            await transport.requestChatWrite("chat.send", {
                attachments: [],
                idempotencyKey: "a".repeat(32),
                message: "browser E2E message",
                sessionKey: "agent:main:chat-e2e-openai",
            })
        ).toEqual({ runId: "provider-run-1", status: "started" });
        const unauthorized = await captureFailure(() =>
            transport.requestChatWrite("chat.send", {
                attachments: [],
                idempotencyKey: "b".repeat(32),
                message: "wrong session",
                sessionKey: "agent:main:main",
            })
        );
        expect(unauthorized).toMatchObject({ code: "UNAVAILABLE" });

        capability.revoke();
        const revoked = await captureFailure(() =>
            transport.requestChatWrite("chat.send", {
                attachments: [],
                idempotencyKey: "c".repeat(32),
                message: "revoked session",
                sessionKey: "agent:main:chat-e2e-openai",
            })
        );
        expect(revoked).toMatchObject({ code: "UNAVAILABLE" });
        expect(calls.filter((call) => call === "REAL-WRITE:chat.send")).toHaveLength(1);
    });

    test("keeps simulated cron deletion authoritative for service readback and inventory", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const transport = createSourceDevelopmentGatewayTransport({
            nowMs: () => 1_800_000_001_000,
            readTransport: cronReadTransport(calls),
            stateRoot,
        });
        const provider = createPersistentOpenClawCronProvider(transport);
        const service = createOpenClawCronService({
            auditRequired: false,
            clock: () => 1_800_000_001_000,
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider,
        });

        expect(
            await service.delete(
                { expectedConfigRevision: "revision-1", id: "cron-1" },
                {
                    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                    kind: "user",
                }
            )
        ).toEqual({
            deleted: true,
            id: "cron-1",
            observedAtMs: 1_800_000_001_000,
        });
        expect(await provider.get({ id: "cron-1" })).toBeUndefined();
        expect(
            await provider.list({
                compact: false,
                enabled: "all",
                includeDeliveryPreviews: false,
                lastRunStatus: "all",
                limit: 50,
                offset: 0,
                scheduleKind: "all",
                sortBy: "nextRunAtMs",
                sortDir: "asc",
            })
        ).toMatchObject({
            hasMore: false,
            jobs: [],
            nextOffset: null,
            total: 0,
        });
        expect(calls).toEqual(["read:system.info", "read:cron.get", "read:cron.list"]);
        expect(calls.some((call) => call.startsWith("REAL-WRITE:"))).toBeFalse();
    });

    test("materializes filtered cron pagination without duplicating the item after a tombstone", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const listRequests: Array<Readonly<{ limit: number; offset: number }>> = [];
        const jobs = Array.from({ length: 101 }, (_, index) =>
            upstreamCronJob(`cron-${String(index).padStart(3, "0")}`)
        );
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: cronReadTransport(calls, jobs, listRequests),
            stateRoot,
        });
        const provider = createPersistentOpenClawCronProvider(transport);
        await transport.requestAdmin("cron.remove", { id: "cron-000" });
        const input = {
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 100,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        } as const;

        const first = await provider.list({ ...input, offset: 0 });
        const second = await provider.list({ ...input, offset: 100 });
        const firstIds = first.jobs.map(({ id }) => id);
        const secondIds = second.jobs.map(({ id }) => id);

        expect(firstIds).toEqual(
            jobs.slice(1).map((job) => String(asTestRecord(job).id))
        );
        expect(secondIds).toEqual([]);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(100);
        expect(first).toMatchObject({
            hasMore: false,
            limit: 100,
            nextOffset: null,
            offset: 0,
            total: 100,
        });
        expect(second).toMatchObject({
            hasMore: false,
            limit: 100,
            nextOffset: null,
            offset: 100,
            total: 100,
        });
        expect(first.snapshotRevision).toBe(second.snapshotRevision);
        expect(first.snapshotRevision).not.toBe(`sha256:${"a".repeat(43)}`);
        expect(listRequests).toEqual([
            { limit: 100, offset: 0 },
            { limit: 100, offset: 100 },
            { limit: 100, offset: 0 },
            { limit: 100, offset: 100 },
        ]);
        expect(calls).toEqual([
            "read:cron.list",
            "read:cron.list",
            "read:cron.list",
            "read:cron.list",
        ]);
        expect(calls.some((call) => call.startsWith("REAL-WRITE:"))).toBeFalse();
    });

    test("keeps arbitrary offsets independent while another same-filter read is active", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const listRequests: Array<Readonly<{ limit: number; offset: number }>> = [];
        const jobs = Array.from({ length: 151 }, (_, index) =>
            upstreamCronJob(`cron-${String(index).padStart(3, "0")}`)
        );
        const upstream = cronReadTransport(calls, jobs, listRequests);
        const firstRequestStarted = Promise.withResolvers<void>();
        const releaseFirstRequest = Promise.withResolvers<void>();
        let holdFirstRequest = true;
        const request: PersistentGatewayTransport["request"] = async (
            method,
            parameters,
            options
        ) => {
            if (method === "cron.list" && holdFirstRequest) {
                holdFirstRequest = false;
                firstRequestStarted.resolve();
                await releaseFirstRequest.promise;
            }
            return await upstream.request(method, parameters, options);
        };
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: Object.freeze({ ...upstream, request }),
            stateRoot,
        });
        const provider = createPersistentOpenClawCronProvider(transport);
        const input = {
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 100,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        } as const;

        const firstPending = provider.list({ ...input, offset: 0 });
        await firstRequestStarted.promise;
        let independent: Awaited<ReturnType<typeof provider.list>>;
        try {
            independent = await provider.list({ ...input, limit: 50, offset: 50 });
        } finally {
            releaseFirstRequest.resolve();
        }
        const first = await firstPending;

        expect(first).toMatchObject({
            hasMore: true,
            nextOffset: 100,
            offset: 0,
            total: 151,
        });
        expect(independent).toMatchObject({
            hasMore: true,
            nextOffset: 100,
            offset: 50,
            total: 151,
        });
        expect(independent.jobs.map(({ id }) => id)).toEqual(
            jobs.slice(50, 100).map((job) => String(asTestRecord(job).id))
        );
        expect(independent.snapshotRevision).toBe(first.snapshotRevision);
        expect(listRequests).toEqual([
            { limit: 100, offset: 0 },
            { limit: 100, offset: 100 },
            { limit: 100, offset: 0 },
            { limit: 100, offset: 100 },
        ]);
        expect(calls).toEqual([
            "read:cron.list",
            "read:cron.list",
            "read:cron.list",
            "read:cron.list",
        ]);
    });

    test("keeps one caller cancellation from poisoning another cron inventory read", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const jobs = Array.from({ length: 101 }, (_, index) =>
            upstreamCronJob(`cron-${String(index).padStart(3, "0")}`)
        );
        const upstream = cronReadTransport(calls, jobs);
        const firstRequestStarted = Promise.withResolvers<void>();
        let holdFirstRequest = true;
        const request: PersistentGatewayTransport["request"] = async (
            method,
            parameters,
            options
        ) => {
            if (method === "cron.list" && holdFirstRequest) {
                holdFirstRequest = false;
                firstRequestStarted.resolve();
                const signal = options?.signal;
                if (signal === undefined) throw new Error("Expected a bounded cron read");
                await rejectOnAbort(signal, "Cron read was not cancelled");
            }
            return await upstream.request(method, parameters, options);
        };
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: Object.freeze({ ...upstream, request }),
            stateRoot,
        });
        const provider = createPersistentOpenClawCronProvider(transport);
        const controller = new AbortController();
        const input = {
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 100,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        } as const;

        const cancelledPending = provider.list({
            ...input,
            offset: 0,
            signal: controller.signal,
        });
        await firstRequestStarted.promise;
        const independent = await provider.list({ ...input, offset: 0 });
        controller.abort(new Error("cancel first cron read"));
        const cancellation = await captureFailure(() => cancelledPending);

        expect(independent).toMatchObject({
            hasMore: true,
            nextOffset: 100,
            total: 101,
        });
        expect(cancellation).toBeInstanceOf(Error);
        expect(calls).toEqual(["read:cron.list", "read:cron.list"]);
    });

    test("bounds aggregate cron materialization and releases admission after abort", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const upstream = cronReadTransport(calls);
        const allRequestsStarted = Promise.withResolvers<void>();
        const startedSignals: AbortSignal[] = [];
        let holdRequests = true;
        const request: PersistentGatewayTransport["request"] = async (
            method,
            parameters,
            options
        ) => {
            if (method === "cron.list" && holdRequests) {
                const signal = options?.signal;
                if (signal === undefined)
                    throw new Error("Expected a cancellable cron read");
                startedSignals.push(signal);
                if (startedSignals.length === 4) allRequestsStarted.resolve();
                await rejectOnAbort(signal, "Cron capacity fixture was not cancelled");
            }
            return await upstream.request(method, parameters, options);
        };
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: Object.freeze({ ...upstream, request }),
            stateRoot,
        });
        const parameters = {
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 100,
            offset: 0,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        } as const;
        const controllers = Array.from({ length: 4 }, () => new AbortController());
        const activeOutcomes = controllers.map((controller) =>
            captureFailure(() =>
                transport.request("cron.list", parameters, {
                    signal: controller.signal,
                })
            )
        );

        await allRequestsStarted.promise;
        const capacityFailure = await captureFailure(() =>
            transport.request("cron.list", parameters)
        );
        holdRequests = false;
        for (const controller of controllers) {
            controller.abort(new Error("release cron materialization"));
        }
        const aborted = await Promise.all(activeOutcomes);
        const recovered = asTestRecord(await transport.request("cron.list", parameters));

        expect(capacityFailure).toBeInstanceOf(PersistentGatewayCapacityError);
        expect(new Set(startedSignals).size).toBe(4);
        expect(aborted.every((failure) => failure instanceof Error)).toBeTrue();
        expect(recovered.total).toBe(1);
        expect(calls).toEqual(["read:cron.list"]);
    });

    test("applies a simulated deletion to an already materializing cron read", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const jobs = Array.from({ length: 101 }, (_, index) =>
            upstreamCronJob(`cron-${String(index).padStart(3, "0")}`)
        );
        const upstream = cronReadTransport(calls, jobs);
        const firstPageCaptured = Promise.withResolvers<void>();
        const releaseFirstPage = Promise.withResolvers<void>();
        let holdFirstPage = true;
        const request: PersistentGatewayTransport["request"] = async (
            method,
            parameters,
            options
        ) => {
            const response = await upstream.request(method, parameters, options);
            if (method === "cron.list" && holdFirstPage) {
                holdFirstPage = false;
                firstPageCaptured.resolve();
                await releaseFirstPage.promise;
            }
            return response;
        };
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: Object.freeze({ ...upstream, request }),
            stateRoot,
        });
        const provider = createPersistentOpenClawCronProvider(transport);
        const input = {
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 100,
            offset: 0,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        } as const;

        const listPending = provider.list(input);
        await firstPageCaptured.promise;
        try {
            await transport.requestAdmin("cron.remove", { id: "cron-000" });
        } finally {
            releaseFirstPage.resolve();
        }
        const page = await listPending;

        expect(page).toMatchObject({
            hasMore: false,
            nextOffset: null,
            total: 100,
        });
        expect(page.jobs.map(({ id }) => id)).not.toContain("cron-000");
        expect(page.jobs).toHaveLength(100);
    });

    test("reports upstream revision drift instead of mixing unrelated offset walks", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const liveJobs = Array.from({ length: 101 }, (_, index) =>
            upstreamCronJob(`cron-${String(index).padStart(3, "0")}`)
        );
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: cronReadTransport(calls, liveJobs),
            stateRoot,
        });
        const provider = createPersistentOpenClawCronProvider(transport);
        const input = {
            compact: false,
            enabled: "all",
            includeDeliveryPreviews: false,
            lastRunStatus: "all",
            limit: 100,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        } as const;

        const first = await provider.list({ ...input, offset: 0 });
        liveJobs.push(upstreamCronJob("cron-101"));
        const continuation = await provider.list({ ...input, offset: 100 });

        expect(first).toMatchObject({
            nextOffset: 100,
            offset: 0,
            total: 101,
        });
        expect(continuation).toMatchObject({
            hasMore: false,
            nextOffset: null,
            offset: 100,
            total: 102,
        });
        expect(continuation.jobs.map(({ id }) => id)).toEqual(["cron-100", "cron-101"]);
        expect(continuation.snapshotRevision).not.toBe(first.snapshotRevision);
        expect(calls).toEqual([
            "read:cron.list",
            "read:cron.list",
            "read:cron.list",
            "read:cron.list",
        ]);
    });

    test("definitively fails source-development chat sends without leaving active runs", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const transport = createSourceDevelopmentGatewayTransport({
            nowMs: () => 1_800_000_000_000,
            readTransport: readTransport(calls),
            stateRoot,
        });
        const mediaReferences = createInMemoryChatMediaReferences();
        const database = await openFreshMigratedDatabase();
        const repository = createChatRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission,
            "main",
            () => 1_800_000_000_000
        );
        const service = createChatService({
            attachmentConsumer: {
                reserve: () =>
                    Promise.reject(
                        new Error("Attachment reservation is not used by this test")
                    ),
            },
            attachmentPreparer: {
                prepare: () =>
                    Promise.reject(
                        new Error("Attachment preparation is not used by this test")
                    ),
            },
            nowMs: () => 1_800_000_000_000,
            provider: createPersistentGatewayChatProvider(transport, mediaReferences),
            repository,
        });
        const sends = [
            {
                clientRunId: "019fe5a1-6cb9-7e51-ad2a-bf1f69861218",
                idempotencyKey: "A".repeat(32),
                message: "first private dev message",
            },
            {
                clientRunId: "019fe5a1-6cb9-7e51-ad2a-bf1f69861219",
                idempotencyKey: "B".repeat(32),
                message: "second private dev message",
            },
        ] as const;

        try {
            for (const send of sends) {
                const failure = await captureFailure(() =>
                    service.send(
                        { ...send, sessionKey: "agent:main:main" },
                        {
                            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                            kind: "user",
                        }
                    )
                );
                expect(failure).toBeInstanceOf(ChatServiceError);
                expect(failure).toMatchObject({ reason: "provider-unavailable" });
                const failedRun = repository.findRun(send.clientRunId);
                expect(failedRun).toMatchObject({ state: "failed" });
                expect(failedRun?.providerRunId).toBeUndefined();
            }

            const runtime = await service.runtime({
                afterCursor: "0",
                afterTranscriptGeneration: 0,
                limit: 128,
                sessionKey: "agent:main:main",
            });
            expect(runtime.externalRuns).toEqual([]);
            expect(runtime.runs.map(({ run }) => run.state)).toEqual([
                "failed",
                "failed",
            ]);
            expect(repository.listProviderRunWatermarks("agent:main:main")).toEqual([]);
            expect(calls.some((call) => call.startsWith("REAL-WRITE:"))).toBeFalse();

            const journal = await readFile(
                path.join(
                    stateRoot,
                    "development-authority-simulator",
                    "gateway-mutations.ndjson"
                ),
                "utf8"
            );
            const receipts = journal
                .trim()
                .split("\n")
                .map((line) => (JSON.parse(line) as { method: string }).method);
            expect(receipts).toEqual(["chat.send", "chat.send"]);
            expect(journal).not.toContain("first private dev message");
            expect(journal).not.toContain("second private dev message");
            expect(journal).not.toContain("agent:main:main");
        } finally {
            await service.dispose();
            mediaReferences.dispose();
            database.sqlite.close(true);
        }
    });

    test("delegates reads but simulates every write method under marked development state", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const transport = createSourceDevelopmentGatewayTransport({
            nowMs: () => 1_800_000_000_000,
            readTransport: readTransport(calls),
            stateRoot,
        });

        expect(await transport.request("system.info", {})).toEqual({
            processInstanceId: "live-process",
        });
        const chatSendFailure = await captureFailure(() =>
            transport.requestChatWrite("chat.send", {
                attachments: [],
                idempotencyKey: "a".repeat(32),
                message: "private dev message",
                sessionKey: "agent:main:main",
            })
        );
        expect(chatSendFailure).toBeInstanceOf(PersistentGatewayRequestError);
        expect(chatSendFailure).toMatchObject({ code: "UNAVAILABLE" });
        await transport.requestChatWrite("chat.abort", {
            preserveSideRuns: false,
            runId: "provider-run-1",
            sessionKey: "agent:main:main",
        });
        await transport.requestChatWrite("sessions.companion.reset", {
            sessionKey: "agent:main:main",
        });
        await transport.requestChatReadMutation("sessions.companion.ask", {
            question: "What changed?",
            sessionKey: "agent:main:main",
        });
        await transport.requestAdmin("cron.remove", { id: "cron-1" });
        await transport.requestAdmin("cron.run", {
            expectedProcessInstanceId: "live-process",
            id: "cron-1",
            mode: "force",
        });
        await transport.requestAdmin("cron.scratch.get", { id: "cron-1" });
        await transport.requestAdmin("cron.scratch.set", {
            content: "reviewed scratch",
            expectedRevision: 0,
            id: "cron-1",
        });
        expect(
            await transport.requestAdmin("cron.scratch.get", { id: "cron-1" })
        ).toEqual({
            currentRevision: 1,
            maxBytes: 64 * 1024,
            scratch: {
                content: "reviewed scratch",
                revision: 1,
                updatedAtMs: 1_800_000_000_000,
            },
        });
        await transport.requestAdmin("cron.update", {
            expectedConfigRevision: "revision-1",
            id: "cron-1",
            patch: { enabled: false },
        });
        await transport.requestAdmin("sessions.compact", {
            key: "agent:main:main",
        });
        await transport.requestAdmin("sessions.delete", {
            deleteTranscript: true,
            expectedSessionId: "session-1",
            key: "agent:main:main",
        });
        await transport.requestAdmin("sessions.patch", {
            agentId: "main",
            expectedSessionId: "session-1",
            key: "agent:main:main",
            thinkingLevel: "high",
        });
        expect(
            await transport.requestAdmin("sessions.reset", {
                key: "agent:main:main",
                reason: "reset",
            })
        ).toEqual({ key: "agent:main:main", ok: true });
        expect(
            await transport.requestTaskWrite("tasks.cancel", {
                taskId: "task-1",
            })
        ).toEqual({
            cancelled: true,
            found: true,
            task: {
                id: "task-1",
                status: "cancelled",
                updatedAt: 1_800_000_000_000,
            },
        });

        await transport.requestOpenClawSettingsRead("config.get", {});
        await transport.requestOpenClawSettingsWrite(
            "config.patch",
            {
                baseHash: "a".repeat(64),
                note: "Updated from Mira Dashboard settings",
                raw: JSON.stringify({
                    agents: { defaults: { heartbeat: { every: "120s" } } },
                }),
            },
            { beforeDispatch: authorizeDispatch }
        );
        await transport.requestOpenClawSettingsWrite(
            "skills.update",
            { enabled: false, skillKey: "imagegen" },
            { beforeDispatch: authorizeDispatch }
        );

        expect(calls.some((call) => call.startsWith("REAL-WRITE:"))).toBeFalse();
        const journal = await readFile(
            path.join(
                stateRoot,
                "development-authority-simulator",
                "gateway-mutations.ndjson"
            ),
            "utf8"
        );
        const journalMethods = journal
            .trim()
            .split("\n")
            .map((line) => (JSON.parse(line) as { method: string }).method)
            .toSorted();
        expect(journalMethods).toEqual(
            [
                ...persistentGatewayAdminMethods.filter(
                    (method) => method !== "cron.scratch.get"
                ),
                ...persistentGatewayChatReadMutationMethods,
                ...persistentGatewayChatWriteMethods,
                ...persistentGatewayOpenClawSettingsWriteMethods,
                ...persistentGatewayTaskWriteMethods,
            ].toSorted()
        );
        expect(journal).not.toContain("private dev message");
        expect(journal).not.toContain("agent:main:main");
    });

    test("overlays simulated settings mutations without dispatching a real admin request", async () => {
        const stateRoot = await developmentStateRoot();
        const calls: string[] = [];
        const transport = createSourceDevelopmentGatewayTransport({
            readTransport: readTransport(calls),
            stateRoot,
        });
        await transport.requestOpenClawSettingsRead("config.get", {});
        let authorized = false;
        const acknowledgement = await transport.requestOpenClawSettingsWrite(
            "config.patch",
            {
                baseHash: "a".repeat(64),
                note: "Updated from Mira Dashboard settings",
                raw: JSON.stringify({
                    agents: { defaults: { heartbeat: { every: "120s" } } },
                }),
            },
            {
                beforeDispatch: () => {
                    authorized = true;
                    return Promise.resolve();
                },
            }
        );
        const readback = await transport.requestOpenClawSettingsRead("config.get", {});

        expect(authorized).toBeTrue();
        expect(acknowledgement).toMatchObject({ ok: true });
        expect(readback).toMatchObject({
            config: { agents: { defaults: { heartbeat: { every: "120s" } } } },
        });
        expect(calls).toEqual(["read:config.get"]);
    });
});
