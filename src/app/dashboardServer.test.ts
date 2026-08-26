import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import { listAutomationPrincipalsResultSchema } from "../contracts/automationSecurity.ts";
import {
    cacheHeartbeatResultSchema,
    cacheStatusResultSchema,
} from "../contracts/cache.ts";
import { chatHistoryOutputSchema, type ChatHistoryOutput } from "../contracts/chat.ts";
import { chatHistoryRetainedPageMaximum } from "../contracts/chatModel.ts";
import {
    type DatabaseObservabilityCachePayload,
    databaseObservabilityCacheSchemaId,
    databaseOverviewSchema,
} from "../contracts/database.ts";
import {
    type GatewaySession,
    deriveGatewaySessionStats,
    type ListGatewaySessionsResult,
} from "../contracts/gatewaySessions.ts";
import { jobRunSummarySchema } from "../contracts/jobModel.ts";
import { listJobRunsResultSchema } from "../contracts/jobs.ts";
import {
    monitoringSubmissionResultSchema,
    reportDetailSchema,
} from "../contracts/monitoring.ts";
import {
    createOpenClawConfigurationBackupResultSchema,
    restartOpenClawGatewayResultSchema,
} from "../contracts/openClawSettings.ts";
import { listSchedulesResultSchema } from "../contracts/schedules.ts";
import { authSessions } from "../server/database/schema/authSessions.ts";
import { automationPrincipalCapabilities } from "../server/database/schema/automationPrincipalCapabilities.ts";
import { cacheEntries } from "../server/database/schema/cacheEntries.ts";
import { jobRuns } from "../server/database/schema/jobRuns.ts";
import { users } from "../server/database/schema/users.ts";
import { automationPrincipalCapabilityInsertSchema } from "../server/database/validation/automationPrincipalCapabilities.ts";
import type { JobRunRecord } from "../server/domains/jobs/records.ts";
import {
    createJobRepository,
    type JobRepository,
} from "../server/domains/jobs/repository.ts";
import type { OpenClawCronExpiryReconciler } from "../server/domains/openClawCron/expiryReconciler.ts";
import { OpenClawCronProviderError } from "../server/domains/openClawCron/provider.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import { createWebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    authenticationTestUserId,
    seedAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../server/domains/security/testSupport/authentication.ts";
