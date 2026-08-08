import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as v from "valibot";

import { listAutomationPrincipalsResultSchema } from "../contracts/automationSecurity.ts";
import { cacheStatusResultSchema } from "../contracts/cache.ts";
import { jobRunSummarySchema } from "../contracts/jobModel.ts";
import { listJobRunsResultSchema } from "../contracts/jobs.ts";
import {
    monitoringSubmissionResultSchema,
    reportDetailSchema,
} from "../contracts/monitoring.ts";
import { listSchedulesResultSchema } from "../contracts/schedules.ts";
import { automationPrincipalCapabilities } from "../server/database/schema/automationPrincipalCapabilities.ts";
import { automationPrincipalCapabilityInsertSchema } from "../server/database/validation/automationPrincipalCapabilities.ts";
import { createWebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    seedAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../server/domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../server/platform/readiness/readinessState.ts";
import { createDashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import { dashboardSessionCookieName } from "../server/rawHttp/authenticationCredentials.ts";
import { runTestImmediateDatabaseWrite } from "../server/test/support/databaseWriteAdmission.ts";
import { migrationsDirectory } from "../server/test/support/freshDatabase.ts";
import {
    createTestApplicationRuntime,
    createTestStructuredLogger,
} from "../server/test/support/requestContext.ts";
import {
    createDashboardServer,
    validateDashboardWebAuthnBrowserOrigin,
} from "./dashboardServer.ts";

describe("Dashboard security composition", () => {
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
                "cache.system-host",
                "system.worker-smoke",
            ]);
            expect(schedules.schedules[0]).toMatchObject({
                actionKey: "cache.refresh.system-host",
                enabled: true,
                id: "cache.system-host",
            });
            expect(schedules.schedules[1]).toMatchObject({
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
