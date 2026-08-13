import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createInMemoryOpenClawCronIntentStore } from "../../domains/openClawCron/intentStore.ts";
import { createOpenClawCronService } from "../../domains/openClawCron/service.ts";
import {
    persistentGatewayAdminMethods,
    persistentGatewayChatReadMutationMethods,
    persistentGatewayChatWriteMethods,
    persistentGatewayOpenClawSettingsWriteMethods,
    persistentGatewayTaskWriteMethods,
} from "./persistentGatewayProtocol.ts";
import type { PersistentGatewayTransport } from "./persistentGatewayTransport.ts";
import { createPersistentOpenClawCronProvider } from "./persistentOpenClawCronProvider.ts";
import { createSourceDevelopmentGatewayTransport } from "./sourceDevelopmentGatewayTransport.ts";

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
        requestAdmin: (method) => unavailableWrite(method),
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

function upstreamCronJob(): Readonly<Record<string, unknown>> {
    return Object.freeze({
        configRevision: "revision-1",
        createdAtMs: 1_800_000_000_000,
        enabled: true,
        id: "cron-1",
        name: "Development cron",
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

function cronReadTransport(calls: string[]): PersistentGatewayTransport {
    const base = readTransport(calls);
    const job = upstreamCronJob();
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
            response = job;
        } else if (method === "cron.list") {
            response = Object.freeze({
                hasMore: false,
                jobs: Object.freeze([job]),
                limit: parameters.limit,
                nextOffset: null,
                offset: parameters.offset,
                snapshotRevision: `sha256:${"a".repeat(43)}`,
                total: 1,
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

describe("source-development Gateway transport", () => {
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
        expect(
            await transport.requestChatWrite("chat.send", {
                attachments: [],
                idempotencyKey: "a".repeat(32),
                message: "private dev message",
                sessionKey: "agent:main:main",
            })
        ).toEqual({ runId: "a".repeat(32), status: "started" });
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
                ...persistentGatewayAdminMethods,
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