import { createInMemoryChatMediaReferences } from "../server/platform/chat/inMemoryChatMediaReferences.ts";
import { resolveReviewedOpenClawFileRoot } from "../server/platform/files/openClawFileRootConfiguration.ts";
import type { PersistentGatewayTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import type { PersistentOpenClawCronTransport } from "../server/platform/gateway/persistentOpenClawCronProvider.ts";
import { createReadinessController } from "../server/platform/readiness/readinessState.ts";
import { createDashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { dashboardSessionCookieName } from "../server/rawHttp/authenticationCredentials.ts";
import {
    runTestImmediateDatabaseWrite,
    testImmediateDatabaseWriteAdmission,
} from "../server/test/support/databaseWriteAdmission.ts";
import { migrationsDirectory } from "../server/test/support/freshDatabase.ts";
import {
    createTestApplicationRuntime,
    createTestStructuredLogger,
} from "../server/test/support/requestContext.ts";
import { createDashboardLogsService } from "./dashboardLogs.ts";
import {
    createDashboardChatMediaReferenceRefreshClass,
    createDashboardChatMediaReferenceRefresh,
    createDashboardOpenClawCronProvider,
    createDashboardServer,
    dashboardChatMediaReferenceRefreshPageMaximum,
    resolveDashboardGatewayScope,
    startDashboardOpenClawCronExpiryReconciliation,
    validateDashboardWebAuthnBrowserOrigin,
} from "./dashboardServer.ts";
import { createDashboardTerminalComposition } from "./dashboardTerminal.ts";

const mediaRefreshObservedAtMs = 1_800_000_000_000;
const dashboardServerTestPostgresqlDatabases = ["alpha", "comet", "postgres"] as const;
const dashboardServerTestPostgresqlSnapshot = Object.freeze({
    databases: dashboardServerTestPostgresqlDatabases.map((name) => ({
        blocksHit: 99,
        blocksRead: 1,
        cacheHitRatio: 99,
        committedTransactions: name === "comet" ? 100 : 0,
        connections: name === "comet" ? 2 : 0,
        detailsState: "available" as const,
        name,
        rolledBackTransactions: name === "comet" ? 1 : 0,
        sizeBytes: name === "comet" ? 4096 : 0,
    })),
    pgbouncer: {
        averageQueryMs: 5,
        averageTransactionMs: 8,
        clientConnections: 2,
        maxWaitSeconds: 0,
        serverConnections: 1,
        waitingClients: 0,
    },
    statements: [],
    summary: {
        activeConnections: 1,
        averageCacheHitRatio: 99,
        idleConnections: 1,
        maintenance: {
            assessedPhysicalBytes: 0,
            assessmentComplete: true,
            estimatedReclaimableBytes: 0,
            estimatedReclaimablePercent: 0,
            highDeadTupleTableCount: 0,
            requiresBloatReview: false,
            slowStatementCount: 0,
            status: "not-assessed",
            unassessedPhysicalBytes: 0,
            unassessedTableCount: 0,
        },
        pgStatStatementsEnabled: false,
        totalConnections: 2,
        totalDatabaseSizeBytes: 4096,
        unavailableDatabaseCount: 0,
    },
    tableHealth: [],
    torrentCounts: {
        bitmagnet: { state: "unavailable" },
        comet: { count: 42, state: "available" },
    },
} as const satisfies DatabaseObservabilityCachePayload);

function unavailableDashboardGatewayRequest(): Promise<never> {
    return Promise.reject(new Error("unused Gateway operation"));
}

function localHistoryMediaGatewayTransport(
    sessionKey: string,
    message: Readonly<Record<string, unknown>>
): PersistentGatewayTransport {
    const listeners = new Set<Parameters<PersistentGatewayTransport["subscribe"]>[0]>();
    return {
        request(method) {
            if (method !== "sessions.list") {
                return unavailableDashboardGatewayRequest();
            }
            return Promise.resolve({
                count: 1,
                creators: [],
                defaults: {},
                hasMore: false,
                limitApplied: 1,
                nextOffset: null,
                path: "(multiple)",
                sessions: [
                    {
                        key: sessionKey,
                        kind: "direct",
                        updatedAt: authenticationTestNow.getTime(),
                    },
                ],
                totalCount: 1,
                ts: authenticationTestNow.getTime(),
            });
        },
        requestAdmin: unavailableDashboardGatewayRequest,
        requestChatRead(method) {
            if (method === "chat.history") {
                return Promise.resolve({ messages: [message], offset: 0, sessionKey });
            }
            if (method === "chat.message.get") {
                return Promise.resolve({ message, ok: true });
            }
            return unavailableDashboardGatewayRequest();
        },
        requestChatReadMutation: unavailableDashboardGatewayRequest,
        requestChatWrite: unavailableDashboardGatewayRequest,
        requestOpenClawSettingsRead: unavailableDashboardGatewayRequest,
        requestOpenClawSettingsWrite: unavailableDashboardGatewayRequest,
        requestTaskRead: unavailableDashboardGatewayRequest,
        requestTaskWrite: unavailableDashboardGatewayRequest,
        snapshot: {
            connectionGeneration: 1,
            phase: "connected",
            reconnectAttempt: 0,
        },
        start() {
            for (const listener of listeners) listener.onState?.(this.snapshot);
        },
        stop() {
            return Promise.resolve();
        },
        subscribe(listener) {
            listeners.add(listener);
            listener.onState?.(this.snapshot);
            return () => listeners.delete(listener);
        },
        subscribeChat: () => () => {},
    };
}

function mediaRefreshSessionSnapshot(keys: readonly string[]): ListGatewaySessionsResult {
    const sessions: GatewaySession[] = keys.map((key, index) => ({
        displayName: key,
        hasActiveRun: false,
        key,
        kind: "main",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        totalTokens: index,
        totalTokensFresh: true,
        updatedAtMs: mediaRefreshObservedAtMs - index,
    }));
    return {
        filter: "ALL",
        projectionTruncated: false,
        sessions,
        source: {
            checkedAtMs: mediaRefreshObservedAtMs,
            connection: "connected",
            freshness: "fresh",
            observedAtMs: mediaRefreshObservedAtMs,
        },
        stats: deriveGatewaySessionStats(sessions, mediaRefreshObservedAtMs),
    };
}

function emptyMediaRefreshHistory(sessionKey: string): ChatHistoryOutput {
    return {
        messages: [],
        providerPagesRead: 1,
        sessionKey,
        truncated: false,
    };
}

async function readTrpcResult(response: Response): Promise<unknown> {
    const body = (await response.json()) as {
        readonly error?: unknown;
        readonly result?: { readonly data?: { readonly json?: unknown } };
    };
    expect(body.error).toBeUndefined();
    return body.result?.data?.json;
}

async function waitForPersistedRestartRun(
    repository: Pick<JobRepository, "findRunByIdempotency">,
    requestedById: string,
    idempotencyKey: string
): Promise<JobRunRecord> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const run = repository.findRunByIdempotency(
            "user",
            requestedById,
            idempotencyKey
        );
        if (run !== undefined) return run;
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for persisted OpenClaw restart run");
}

describe("Dashboard chat media-reference refresh", () => {
    test("classifies only a unique current session routing hint", async () => {
        const targetSessionKey = "agent:classifier-target:main";
        const references = createInMemoryChatMediaReferences();
        const attachmentId = references.registerManaged({
            attachmentId: "00000000-0000-4000-8000-000000000002",
            messageId: "message-classifier-target",
            sessionKey: targetSessionKey,
        }).attachmentId;
        references.dispose();
        let sessions = [targetSessionKey];
        const classifier = createDashboardChatMediaReferenceRefreshClass({
            gatewaySessionsService: {
                list: () => Promise.resolve(mediaRefreshSessionSnapshot(sessions)),
            },
        });
        const signal = new AbortController().signal;

        expect(await classifier(attachmentId, signal)).toBe(
            attachmentId.replaceAll("-", "").slice(0, 12)
        );
        sessions = [targetSessionKey, targetSessionKey];
        expect(await classifier(attachmentId, signal)).toBeUndefined();
        sessions = ["agent:unrelated:main"];
        expect(await classifier(attachmentId, signal)).toBeUndefined();
    });

    test("hydrates every bounded session while containing individual read failures", async () => {
        const controller = new AbortController();
        const historyCalls: unknown[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input, signal) => {
                    historyCalls.push({ input, signal });
                    return input.sessionKey === "agent:broken:main"
                        ? Promise.reject(new Error("history unavailable"))
                        : Promise.resolve(emptyMediaRefreshHistory(input.sessionKey));
                },
            },
            gatewaySessionsService: {
                list: (input, signal) => {
                    expect({ input, signal }).toEqual({
                        input: { filter: "ALL" },
                        signal: controller.signal,
                    });
                    return Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            "agent:main:main",
                            "agent:broken:main",
                            "agent:coder:main",
                        ])
                    );
                },
            },
        });

        await refresh(controller.signal);

        expect(historyCalls).toEqual(
            ["agent:main:main", "agent:broken:main", "agent:coder:main"].map(
                (sessionKey) => ({
                    input: { cursor: "0", limit: 100, sessionKey },
                    signal: controller.signal,
                })
            )
        );
    });

    test("propagates cancellation instead of treating it as session absence", async () => {
        const controller = new AbortController();
        const failure = new Error("request cancelled");
        let historyCalls = 0;
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: () => {
                    historyCalls += 1;
                    controller.abort();
                    return Promise.reject(failure);
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            "agent:main:main",
                            "agent:coder:main",
                        ])
                    ),
            },
        });

        let caught: unknown;
        try {
            await refresh(controller.signal);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(failure);
        expect(historyCalls).toBe(1);
    });

    test("walks the retained history window and stops at completion or its hard cap", async () => {
        const calls: { cursor: string; sessionKey: string }[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push({ cursor: input.cursor, sessionKey: input.sessionKey });
                    const cursor = Number(input.cursor);
                    const complete =
                        input.sessionKey === "agent:short:main" && cursor === 1;
                    return Promise.resolve({
                        ...emptyMediaRefreshHistory(input.sessionKey),
                        ...(complete ? {} : { nextCursor: String(cursor + 1) }),
                    });
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            "agent:short:main",
                            "agent:long:main",
                        ])
                    ),
            },
        });

        await refresh(new AbortController().signal);

        expect(calls).toEqual([
            { cursor: "0", sessionKey: "agent:short:main" },
            { cursor: "1", sessionKey: "agent:short:main" },
            ...Array.from({ length: chatHistoryRetainedPageMaximum }, (_, cursor) => ({
                cursor: String(cursor),
                sessionKey: "agent:long:main",
            })),
        ]);
    });

    test("caps aggregate restart rehydration work across all sessions", async () => {
        const calls: { cursor: string; sessionKey: string }[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push({ cursor: input.cursor, sessionKey: input.sessionKey });
                    return Promise.reject(new Error("unavailable history"));
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot(
                            Array.from(
                                { length: 40 },
                                (_, index) => `agent:bounded-${index}:main`
                            )
                        )
                    ),
            },
        });

        await refresh(new AbortController().signal);

        expect(calls).toHaveLength(dashboardChatMediaReferenceRefreshPageMaximum);
    });

    test("prioritizes the attachment's encoded session before the global page budget", async () => {
        const targetSessionKey = "agent:target:main";
        const references = createInMemoryChatMediaReferences({
            localMediaRoot: "/srv/openclaw/media",
        });
        const attachmentId = references.registerLocal({
            candidate: "reports/target.txt",
            messageId: "message-target",
            sessionKey: targetSessionKey,
            sourceSlot: "structured:0",
        })!.attachmentId;
        references.dispose();
        const calls: string[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push(input.sessionKey);
                    return Promise.reject(new Error("unavailable history"));
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            ...Array.from(
                                { length: 40 },
                                (_, index) => `agent:unrelated-${index}:main`
                            ),
                            targetSessionKey,
                        ])
                    ),
            },
        });

        await refresh(new AbortController().signal, attachmentId);

        expect(calls[0]).toBe(targetSessionKey);
        expect(calls).toEqual([targetSessionKey]);
    });

    test("routes a managed attachment to its late owning session after restart", async () => {
        const targetSessionKey = "agent:managed-target:main";
        const references = createInMemoryChatMediaReferences();
        const attachmentId = references.registerManaged({
            attachmentId: "00000000-0000-4000-8000-000000000002",
            messageId: "message-managed-target",
            sessionKey: targetSessionKey,
        }).attachmentId;
        references.dispose();
        const calls: string[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push(input.sessionKey);
                    return Promise.resolve(emptyMediaRefreshHistory(input.sessionKey));
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            ...Array.from(
                                { length: 40 },
                                (_, index) => `agent:unrelated-${index}:main`
                            ),
                            targetSessionKey,
                        ])
                    ),
            },
        });

        await refresh(new AbortController().signal, attachmentId);

        expect(calls).toEqual([targetSessionKey]);
    });

    test("fails ambiguous routing hints into the bounded legacy fallback", async () => {
        const targetSessionKey = "agent:ambiguous-target:main";
        const references = createInMemoryChatMediaReferences();
        const attachmentId = references.registerManaged({
            attachmentId: "00000000-0000-4000-8000-000000000002",
            messageId: "message-ambiguous-target",
            sessionKey: targetSessionKey,
        }).attachmentId;
        references.dispose();
        const calls: string[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push(input.sessionKey);
                    return Promise.resolve(emptyMediaRefreshHistory(input.sessionKey));
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            "agent:bounded-fallback:main",
                            targetSessionKey,
                            targetSessionKey,
                        ])
                    ),
            },
        });

        await refresh(new AbortController().signal, attachmentId);

        expect(calls).toEqual([
            "agent:bounded-fallback:main",
            targetSessionKey,
            targetSessionKey,
        ]);
    });

    test("never widens a targeted refresh when its session routing turns ambiguous", async () => {
        const targetSessionKey = "agent:stale-routing:main";
        const references = createInMemoryChatMediaReferences();
        const attachmentId = references.registerManaged({
            attachmentId: "00000000-0000-4000-8000-000000000002",
            messageId: "message-stale-routing",
            sessionKey: targetSessionKey,
        }).attachmentId;
        references.dispose();
        const calls: string[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push(input.sessionKey);
                    return Promise.resolve(emptyMediaRefreshHistory(input.sessionKey));
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot([
                            "agent:unrelated:main",
                            targetSessionKey,
                            targetSessionKey,
                        ])
                    ),
            },
        });

        await refresh(new AbortController().signal, attachmentId, "targeted");

        expect(calls).toEqual([]);
    });

    test("does not rotate the legacy fallback when a targeted refresh reads no session", async () => {
        const targetSessionKey = "agent:stable-fallback:main";
        const references = createInMemoryChatMediaReferences();
        const attachmentId = references.registerManaged({
            attachmentId: "00000000-0000-4000-8000-000000000002",
            messageId: "message-stable-fallback",
            sessionKey: targetSessionKey,
        }).attachmentId;
        references.dispose();
        const calls: string[] = [];
        const sessions = [
            targetSessionKey,
            "agent:unrelated:main",
            targetSessionKey,
            ...Array.from({ length: 30 }, (_, index) => `agent:fallback-${index}:main`),
        ];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push(input.sessionKey);
                    return Promise.resolve(emptyMediaRefreshHistory(input.sessionKey));
                },
            },
            gatewaySessionsService: {
                list: () => Promise.resolve(mediaRefreshSessionSnapshot(sessions)),
            },
        });

        await refresh(new AbortController().signal, attachmentId, "targeted");
        expect(calls).toEqual([]);
        await refresh(new AbortController().signal, attachmentId, "legacy");

        expect(calls[0]).toBe(targetSessionKey);
        expect(calls[1]).toBe("agent:unrelated:main");
    });

    test("uses a bounded rotating fallback for legacy managed ids", async () => {
        const calls: string[] = [];
        const refresh = createDashboardChatMediaReferenceRefresh({
            chatService: {
                history: (input) => {
                    calls.push(input.sessionKey);
                    return Promise.resolve(emptyMediaRefreshHistory(input.sessionKey));
                },
            },
            gatewaySessionsService: {
                list: () =>
                    Promise.resolve(
                        mediaRefreshSessionSnapshot(
                            Array.from(
                                { length: 40 },
                                (_, index) => `agent:unrelated-${index}:main`
                            )
                        )
                    ),
            },
        });

        const legacyId = "00000000-0000-4000-8000-000000000001";
        await refresh(new AbortController().signal, legacyId);
        await refresh(new AbortController().signal, legacyId);

        expect(calls).toHaveLength(2 * dashboardChatMediaReferenceRefreshPageMaximum);
        expect(calls.slice(0, 32)).toEqual(
            Array.from({ length: 32 }, (_, index) => `agent:unrelated-${index}:main`)
        );
        expect(calls.slice(32)).toEqual([
            ...Array.from(
                { length: 8 },
                (_, index) => `agent:unrelated-${index + 32}:main`
            ),
            ...Array.from({ length: 24 }, (_, index) => `agent:unrelated-${index}:main`),
        ]);
    });
});

