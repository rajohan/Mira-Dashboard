import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import { listAutomationPrincipalsResultSchema } from "../contracts/automationSecurity.ts";
import {
    cacheHeartbeatResultSchema,
    cacheStatusResultSchema,
} from "../contracts/cache.ts";
import type { ChatHistoryOutput } from "../contracts/chat.ts";
import { chatHistoryRetainedPageMaximum } from "../contracts/chatModel.ts";
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
import { listSchedulesResultSchema } from "../contracts/schedules.ts";
import { automationPrincipalCapabilities } from "../server/database/schema/automationPrincipalCapabilities.ts";
import { automationPrincipalCapabilityInsertSchema } from "../server/database/validation/automationPrincipalCapabilities.ts";
import type { JobRepository } from "../server/domains/jobs/repository.ts";
import type { OpenClawCronExpiryReconciler } from "../server/domains/openClawCron/expiryReconciler.ts";
import { OpenClawCronProviderError } from "../server/domains/openClawCron/provider.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import { createWebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    seedAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../server/domains/security/testSupport/authentication.ts";
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
    createDashboardChatMediaReferenceRefresh,
    createDashboardOpenClawCronProvider,
    createDashboardServer,
    resolveDashboardGatewayScope,
    startDashboardOpenClawCronExpiryReconciliation,
    validateDashboardWebAuthnBrowserOrigin,
} from "./dashboardServer.ts";
import { createDashboardTerminalComposition } from "./dashboardTerminal.ts";

const mediaRefreshObservedAtMs = 1_800_000_000_000;

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

describe("Dashboard chat media-reference refresh", () => {
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
                options: { timeoutMs: 15_000 },
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
                workspaceRoot: {
                    id: "workspace",
                    label: "Workspace",
                    path: workspaceRoot,
                },
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
            database
                .insert(automationPrincipalCapabilities)
                .values(
                    v.parse(automationPrincipalCapabilityInsertSchema, {
                        capability: "monitoring:write",
                        grantedAt: authenticationTestNow,
                        principalId: authenticationTestPrincipalId,
                    })
                )
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
                capabilities: ["monitoring:write", "reports:read"],
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
            expect(schedules.schedules.map(({ id }) => id)).toEqual([
                "cache.moltbook-dashboard",
                "cache.system-host",
                "maintenance.rotate-managed-logs",
                "system.worker-smoke",
            ]);
            expect(schedules.schedules[0]).toMatchObject({
                actionKey: "cache.refresh.moltbook-dashboard",
                enabled: true,
                id: "cache.moltbook-dashboard",
            });
            expect(schedules.schedules[1]).toMatchObject({
                actionKey: "cache.refresh.system-host",
                enabled: true,
                id: "cache.system-host",
            });
            expect(schedules.schedules[2]).toMatchObject({
                actionKey: "maintenance.rotate-logs",
                enabled: true,
                id: "maintenance.rotate-managed-logs",
            });
            expect(schedules.schedules[3]).toMatchObject({
                actionKey: "system.worker-smoke",
                enabled: false,
                id: "system.worker-smoke",
            });

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
                schemaVersion: 2,
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
                {
                    defaultEnabled: true,
                    id: "cache.moltbook-dashboard",
                    state: "present",
                },
                {
                    defaultEnabled: true,
                    id: "cache.system-host",
                    state: "present",
                },
                {
                    defaultEnabled: true,
                    id: "maintenance.rotate-managed-logs",
                    state: "present",
                },
                {
                    defaultEnabled: false,
                    id: "system.worker-smoke",
                    state: "present",
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