describe("Dashboard local-history media composition", () => {
    test("projects and serves one transcript-bound file without a Gateway media token", async () => {
        const rootDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-local-history-media-composition-")
        );
        const stateDirectory = path.join(rootDirectory, "state");
        const workspaceRoot = path.join(rootDirectory, "workspace");
        const openClawRoot = path.join(rootDirectory, "openclaw-isolated-config");
        const openClawMediaRoot = path.join(rootDirectory, "openclaw-live-media");
        const mediaRoot = path.join(openClawMediaRoot, "media");
        const productionRoot = path.join(rootDirectory, "production");
        const uploadSpoolRoot = path.join(rootDirectory, "uploads");
        await Promise.all(
            [
                stateDirectory,
                workspaceRoot,
                openClawRoot,
                mediaRoot,
                productionRoot,
                uploadSpoolRoot,
            ].map((directory) => mkdir(directory, { mode: 0o700, recursive: true }))
        );
        await Promise.all([chmod(openClawRoot, 0o700), chmod(openClawMediaRoot, 0o700)]);
        await writeFile(path.join(openClawRoot, "openclaw.json"), "{}\n", {
            mode: 0o600,
        });
        await writeFile(path.join(openClawMediaRoot, "openclaw.json"), "{}\n", {
            mode: 0o600,
        });
        const mediaBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
        const mediaPath = path.join(mediaRoot, "history-diagram.png");
        await writeFile(mediaPath, mediaBytes, { mode: 0o600 });
        const sessionKey = "agent:main:main";
        const message = {
            __openclaw: {
                id: "message-local-history-media",
                media: [
                    {
                        contentType: "image/png",
                        fileName: "history-diagram.png",
                        path: mediaPath,
                        sizeBytes: mediaBytes.byteLength,
                    },
                ],
            },
            content: [{ text: "Rendered attachment.", type: "text" }],
            role: "assistant",
            timestamp: authenticationTestNow.getTime(),
        };
        const applicationRuntime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
            persistentGatewayTransport: localHistoryMediaGatewayTransport(
                sessionKey,
                message
            ),
        });
        let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;

        try {
            await applicationRuntime.initialize();
            const database = await applicationRuntime.database.orm();
            const fixture = seedAuthenticationTestDatabase(
                database,
                authenticationTestNow
            );
            const openClawFileRoot = await resolveReviewedOpenClawFileRoot(
                openClawRoot,
                productionRoot
            );
            const openClawMediaFileRoot = await resolveReviewedOpenClawFileRoot(
                openClawMediaRoot,
                productionRoot
            );
            server = await createDashboardServer({
                applicationRuntime,
                browserOrigin: "https://dashboard.example",
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => authenticationTestNow,
                openClawFileRoot,
                openClawMediaFileRoot,
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
                workspaceFileRoot: {
                    id: "workspace",
                    label: "Workspace",
                    path: workspaceRoot,
                    writable: true,
                },
                workspaceFileUploadSpoolRoot: uploadSpoolRoot,
            });
            const sessionHeaders = {
                cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                origin: "https://dashboard.example",
                "sec-fetch-site": "same-origin",
            };
            const input = encodeURIComponent(
                JSON.stringify({
                    json: { cursor: "0", limit: 100, sessionKey },
                })
            );
            const historyResponse = await fetch(
                new URL(`/trpc/chat.history?input=${input}`, server.url),
                { headers: sessionHeaders }
            );
            expect(historyResponse.status).toBe(200);
            const history = v.parse(
                chatHistoryOutputSchema,
                await readTrpcResult(historyResponse)
            );
            const projectedMessage = history.messages[0];
            const attachment =
                projectedMessage?.content.kind === "complete"
                    ? projectedMessage.content.parts.find(
                          (part) => part.kind === "attachment"
                      )
                    : undefined;
            expect(attachment?.kind).toBe("attachment");
            if (attachment?.kind !== "attachment") {
                throw new Error("Expected one projected local-history attachment");
            }
            expect(attachment.url).toMatch(
                /^\/api\/chat\/media\/[0-9a-f-]{36}\?disposition=preview$/u
            );
            expect(JSON.stringify(history)).not.toContain(openClawRoot);
            expect(JSON.stringify(history)).not.toContain(openClawMediaRoot);

            const headResponse = await fetch(new URL(attachment.url, server.url), {
                headers: sessionHeaders,
                method: "HEAD",
            });
            expect(headResponse.status).toBe(200);
            expect(headResponse.headers.get("content-type")).toBe("image/png");
            expect(headResponse.headers.get("content-length")).toBe(
                String(mediaBytes.byteLength)
            );
            const mediaResponse = await fetch(new URL(attachment.url, server.url), {
                headers: sessionHeaders,
            });
            expect(mediaResponse.status).toBe(200);
            expect(new Uint8Array(await mediaResponse.arrayBuffer())).toEqual(mediaBytes);
            expect(JSON.stringify([...mediaResponse.headers])).not.toContain(
                openClawRoot
            );
        } finally {
            try {
                await (server === undefined
                    ? applicationRuntime.dispose()
                    : server.stop(true));
            } finally {
                await rm(rootDirectory, { force: true, recursive: true });
            }
        }
    });
});

describe("Dashboard OpenClaw cron composition", () => {
    test("owns expiry reconciliation across ordered, idempotent server shutdown", async () => {
        const events: string[] = [];
        const server = Object.freeze({
            port: 31_000,
            stop: (force = false) => {
                events.push(`server:${String(force)}`);
                return Promise.resolve();
            },
            url: new URL("http://127.0.0.1:31000"),
        });
        const reconciler: OpenClawCronExpiryReconciler = Object.freeze({
            reconcile: () =>
                Promise.resolve({
                    attempted: 0,
                    failed: 0,
                    hasMore: false,
                    reconciled: 0,
                }),
            start: () => {
                events.push("reconciler:start");
            },
            stop: () => {
                events.push("reconciler:stop");
                return Promise.resolve();
            },
        });

        const ownedServer = await startDashboardOpenClawCronExpiryReconciliation(
            server,
            reconciler
        );
        expect(ownedServer.port).toBe(server.port);
        expect(ownedServer.url).toBe(server.url);
        expect(events).toEqual(["reconciler:start"]);

        const firstStop = ownedServer.stop(false);
        const secondStop = ownedServer.stop(false);
        expect(secondStop).toBe(firstStop);
        await firstStop;
        expect(events).toEqual(["reconciler:start", "reconciler:stop", "server:false"]);
    });

    test("escalates a stalled reconciler and server on a forced second stop", async () => {
        const events: string[] = [];
        let releaseReconciler!: () => void;
        const reconcilerStopped = new Promise<void>((resolve) => {
            releaseReconciler = resolve;
        });
        const server = Object.freeze({
            port: 31_000,
            stop: (force = false) => {
                events.push(`server:${String(force)}`);
                return Promise.resolve();
            },
            url: new URL("http://127.0.0.1:31000"),
        });
        const reconciler: OpenClawCronExpiryReconciler = Object.freeze({
            reconcile: () =>
                Promise.resolve({
                    attempted: 0,
                    failed: 0,
                    hasMore: false,
                    reconciled: 0,
                }),
            start: () => {
                events.push("reconciler:start");
            },
            stop: (force = false) => {
                events.push(`reconciler:${String(force)}`);
                if (force) releaseReconciler();
                return reconcilerStopped;
            },
        });
        const ownedServer = await startDashboardOpenClawCronExpiryReconciliation(
            server,
            reconciler
        );

        const gracefulStop = ownedServer.stop();
        await Promise.resolve();
        expect(events).toEqual(["reconciler:start", "reconciler:false"]);

        expect(ownedServer.stop(true)).toBe(gracefulStop);
        await gracefulStop;
        expect(events).toEqual([
            "reconciler:start",
            "reconciler:false",
            "reconciler:true",
            "server:true",
        ]);
    });

    test("contains a reconciler startup failure by force-stopping the server", () => {
        const failure = new Error("expiry startup failed");
        const stopCalls: boolean[] = [];
        const server = Object.freeze({
            port: 31_000,
            stop: (force = false) => {
                stopCalls.push(force);
                return Promise.resolve();
            },
            url: new URL("http://127.0.0.1:31000"),
        });
        const reconciler: OpenClawCronExpiryReconciler = Object.freeze({
            reconcile: () =>
                Promise.resolve({
                    attempted: 0,
                    failed: 0,
                    hasMore: false,
                    reconciled: 0,
                }),
            start: () => {
                throw failure;
            },
            stop: () => Promise.resolve(),
        });

        expect(
            startDashboardOpenClawCronExpiryReconciliation(server, reconciler)
        ).rejects.toBe(failure);
        expect(stopCalls).toEqual([true]);
    });

    test("selects the persistent adapter when the runtime owns a Gateway transport", async () => {
        const calls: unknown[] = [];
        const transport: PersistentOpenClawCronTransport = {
            request: (method, parameters, options) => {
                calls.push({ method, options, parameters });
                options?.onResponseBytes?.(1024);
                return Promise.resolve({
                    hasMore: false,
                    jobs: [],
                    limit: 1,
                    nextOffset: null,
                    offset: 0,
                    snapshotRevision: `sha256:${"a".repeat(43)}`,
                    total: 0,
                });
            },
            requestAdmin: () =>
                Promise.reject(new Error("Admin lane must not be reached")),
            snapshot: {
                connectedAtMs: 1_800_000_000_000,
                connectionGeneration: 1,
                phase: "connected",
                reconnectAttempt: 0,
            },
        };

        const provider = createDashboardOpenClawCronProvider(transport);
        expect(
            await provider.list({
                compact: false,
                enabled: "all",
                includeDeliveryPreviews: false,
                lastRunStatus: "all",
                limit: 1,
                offset: 0,
                scheduleKind: "all",
                sortBy: "nextRunAtMs",
                sortDir: "asc",
            })
        ).toMatchObject({ jobs: [], limit: 1, total: 0 });
        expect(calls).toEqual([
            {
                method: "cron.list",
                options: {
                    onResponseBytes: expect.any(Function),
                    timeoutMs: 15_000,
                },
                parameters: {
                    compact: false,
                    enabled: "all",
                    includeDeliveryPreviews: false,
                    lastRunStatus: "all",
                    limit: 1,
                    offset: 0,
                    scheduleKind: "all",
                    sortBy: "nextRunAtMs",
                    sortDir: "asc",
                },
            },
        ]);
    });

    test("keeps transport-free test runtimes fail closed", () => {
        const provider = createDashboardOpenClawCronProvider();
        return provider
            .list({
                compact: false,
                enabled: "all",
                includeDeliveryPreviews: false,
                lastRunStatus: "all",
                limit: 1,
                offset: 0,
                scheduleKind: "all",
                sortBy: "nextRunAtMs",
                sortDir: "asc",
            })
            .then(
                () => {
                    throw new Error("Expected the unavailable provider to fail");
                },
                (error: unknown) => {
                    expect(error).toEqual(new OpenClawCronProviderError("unavailable"));
                }
            );
    });
});

describe("Dashboard workspace operations composition", () => {
    test("exposes the reviewed terminal runtime through the worker broker boundary", async () => {
        const workspaceRoot = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-terminal-root-")
        );
        const brokerDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-terminal-broker-")
        );
        await Promise.all([chmod(workspaceRoot, 0o700), chmod(brokerDirectory, 0o700)]);

        try {
            const composition = await createDashboardTerminalComposition({
                authenticateCredential: () => {},
                authenticationLifecycle: {} as AuthenticationLifecycleService,
                browserOrigin: "https://dashboard.example",
                database: {} as SQLiteBunDatabase,
                now: () => authenticationTestNow,
                terminalBrokerDirectory: brokerDirectory,
                terminalBrokerSocket: path.join(brokerDirectory, "terminal.sock"),
                roots: [
                    {
                        id: "workspace",
                        label: "Workspace",
                        path: workspaceRoot,
                    },
                ],
                writeAdmission: testImmediateDatabaseWriteAdmission,
            });

            expect(composition.service.getRuntime()).toMatchObject({
                defaultLocation: { path: "/", rootId: "workspace" },
                mode: "pty",
                roots: [{ defaultPath: "/", id: "workspace", label: "Workspace" }],
                supportsInput: true,
                supportsPty: true,
            });
            const requestUrl = new URL("https://dashboard.example/api/not-terminal");
            expect(
                await composition.socketBoundary.handle(
                    new Request(requestUrl.href),
                    requestUrl,
                    {
                        upgrade: () => {
                            throw new Error("Unmatched requests must not upgrade");
                        },
                    }
                )
            ).toEqual({ kind: "not-matched" });
            composition.socketBoundary.shutdown();
        } finally {
            await Promise.all([
                rm(workspaceRoot, { force: true, recursive: true }),
                rm(brokerDirectory, { force: true, recursive: true }),
            ]);
        }
    });

    test("publishes missing log sources and fail-closed maintenance availability", async () => {
        const dashboardLogsRoot = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-logs-root-")
        );
        const logMaintenanceRoot = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-log-maintenance-")
        );
        await Promise.all([
            chmod(dashboardLogsRoot, 0o700),
            chmod(logMaintenanceRoot, 0o700),
        ]);
        let repositoryReadCalls = 0;
        let repositoryUnsafeCalls = 0;
        let settlementFailures = 0;
        const jobRepository: Pick<
            JobRepository,
            "enqueueManualRun" | "findRunByIdempotency" | "readActionPayloadRunSnapshots"
        > = {
            enqueueManualRun: () => {
                repositoryUnsafeCalls += 1;
                throw new Error("Read-only composition must not enqueue");
            },
            findRunByIdempotency: () => {
                repositoryUnsafeCalls += 1;
                throw new Error("Read-only composition must not replay an enqueue");
            },
            readActionPayloadRunSnapshots: ({ payloadJsons }) => {
                repositoryReadCalls += 1;
                return payloadJsons.map((payloadJson) => ({ payloadJson }));
            },
        };

        try {
            const service = createDashboardLogsService({
                dashboardLogsRoot,
                database: {} as SQLiteBunDatabase,
                jobRepository,
                logMaintenanceRoot,
                now: () => authenticationTestNow,
                onAuditSettlementFailure: () => {
                    settlementFailures += 1;
                },
                wakeEventPump: () => {
                    throw new Error("Read-only composition must not wake the event pump");
                },
                writeAdmission: testImmediateDatabaseWriteAdmission,
            });

            const [sources, maintenance] = await Promise.all([
                service.listSources(),
                service.maintenanceStatus(),
            ]);
            expect(sources).toMatchObject({
                observedAtMs: authenticationTestNow.getTime(),
                sources: expect.arrayContaining([
                    {
                        availability: "missing",
                        group: "dashboard",
                        id: "dashboard.web.stdout",
                        label: "Dashboard web output",
                    },
                ]),
            });
            expect(maintenance.observedAtMs).toBe(authenticationTestNow.getTime());
            expect(
                maintenance.policies.find(({ id }) => id === "docker-managed")
            ).toMatchObject({ id: "docker-managed", state: "unavailable" });
            expect(
                maintenance.policies.find(({ id }) => id === "host-rsyslog")
            ).toMatchObject({ id: "host-rsyslog", state: "unavailable" });
            expect(
                maintenance.policies.every(({ state }) => state === "unavailable")
            ).toBe(true);
            expect(repositoryReadCalls).toBe(1);
            expect(repositoryUnsafeCalls).toBe(0);
            expect(settlementFailures).toBe(0);
        } finally {
            await Promise.all([
                rm(dashboardLogsRoot, { force: true, recursive: true }),
                rm(logMaintenanceRoot, { force: true, recursive: true }),
            ]);
        }
    });
});

describe("Dashboard OpenClaw operations composition", () => {
    test("wires the reviewed export and durable restart through production HTTP", async () => {
        const rootDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-openclaw-operations-composition-")
        );
        const stateDirectory = path.join(rootDirectory, "state");
        const workspaceRoot = path.join(rootDirectory, "workspace");
        const openClawRoot = path.join(rootDirectory, "openclaw");
        const productionRoot = path.join(rootDirectory, "production");
        const uploadSpoolRoot = path.join(rootDirectory, "uploads");
        await Promise.all(
            [
                stateDirectory,
                workspaceRoot,
                openClawRoot,
                productionRoot,
                uploadSpoolRoot,
            ].map((directory) => mkdir(directory, { mode: 0o700 }))
        );
        const configurationText =
            '{"gateway":{"auth":{"token":"descriptor-composition-secret"}}}\n';
        await writeFile(path.join(openClawRoot, "openclaw.json"), configurationText, {
            encoding: "utf8",
            mode: 0o600,
        });
        const openClawFileRoot = await resolveReviewedOpenClawFileRoot(
            openClawRoot,
            productionRoot
        );
        const applicationRuntime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
        });
        let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;

        try {
            await applicationRuntime.initialize();
            const database = await applicationRuntime.database.orm();
            const fixture = seedAuthenticationTestDatabase(
                database,
                authenticationTestNow
            );
            database
                .update(users)
                .set({ mfaEnabledAt: authenticationTestNow })
                .where(eq(users.id, authenticationTestUserId))
                .run();
            database
                .update(authSessions)
                .set({ mfaVerifiedAt: authenticationTestNow })
                .where(eq(authSessions.userId, authenticationTestUserId))
                .run();
            server = await createDashboardServer({
                applicationRuntime,
                browserOrigin: "https://dashboard.example",
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => authenticationTestNow,
                openClawFileRoot,
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
                workspaceFileRoot: {
                    id: "workspace",
                    label: "Workspace",
                    path: workspaceRoot,
                    writable: true,
                },
                workspaceFileUploadSpoolRoot: uploadSpoolRoot,
            });
            const sessionHeaders = {
                cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                origin: "https://dashboard.example",
                "sec-fetch-site": "same-origin",
            };

            const backupResponse = await fetch(
                new URL("/trpc/openClawSettings.createConfigurationBackup", server.url),
                {
                    body: JSON.stringify({
                        json: { confirmation: "export-openclaw-configuration" },
                    }),
                    headers: {
                        ...sessionHeaders,
                        "content-type": "application/json",
                    },
                    method: "POST",
                }
            );
            expect(backupResponse.status).toBe(200);
            const backup = v.parse(
                createOpenClawConfigurationBackupResultSchema,
                await readTrpcResult(backupResponse)
            );
            expect(backup.expiresAtMs).toBe(authenticationTestNow.getTime() + 60_000);
            const downloadUrl = new URL(backup.downloadUrl, server.url);
            const headResponse = await fetch(downloadUrl, {
                headers: sessionHeaders,
                method: "HEAD",
            });
            expect(headResponse.status).toBe(200);
            expect(headResponse.headers.get("cache-control")).toBe("private, no-store");
            expect(headResponse.headers.get("content-disposition")).toBe(
                'attachment; filename="openclaw.json"'
            );
            expect(headResponse.headers.get("content-length")).toBe(
                String(Buffer.byteLength(configurationText))
            );
            expect(headResponse.headers.get("content-type")).toBe("application/json");
            expect(await headResponse.text()).toBe("");

            const downloadResponse = await fetch(downloadUrl, {
                headers: sessionHeaders,
            });
            expect(downloadResponse.status).toBe(200);
            expect(await downloadResponse.text()).toBe(configurationText);
            const consumedResponse = await fetch(downloadUrl, {
                headers: sessionHeaders,
            });
            expect(consumedResponse.status).toBe(404);

            const jobRepository = createJobRepository(
                database,
                applicationRuntime.database
            );
            const noJobSideEffects = Object.freeze({
                auditEvents: Object.freeze([]),
                realtimeEvents: Object.freeze([]),
            });
            const workerId = "019fdf50-0000-7000-8000-000000000101";
            const leaseToken = "019fdf50-0000-7000-8000-000000000102";
            await jobRepository.registerWorker({
                ...noJobSideEffects,
                worker: {
                    actionKeysJson: '["openclaw.gateway.restart"]',
                    capacity: 1,
                    drainingAt: null,
                    heartbeatAt: authenticationTestNow,
                    id: workerId,
                    pid: 1234,
                    releaseId: "0".repeat(40),
                    startedAt: authenticationTestNow,
                    state: "online",
                    stoppedAt: null,
                },
            });
            const idempotencyKey = "cHJvZHVjdGlvbi1odHRwLWNvbXBvc2l0aW9uLWtleS0x";
            const restartInput = {
                confirmation: "restart-openclaw-gateway",
                idempotencyKey,
            };
            const restartRequest = () =>
                fetch(new URL("/trpc/openClawSettings.restartGateway", server?.url), {
                    body: JSON.stringify({ json: restartInput }),
                    headers: {
                        ...sessionHeaders,
                        "content-type": "application/json",
                    },
                    method: "POST",
                });
            const restartResponsePromise = restartRequest();
            const queuedRun = await waitForPersistedRestartRun(
                jobRepository,
                authenticationTestUserId,
                idempotencyKey
            );
            expect(queuedRun).toMatchObject({
                actionKey: "openclaw.gateway.restart",
                cancellationPolicy: "never",
                payloadJson: "{}",
                requestedById: authenticationTestUserId,
                requestedByKind: "user",
                resourceClass: "exclusive",
                retrySafe: false,
                state: "queued",
            });
            const claimAt = new Date(authenticationTestNow.getTime() + 1);
            const claim = await jobRepository.claimNextRun({
                at: claimAt,
                bootIdentity: "00000000-0000-0000-0000-000000000001",
                leaseExpiresAt: new Date(authenticationTestNow.getTime() + 30_000),
                leaseToken,
                minimumHeartbeatAt: new Date(authenticationTestNow.getTime() - 1),
                sideEffectsForClaim: () => noJobSideEffects,
                workerId,
            });
            expect(claim).toMatchObject({
                kind: "claimed",
                run: { id: queuedRun.id, state: "running" },
            });
            if (claim.kind !== "claimed") {
                throw new Error(`Expected restart claim, received ${claim.kind}`);
            }
            const completedAtMs = authenticationTestNow.getTime() + 2;
            const settlement = await jobRepository.settleClaim({
                at: new Date(completedAtMs),
                leaseToken,
                outcome: {
                    kind: "succeeded",
                    resultJson: JSON.stringify({
                        completedAtMs,
                        status: "restarted",
                    }),
                },
                runId: claim.run.id,
                sideEffectsForRun: () => noJobSideEffects,
                workerId,
            });
            expect(settlement).toMatchObject({
                kind: "settled",
                run: {
                    id: queuedRun.id,
                    resultJson: JSON.stringify({
                        completedAtMs,
                        status: "restarted",
                    }),
                    state: "succeeded",
                },
            });

            const restartResponse = await restartResponsePromise;
            expect(restartResponse.status).toBe(200);
            const restart = v.parse(
                restartOpenClawGatewayResultSchema,
                await readTrpcResult(restartResponse)
            );
            expect(restart).toEqual({
                completedAtMs,
                jobRunId: queuedRun.id,
                status: "restarted",
            });
            const replayResponse = await restartRequest();
            expect(replayResponse.status).toBe(200);
            expect(
                v.parse(
                    restartOpenClawGatewayResultSchema,
                    await readTrpcResult(replayResponse)
                )
            ).toEqual(restart);
            expect(
                jobRepository.findRunByIdempotency(
                    "user",
                    authenticationTestUserId,
                    idempotencyKey
                )
            ).toMatchObject({
                id: queuedRun.id,
                resultJson: JSON.stringify({
                    completedAtMs,
                    status: "restarted",
                }),
                state: "succeeded",
            });
        } finally {
            try {
                await (server === undefined
                    ? applicationRuntime.dispose()
                    : server.stop(true));
            } finally {
                await rm(rootDirectory, { force: true, recursive: true });
            }
        }
    });
});

describe("Dashboard security composition", () => {
    test("isolates durable chat state by canonical Gateway origin", () => {
        const scope = resolveDashboardGatewayScope(
            "wss://Gateway.Example.test:443/socket?token=rotated"
        );

        expect(scope).toMatch(/^[0-9a-f]{64}$/u);
        expect(scope).toBe(
            resolveDashboardGatewayScope("wss://gateway.example.test/other-path")
        );
        expect(scope).not.toBe(
            resolveDashboardGatewayScope("wss://other.example.test/socket")
        );
        expect(scope).not.toBe(
            resolveDashboardGatewayScope("ws://gateway.example.test/socket")
        );
    });

    test("requires the HTTP browser origin in the WebAuthn allowlist", () => {
        const relyingParty = createWebAuthnRelyingPartyConfiguration({
            allowedOrigins: ["https://dashboard.example"],
            rpId: "dashboard.example",
            rpName: "Mira Dashboard",
        });

        expect(
            validateDashboardWebAuthnBrowserOrigin(
                "https://dashboard.example",
                relyingParty
            )
        ).toBe("https://dashboard.example");
        expect(() =>
            validateDashboardWebAuthnBrowserOrigin(
                "https://admin.dashboard.example",
                relyingParty
            )
        ).toThrow(
            "Dashboard browser origin is absent from the WebAuthn origin allowlist"
        );
    });

    test("releases an already-initialized runtime when composition preflight fails", async () => {
        let disposeCalls = 0;
        let initializeCalls = 0;
        const applicationRuntime = Object.freeze({
            ...createTestApplicationRuntime({
                dispose: () => {
                    disposeCalls += 1;
                    return Promise.resolve();
                },
                initialize: () => {
                    initializeCalls += 1;
                    return Promise.resolve();
                },
            }),
            database: Object.freeze({
                diagnostics: () =>
                    Promise.reject(new Error("Database must not be reached")),
                orm: () => Promise.reject(new Error("Database must not be reached")),
                run: runTestImmediateDatabaseWrite,
            }),
        });
        await applicationRuntime.initialize();

        expect(
            createDashboardServer({
                applicationRuntime,
                browserOrigin: "not-an-origin",
                gatewayUrl: "ws://127.0.0.1:1",
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            })
        ).rejects.toBeInstanceOf(TypeError);

        expect(initializeCalls).toBe(1);
        expect(disposeCalls).toBe(1);
    });

    test("rejects partial log composition before runtime initialization", () => {
        let disposeCalls = 0;
        let initializeCalls = 0;
        let ormCalls = 0;
        const applicationRuntime = Object.freeze({
            ...createTestApplicationRuntime({
                dispose: () => {
                    disposeCalls += 1;
                    return Promise.resolve();
                },
                initialize: () => {
                    initializeCalls += 1;
                    return Promise.resolve();
                },
            }),
            database: Object.freeze({
                diagnostics: () =>
                    Promise.reject(new Error("Database must not be reached")),
                orm: () => {
                    ormCalls += 1;
                    return Promise.reject(new Error("Database must not be reached"));
                },
                run: runTestImmediateDatabaseWrite,
            }),
        });

        expect(
            createDashboardServer({
                applicationRuntime,
                browserOrigin: "https://dashboard.example",
                dashboardLogsRoot: "/srv/mira-dashboard/logs",
                gatewayUrl: "ws://127.0.0.1:1",
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            })
        ).rejects.toThrow(
            "Dashboard logs and log-maintenance roots must be configured together"
        );

        expect(initializeCalls).toBe(0);
        expect(ormCalls).toBe(0);
        expect(disposeCalls).toBe(1);
    });

    test("wires the persisted automation lifecycle through the production server", async () => {
        const stateDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-server-composition-")
        );
        await chmod(stateDirectory, 0o700);
        const applicationRuntime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
        });
        let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;

        try {
            await applicationRuntime.initialize();
            const database = await applicationRuntime.database.orm();
            const fixture = seedAuthenticationTestDatabase(
                database,
                authenticationTestNow
            );
            const databaseObservationRunId = "019f6212-0300-7000-8000-000000000001";
            const databaseObservationQueuedAt = new Date(
                authenticationTestNow.getTime() - 2000
            );
            const databaseObservationStartedAt = new Date(
                authenticationTestNow.getTime() - 1000
            );
            database
                .insert(jobRuns)
                .values({
                    actionKey: "cache.refresh.database-observability",
                    attemptCount: 1,
                    attemptLimit: 3,
                    availableAt: databaseObservationQueuedAt,
                    cancellationPolicy: "cooperative",
                    cancelRequestedAt: null,
                    cancelRequestedById: null,
                    cancelRequestedByKind: null,
                    displayName: "Database observability cache",
                    enqueueSha256: "a".repeat(64),
                    eventBytes: 0,
                    eventCount: 0,
                    finishedAt: authenticationTestNow,
                    firstStartedAt: databaseObservationStartedAt,
                    heartbeatAt: null,
                    id: databaseObservationRunId,
                    idempotencyKey: "A".repeat(32),
                    lastAttemptStartedAt: databaseObservationStartedAt,
                    leaseExpiresAt: null,
                    leaseOwnerId: null,
                    leaseToken: null,
                    payloadEventCount: 0,
                    payloadJson: '{"key":"database.observability"}',
                    priority: 0,
                    queuedAt: databaseObservationQueuedAt,
                    requestedById: "system.database-observability",
                    requestedByKind: "system",
                    resourceClass: "light",
                    resourceKeysJson: '["network.database-observability"]',
                    resultJson: "{}",
                    retrySafe: true,
                    scheduledForAt: null,
                    scheduledJobId: null,
                    scheduledJobVersion: null,
                    state: "succeeded",
                    stateVersion: 2,
                    terminalCode: null,
                    terminalMessage: null,
                    timeoutMs: 65_000,
                    triggerType: "system",
                    updatedAt: authenticationTestNow,
                })
                .run();
            database
                .insert(cacheEntries)
                .values({
                    consecutiveFailures: 0,
                    expiresAt: new Date(authenticationTestNow.getTime() + 90 * 60_000),
                    failureCode: null,
                    failureMessage: null,
                    key: "database.observability",
                    lastAttemptAt: authenticationTestNow,
                    lastAttemptDurationMs: 100,
                    lastAttemptNumber: 1,
                    lastAttemptRunId: databaseObservationRunId,
                    lastAttemptStatus: "succeeded",
                    lastSuccessAt: authenticationTestNow,
                    metadataJson: "{}",
                    payloadJson: JSON.stringify(dashboardServerTestPostgresqlSnapshot),
                    schemaId: databaseObservabilityCacheSchemaId,
                    source: "postgresql.pgbouncer",
                    updatedAt: authenticationTestNow,
                })
                .run();
            database
                .insert(automationPrincipalCapabilities)
                .values([
                    v.parse(automationPrincipalCapabilityInsertSchema, {
                        capability: "cache:read",
                        grantedAt: authenticationTestNow,
                        principalId: authenticationTestPrincipalId,
                    }),
                    v.parse(automationPrincipalCapabilityInsertSchema, {
                        capability: "database:read",
                        grantedAt: authenticationTestNow,
                        principalId: authenticationTestPrincipalId,
                    }),
                    v.parse(automationPrincipalCapabilityInsertSchema, {
                        capability: "monitoring:write",
                        grantedAt: authenticationTestNow,
                        principalId: authenticationTestPrincipalId,
                    }),
                ])
                .run();
            server = await createDashboardServer({
                applicationRuntime,
                browserOrigin: "https://dashboard.example",
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => authenticationTestNow,
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            });
            const databaseResponse = await fetch(
                new URL("/trpc/database.overview", server.url),
                {
                    headers: {
                        cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                    },
                }
            );
            expect(databaseResponse.status).toBe(200);
            const databaseOverview = v.parse(
                databaseOverviewSchema,
                await readTrpcResult(databaseResponse)
            );
            expect(databaseOverview).toMatchObject({
                checkedAtMs: authenticationTestNow.getTime(),
                postgresql: {
                    observedAtMs: authenticationTestNow.getTime(),
                    state: "fresh",
                    torrentCounts: {
                        bitmagnet: { state: "unavailable" },
                        comet: { count: 42, state: "available" },
                    },
                },
                sqlite: {
                    migrations: { current: true },
                    observedAtMs: authenticationTestNow.getTime(),
                    state: "fresh",
                },
            });
            expect(
                databaseOverview.postgresql.state === "unavailable"
                    ? undefined
                    : databaseOverview.postgresql.databases.find(
                          ({ name }) => name === "comet"
                      )
            ).toMatchObject({ name: "comet", sizeBytes: 4096 });
            expect(JSON.stringify(databaseOverview)).not.toContain(stateDirectory);
            expect(JSON.stringify(databaseOverview)).not.toContain("initialize-empty");
            expect(JSON.stringify(databaseOverview)).not.toContain("postgresql://");
            expect(JSON.stringify(databaseOverview)).not.toContain("SELECT");
            const cacheInput = encodeURIComponent(
                JSON.stringify({ json: { key: "database.observability" } })
            );
            const genericCacheResponse = await fetch(
                new URL(`/trpc/cache.getEntry?input=${cacheInput}`, server.url),
                {
                    headers: {
                        authorization: `Bearer ${fixture.automation.token}`,
                    },
                }
            );
            const genericCacheBody = (await genericCacheResponse.json()) as {
                readonly result?: {
                    readonly data?: {
                        readonly json?: {
                            readonly key?: unknown;
                            readonly payload?: unknown;
                        };
                    };
                };
            };
            expect(genericCacheResponse.status).toBe(200);
            expect(genericCacheBody.result?.data?.json).toMatchObject({
                key: "database.observability",
                payload: dashboardServerTestPostgresqlSnapshot,
            });
            const input = encodeURIComponent(JSON.stringify({ json: {} }));
            const response = await fetch(
                new URL(
                    `/trpc/automationSecurity.listPrincipals?input=${input}`,
                    server.url
                ),
                {
                    headers: {
                        cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                    },
                }
            );
            const body = (await response.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };

            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(body.error).toBeUndefined();
            const result = v.parse(
                listAutomationPrincipalsResultSchema,
                body.result?.data?.json
            );
            expect(
                result.principals.find(({ id }) => id === authenticationTestPrincipalId)
            ).toMatchObject({
                activeCredentialCount: 1,
                capabilities: [
                    "cache:read",
                    "database:read",
                    "monitoring:write",
                    "reports:read",
                ],
                disabled: false,
                id: authenticationTestPrincipalId,
            });

            const nowMs = authenticationTestNow.getTime();
            const snapshot = {
                completedAtMs: nowMs - 1000,
                monitorKey: "dashboard-composition",
                problems: [],
                report: {
                    bodyMarkdown: "# Production composition",
                    kind: "composition",
                    metadata: { source: "dashboard-server-test" },
                    source: "dashboard",
                    sourceJobId: "composition-test",
                    title: "Production composition",
                },
                runId: "018f6f50-6a9e-7b88-8000-000000000001",
                startedAtMs: nowMs - 2000,
            };
            const ingestionResponse = await fetch(
                new URL("/trpc/monitoring.submitCompleteSnapshot", server.url),
                {
                    body: JSON.stringify({ json: snapshot }),
                    headers: {
                        authorization: `Bearer ${fixture.automation.token}`,
                        "content-type": "application/json",
                    },
                    method: "POST",
                }
            );
            const ingestionBody = (await ingestionResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };
            expect(ingestionResponse.status).toBe(200);
            expect(ingestionBody.error).toBeUndefined();
            const ingestion = v.parse(
                monitoringSubmissionResultSchema,
                ingestionBody.result?.data?.json
            );
            expect(ingestion).toMatchObject({
                createdIncidents: 0,
                observedIncidents: 0,
                status: "accepted",
            });
            expect(ingestion.reportId).not.toBeNull();

            const reportInput = encodeURIComponent(
                JSON.stringify({ json: { id: ingestion.reportId } })
            );
            const reportResponse = await fetch(
                new URL(`/trpc/reports.get?input=${reportInput}`, server.url),
                {
                    headers: {
                        cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                    },
                }
            );
            const reportBody = (await reportResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };
            expect(reportResponse.status).toBe(200);
            expect(reportBody.error).toBeUndefined();
            expect(
                v.parse(reportDetailSchema, reportBody.result?.data?.json)
            ).toMatchObject({
                bodyMarkdown: snapshot.report.bodyMarkdown,
                id: ingestion.reportId,
                title: snapshot.report.title,
            });
        } finally {
            try {
                await (server === undefined
                    ? applicationRuntime.dispose()
                    : server.stop(true));
            } finally {
                await rm(stateDirectory, { force: true, recursive: true });
            }
        }
    });

    test("wires durable schedule reconciliation and idempotent enqueue through production HTTP", async () => {
        const stateDirectory = await mkdtemp(
            path.join(os.tmpdir(), "dashboard-server-jobs-composition-")
        );
        await chmod(stateDirectory, 0o700);
        const applicationRuntime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId: "0".repeat(40),
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
        });
        let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;

        try {
            await applicationRuntime.initialize();
            const database = await applicationRuntime.database.orm();
            const fixture = seedAuthenticationTestDatabase(
                database,
                authenticationTestNow
            );
            server = await createDashboardServer({
                applicationRuntime,
                browserOrigin: "https://dashboard.example",
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => authenticationTestNow,
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            });
            const headers = {
                cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
            };
            const listInput = encodeURIComponent(JSON.stringify({ json: {} }));
            const scheduleResponse = await fetch(
                new URL(`/trpc/schedules.list?input=${listInput}`, server.url),
                { headers }
            );
            const scheduleBody = (await scheduleResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };

            expect(scheduleResponse.status).toBe(200);
            expect(scheduleBody.error).toBeUndefined();
            const schedules = v.parse(
                listSchedulesResultSchema,
                scheduleBody.result?.data?.json
            );
            const expectedScheduleIds = [
                "backup.kopia.run",
                "backup.walg.run",
                "cache.backup-status",
                "cache.database-observability",
                "cache.delivery-overview",
                "cache.docker-overview",
                "cache.git-workspace",
                "cache.moltbook-dashboard",
                "cache.quotas",
                "cache.system-host",
                "cache.weather",
                "database.sqlite-maintenance",
                "docker.updater",
                "git.openclaw.workspace-sync",
                "maintenance.rotate-managed-logs",
            ] as const;
            expect(schedules.schedules.map(({ id }) => id)).toEqual(expectedScheduleIds);
            expect(
                schedules.schedules.find(
                    ({ id }) => id === "cache.database-observability"
                )
            ).toMatchObject({
                actionKey: "cache.refresh.database-observability",
                enabled: true,
                id: "cache.database-observability",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "cache.delivery-overview")
            ).toMatchObject({
                actionKey: "cache.refresh.delivery-overview",
                enabled: true,
                id: "cache.delivery-overview",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "cache.docker-overview")
            ).toMatchObject({
                actionKey: "cache.refresh.docker-overview",
                enabled: true,
                id: "cache.docker-overview",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "cache.moltbook-dashboard")
            ).toMatchObject({
                actionKey: "cache.refresh.moltbook-dashboard",
                enabled: true,
                id: "cache.moltbook-dashboard",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "cache.system-host")
            ).toMatchObject({
                actionKey: "cache.refresh.system-host",
                enabled: true,
                id: "cache.system-host",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "database.sqlite-maintenance")
            ).toMatchObject({
                actionKey: "database.sqlite-maintenance",
                enabled: true,
                id: "database.sqlite-maintenance",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "docker.updater")
            ).toMatchObject({
                actionKey: "docker.updater",
                enabled: true,
                id: "docker.updater",
            });
            expect(
                schedules.schedules.find(
                    ({ id }) => id === "maintenance.rotate-managed-logs"
                )
            ).toMatchObject({
                actionKey: "maintenance.rotate-logs",
                enabled: true,
                id: "maintenance.rotate-managed-logs",
            });
            expect(
                schedules.schedules.find(({ id }) => id === "system.worker-smoke")
            ).toBeUndefined();

            const cacheStatusResponse = await fetch(
                new URL(`/trpc/cache.getStatus?input=${listInput}`, server.url),
                { headers }
            );
            const cacheStatusBody = (await cacheStatusResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };
            expect(cacheStatusResponse.status).toBe(200);
            expect(cacheStatusBody.error).toBeUndefined();
            expect(
                v.parse(cacheStatusResultSchema, cacheStatusBody.result?.data?.json)
            ).toMatchObject({ entries: [], totalCount: 0, truncated: false });

            const heartbeatResponse = await fetch(
                new URL(`/trpc/cache.getHeartbeat?input=${listInput}`, server.url),
                { headers }
            );
            const heartbeatBody = (await heartbeatResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };
            expect(heartbeatResponse.status).toBe(200);
            expect(heartbeatBody.error).toBeUndefined();
            const heartbeat = v.parse(
                cacheHeartbeatResultSchema,
                heartbeatBody.result?.data?.json
            );
            expect(heartbeat).toMatchObject({
                cache: { entries: [], totalCount: 0, truncated: false },
                dashboardJobs: { state: "available" },
                gateway: {
                    connection: { freshness: "unavailable", phase: "stopped" },
                    sessions: { state: "unavailable" },
                },
                openClawCron: { pendingSync: "unknown", state: "unavailable" },
                schemaVersion: 5,
                tasks: {
                    items: [],
                    state: "available",
                    totalCount: 0,
                    truncated: false,
                },
            });
            expect(
                heartbeat.dashboardJobs.state === "available"
                    ? heartbeat.dashboardJobs.items.map(
                          ({ defaultEnabled, id, state }) => ({
                              defaultEnabled,
                              id,
                              state,
                          })
                      )
                    : []
            ).toEqual([
                ...expectedScheduleIds.map((id) => ({
                    defaultEnabled: true,
                    id,
                    state: "present" as const,
                })),
                {
                    defaultEnabled: false,
                    id: "system.worker-smoke",
                    state: "present" as const,
                },
            ]);

            const idempotencyKey = "cHJvZHVjdGlvbi1odHRwLWNvbXBvc2l0aW9uLWtleS0x";
            const enqueue = () =>
                fetch(new URL("/trpc/schedules.run", server?.url), {
                    body: JSON.stringify({
                        json: {
                            id: "system.worker-smoke",
                            idempotencyKey,
                        },
                    }),
                    headers: {
                        ...headers,
                        "content-type": "application/json",
                    },
                    method: "POST",
                });
            const firstEnqueueResponse = await enqueue();
            const firstEnqueueBody = (await firstEnqueueResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };
            const secondEnqueueResponse = await enqueue();
            const secondEnqueueBody = (await secondEnqueueResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };

            expect(firstEnqueueResponse.status).toBe(200);
            expect(secondEnqueueResponse.status).toBe(200);
            expect(firstEnqueueBody.error).toBeUndefined();
            expect(secondEnqueueBody.error).toBeUndefined();
            const firstRun = v.parse(
                jobRunSummarySchema,
                firstEnqueueBody.result?.data?.json
            );
            const replayedRun = v.parse(
                jobRunSummarySchema,
                secondEnqueueBody.result?.data?.json
            );
            expect(firstRun).toMatchObject({
                actionKey: "system.worker-smoke",
                scheduledJobId: "system.worker-smoke",
                state: "queued",
                triggerType: "manual",
            });
            expect(replayedRun.id).toBe(firstRun.id);

            const runResponse = await fetch(
                new URL(`/trpc/jobs.listRuns?input=${listInput}`, server.url),
                { headers }
            );
            const runBody = (await runResponse.json()) as {
                readonly error?: unknown;
                readonly result?: { readonly data?: { readonly json?: unknown } };
            };
            expect(runResponse.status).toBe(200);
            expect(runBody.error).toBeUndefined();
            const runs = v.parse(listJobRunsResultSchema, runBody.result?.data?.json);
            expect(runs.runs.map(({ id }) => id)).toEqual([firstRun.id]);
            expect(runs.summary.stateCounts.queued).toBe(1);
        } finally {
            try {
                await (server === undefined
                    ? applicationRuntime.dispose()
                    : server.stop(true));
            } finally {
                await rm(stateDirectory, { force: true, recursive: true });
            }
        }
    });
});
