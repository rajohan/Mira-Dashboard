import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { describe, expect, it, jest } from "bun:test";

describe("server start scheduler policy", () => {
    it("starts scheduled jobs unless explicitly disabled", async () => {
        const { shouldStartScheduledJobs } = await import("../src/serverStartPolicy.ts");

        expect(shouldStartScheduledJobs({})).toBe(true);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "0",
            })
        ).toBe(true);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "1",
            })
        ).toBe(false);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_EXECUTION_ROLE: "web",
            })
        ).toBe(false);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_EXECUTION_ROLE: "combined",
            })
        ).toBe(true);
    });

    it("resolves backend startup entrypoint and gateway token decisions without starting services", async () => {
        const {
            isDirectEntrypoint,
            resolveGatewayToken,
            shouldStartOnImport,
            startBackendServerEntrypoint,
        } = await import("../src/serverStart.ts");

        expect(
            resolveGatewayToken(
                {
                    OPENCLAW_GATEWAY_TOKEN: " gateway-token ",
                    OPENCLAW_TOKEN: "legacy-token",
                },
                () => "persisted-token"
            )
        ).toBe("gateway-token");
        expect(
            resolveGatewayToken(
                { OPENCLAW_TOKEN: " legacy-token " },
                () => "persisted-token"
            )
        ).toBe("legacy-token");
        expect(resolveGatewayToken({}, () => " persisted-token ")).toBe(
            "persisted-token"
        );
        expect(resolveGatewayToken({}, () => "")).toBeUndefined();

        expect(isDirectEntrypoint(true)).toBe(true);
        expect(isDirectEntrypoint(false)).toBe(false);

        expect(shouldStartOnImport("1", false)).toBe(true);
        expect(shouldStartOnImport(undefined, true)).toBe(true);
        expect(shouldStartOnImport("0", false)).toBe(false);

        const disabledRunner = jest.fn(async () => {});
        const disabledStarter = jest.fn(() => {});
        await startBackendServerEntrypoint({
            isDirect: false,
            runServer: disabledRunner,
            startServer: disabledStarter,
            startOnImport: "0",
        });
        expect(disabledRunner).not.toHaveBeenCalled();
        expect(disabledStarter).not.toHaveBeenCalled();

        const importedRunner = jest.fn(async () => {});
        const importedStarter = jest.fn(() => {});
        await startBackendServerEntrypoint({
            isDirect: false,
            runServer: importedRunner,
            startServer: importedStarter,
            startOnImport: "1",
        });
        expect(importedRunner).not.toHaveBeenCalled();
        expect(importedStarter).toHaveBeenCalledTimes(1);

        const directServer = Promise.withResolvers<void>();
        let isDirectStartupComplete = false;
        const runDirectStartup = async () => {
            await startBackendServerEntrypoint({
                isDirect: true,
                runServer: () => directServer.promise,
            });
            isDirectStartupComplete = true;
        };
        const directStartup = runDirectStartup();
        await Bun.sleep(0);
        expect(isDirectStartupComplete).toBe(false);
        directServer.resolve();
        await directStartup;
        expect(isDirectStartupComplete).toBe(true);

        const startupError = new Error("imported startup failed");
        await expect(
            startBackendServerEntrypoint({
                isDirect: false,
                startOnImport: "1",
                startServer: () => {
                    throw startupError;
                },
            })
        ).rejects.toBe(startupError);
    });

    it("reports direct backend entrypoint failures", async () => {
        const originalExitCode = process.exitCode ?? 0;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const startupError = new Error("direct startup failed");
        const { startBackendServerEntrypoint } = await import("../src/serverStart.ts");
        try {
            process.exitCode = 0;
            await startBackendServerEntrypoint({
                isDirect: true,
                runServer: async () => {
                    throw startupError;
                },
            });
            expect(errorSpy).toHaveBeenCalledWith("[Backend] Failed:", startupError);
            expect(process.exitCode).toBe(1);
        } finally {
            errorSpy.mockRestore();
            process.exitCode = originalExitCode;
        }
    });

    it("exports the elevated log rotation CLI from both runtime entrypoints", async () => {
        const [serverStart, workerStart] = await Promise.all([
            import("../src/serverStart.ts"),
            import("../src/workerStart.ts"),
        ]);

        expect(serverStart.runLogRotationCli).toBeTypeOf("function");
        expect(workerStart.runLogRotationCli).toBeTypeOf("function");
    });

    it("resolves the dedicated worker entrypoint and keeps its event loop referenced", async () => {
        const { createWorkerKeepAliveHandle, isDirectWorkerEntrypoint } =
            await import("../src/workerStart.ts");

        expect(isDirectWorkerEntrypoint(true)).toBe(true);
        expect(isDirectWorkerEntrypoint(false)).toBe(false);

        const keepAlive = createWorkerKeepAliveHandle();
        try {
            expect(keepAlive.hasRef()).toBe(true);
        } finally {
            clearInterval(keepAlive);
        }
    });

    it("cleans up dedicated worker state when startup fails", async () => {
        const jobWorker = await import("../src/services/jobWorker.ts");
        const workerStart = await import("../src/workerStart.ts");
        const sigintListeners = process.listenerCount("SIGINT");
        const sigtermListeners = process.listenerCount("SIGTERM");
        const startSpy = jest
            .spyOn(jobWorker, "startDashboardJobWorker")
            .mockImplementation(() => {
                throw new Error("worker startup failed");
            });
        const stopSpy = jest
            .spyOn(jobWorker, "stopDashboardJobWorker")
            .mockImplementation(async () => {});

        try {
            await expect(workerStart.runDashboardWorker()).rejects.toThrow(
                "worker startup failed"
            );
            expect(stopSpy).toHaveBeenCalledTimes(1);
            expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
            expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
        } finally {
            startSpy.mockRestore();
            stopSpy.mockRestore();
        }
    });

    it("keeps worker startup blocked until failed executor cleanup is retried", async () => {
        const backups = await import("../src/services/backups.ts");
        const cacheRefresh = await import("../src/services/cacheRefresh.ts");
        const dockerActions = await import("../src/services/dockerActions.ts");
        const dockerUpdater = await import("../src/services/dockerUpdater.ts");
        const execJobs = await import("../src/services/execJobs.ts");
        const gitHygiene = await import("../src/services/gitHygiene.ts");
        const logRotation = await import("../src/services/logRotation.ts");
        const openclawActions = await import("../src/services/openclawActions.ts");
        const pullRequests = await import("../src/services/pullRequests.ts");
        const scheduledJobs = await import("../src/services/scheduledJobs.ts");
        const sqliteMaintenance = await import("../src/services/sqliteMaintenance.ts");
        const worker = await import("../src/services/jobWorker.ts");
        const cacheRegistrationSpy = jest
            .spyOn(cacheRefresh, "registerCacheRefreshScheduledJobs")
            .mockImplementation(() => {});
        const sqliteMaintenanceRegistrationSpy = jest
            .spyOn(sqliteMaintenance, "registerSqliteMaintenanceScheduledJob")
            .mockImplementation(() => {});
        const registrationSpies = [
            jest
                .spyOn(backups, "registerBackupScheduledJobs")
                .mockImplementation(() => {}),
            cacheRegistrationSpy,
            jest
                .spyOn(dockerActions, "registerDockerExecutionActions")
                .mockImplementation(() => {}),
            jest
                .spyOn(dockerUpdater, "registerDockerUpdaterScheduledJobs")
                .mockImplementation(() => {}),
            jest
                .spyOn(execJobs, "registerExecExecutionActions")
                .mockImplementation(() => {}),
            jest
                .spyOn(gitHygiene, "registerGitHygieneScheduledJobs")
                .mockImplementation(() => {}),
            jest
                .spyOn(logRotation, "registerLogRotationScheduledJobs")
                .mockImplementation(() => {}),
            jest
                .spyOn(openclawActions, "registerOpenClawExecutionActions")
                .mockImplementation(() => {}),
            jest
                .spyOn(pullRequests, "registerPullRequestExecutionActions")
                .mockImplementation(() => {}),
            sqliteMaintenanceRegistrationSpy,
        ];
        const startExecutorSpy = jest
            .spyOn(scheduledJobs, "startScheduledJobExecutor")
            .mockImplementation(() => {});
        const startSchedulerSpy = jest
            .spyOn(scheduledJobs, "startScheduledJobScheduler")
            .mockImplementation(() => {});
        startSchedulerSpy.mockImplementationOnce(() => {
            throw new Error("scheduler startup failed");
        });
        const stopExecutorSpy = jest
            .spyOn(scheduledJobs, "stopScheduledJobExecutor")
            .mockImplementation(async () => {});
        stopExecutorSpy.mockImplementationOnce(async () => {
            throw new Error("executor cleanup failed");
        });
        const stopSchedulerSpy = jest
            .spyOn(scheduledJobs, "stopScheduledJobScheduler")
            .mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            expect(() => worker.startDashboardJobWorker()).toThrow(
                "scheduler startup failed"
            );
            for (const registrationSpy of registrationSpies) {
                expect(registrationSpy).toHaveBeenCalledTimes(1);
            }
            expect(cacheRegistrationSpy).toHaveBeenCalledWith({
                refreshDatabaseOnStartup: true,
                seedStrategy: "queue",
            });
            expect(sqliteMaintenanceRegistrationSpy).toHaveBeenCalledWith({
                enqueueDatabaseSummaryRefresh: expect.any(Function),
            });
            await Bun.sleep(0);
            expect(errorSpy).toHaveBeenCalledWith(
                "[JobWorker] Failed to roll back executor startup:",
                expect.objectContaining({ message: "executor cleanup failed" })
            );

            worker.startDashboardJobWorker();
            expect(startExecutorSpy).toHaveBeenCalledTimes(1);
            expect(startSchedulerSpy).toHaveBeenCalledTimes(1);

            await worker.stopDashboardJobWorker();
            expect(stopExecutorSpy).toHaveBeenCalledTimes(2);

            worker.startDashboardJobWorker();
            expect(startExecutorSpy).toHaveBeenCalledTimes(2);
            expect(startSchedulerSpy).toHaveBeenCalledTimes(2);
            await worker.stopDashboardJobWorker();
            expect(stopExecutorSpy).toHaveBeenCalledTimes(3);
        } finally {
            try {
                await worker.stopDashboardJobWorker();
            } catch {
                // Test cleanup is best-effort after assertions fail.
            }
            for (const registrationSpy of registrationSpies) {
                registrationSpy.mockRestore();
            }
            startExecutorSpy.mockRestore();
            startSchedulerSpy.mockRestore();
            stopExecutorSpy.mockRestore();
            stopSchedulerSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it("starts listening-time services with a configured gateway token", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const originalSchedulerDisabled = process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        const gatewayModule = await import("../src/gateway.ts");
        const { database } = await import("../src/database.ts");
        const serverStartModule = await import("../src/serverStart.ts");
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES ('quotas.summary', '{\"providers\":[]}', 'test', ?, ?, ?, 'fresh', 0, '{}') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, source = excluded.source, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at, status = excluded.status, consecutive_failures = excluded.consecutive_failures, metadata_json = excluded.metadata_json"
            )
            .run(Date.now(), Date.now(), Date.now() + 60_000);
        const initSpy = jest
            .spyOn(gatewayModule.default, "init")
            .mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            process.env.OPENCLAW_GATEWAY_TOKEN = " test-token ";
            serverStartModule.handleServerListening();
            expect(initSpy).toHaveBeenCalledWith("test-token");
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            initSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
            if (originalGatewayToken === undefined) {
                delete process.env.OPENCLAW_GATEWAY_TOKEN;
            } else {
                process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
            }
            if (originalSchedulerDisabled === undefined) {
                delete process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
            } else {
                process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = originalSchedulerDisabled;
            }
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'quotas.summary'")
                .run();
        }
    });

    it("warns but keeps startup alive when no gateway token is configured", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const originalLegacyToken = process.env.OPENCLAW_TOKEN;
        const originalSchedulerDisabled = process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        delete process.env.OPENCLAW_TOKEN;
        const gatewayModule = await import("../src/gateway.ts");
        const { database } = await import("../src/database.ts");
        const serverStartModule = await import("../src/serverStart.ts");
        const previousPersistedGatewayToken = database
            .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
            .get() as { value: string } | undefined;
        database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES ('quotas.summary', '{\"providers\":[]}', 'test', ?, ?, ?, 'fresh', 0, '{}') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, source = excluded.source, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at, status = excluded.status, consecutive_failures = excluded.consecutive_failures, metadata_json = excluded.metadata_json"
            )
            .run(Date.now(), Date.now(), Date.now() + 60_000);
        const initSpy = jest
            .spyOn(gatewayModule.default, "init")
            .mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            serverStartModule.handleServerListening();
            expect(initSpy).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                "[Backend] No gateway token configured yet; waiting for bootstrap registration"
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            initSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
            if (originalGatewayToken === undefined) {
                delete process.env.OPENCLAW_GATEWAY_TOKEN;
            } else {
                process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
            }
            if (originalLegacyToken === undefined) {
                delete process.env.OPENCLAW_TOKEN;
            } else {
                process.env.OPENCLAW_TOKEN = originalLegacyToken;
            }
            if (originalSchedulerDisabled === undefined) {
                delete process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
            } else {
                process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = originalSchedulerDisabled;
            }
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'quotas.summary'")
                .run();
            if (previousPersistedGatewayToken) {
                database
                    .prepare(
                        "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
                    )
                    .run(previousPersistedGatewayToken.value, Date.now());
            } else {
                database
                    .prepare("DELETE FROM app_config WHERE key = 'gateway_token'")
                    .run();
            }
        }
    });

    it("rolls back listening-time startup when Gateway initialization fails", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const originalSchedulerDisabled = process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        process.env.OPENCLAW_GATEWAY_TOKEN = "broken-token";
        const gatewayModule = await import("../src/gateway.ts");
        const serverStartModule = await import("../src/serverStart.ts");
        const initSpy = jest
            .spyOn(gatewayModule.default, "init")
            .mockImplementation(() => {
                throw new Error("gateway boot failed");
            });
        const shutdownSpy = jest
            .spyOn(gatewayModule.default, "shutdown")
            .mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            expect(() => serverStartModule.handleServerListening()).toThrow(
                "gateway boot failed"
            );
            expect(shutdownSpy).not.toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalledWith(
                "[Backend] Failed to start background services:",
                expect.any(Error)
            );
        } finally {
            initSpy.mockRestore();
            shutdownSpy.mockRestore();
            errorSpy.mockRestore();
            if (originalGatewayToken === undefined) {
                delete process.env.OPENCLAW_GATEWAY_TOKEN;
            } else {
                process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
            }
            if (originalSchedulerDisabled === undefined) {
                delete process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
            } else {
                process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = originalSchedulerDisabled;
            }
        }
    });

    it("starts, stops, and handles web shutdown signals with isolated runtime state", async () => {
        const environmentKeys = [
            "MIRA_DASHBOARD_DB_PATH",
            "MIRA_DASHBOARD_DISABLE_SCHEDULER",
            "MIRA_DASHBOARD_FRONTEND_PATH",
            "OPENCLAW_HOME",
        ] as const;
        const originalEnvironment = Object.fromEntries(
            environmentKeys.map((key) => [key, process.env[key]])
        );
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-server-start-"));
        const frontendRoot = path.join(temporaryRoot, "frontend");
        const openclawRoot = path.join(temporaryRoot, "openclaw");
        mkdirSync(frontendRoot, { recursive: true });
        mkdirSync(openclawRoot, { recursive: true });
        writeFileSync(path.join(frontendRoot, "index.html"), "<!doctype html>");
        writeFileSync(path.join(openclawRoot, "openclaw.json"), "{}\n");

        process.env.MIRA_DASHBOARD_DB_PATH = path.join(temporaryRoot, "dashboard.db");
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.OPENCLAW_HOME = openclawRoot;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const { runBackendServer, startBackendServer, stopBackendServer } =
                await import("../src/serverStart.ts");

            startBackendServer(0);
            startBackendServer(0);
            await stopBackendServer();
            await stopBackendServer();

            for (const signal of ["SIGINT", "SIGTERM"] as const) {
                const existingListeners = {
                    SIGINT: process.listeners("SIGINT"),
                    SIGTERM: process.listeners("SIGTERM"),
                };
                const runningServer = runBackendServer(0);
                const addedListeners = {
                    SIGINT: process
                        .listeners("SIGINT")
                        .filter(
                            (listener) => !existingListeners.SIGINT.includes(listener)
                        ),
                    SIGTERM: process
                        .listeners("SIGTERM")
                        .filter(
                            (listener) => !existingListeners.SIGTERM.includes(listener)
                        ),
                };
                const shutdownListener = addedListeners[signal][0] as
                    NodeJS.SignalsListener | undefined;
                if (!shutdownListener) {
                    const cleanupListener = (addedListeners.SIGINT[0] ??
                        addedListeners.SIGTERM[0]) as NodeJS.SignalsListener | undefined;
                    if (cleanupListener) {
                        cleanupListener(signal);
                        await runningServer;
                    } else {
                        await stopBackendServer();
                        void runningServer.catch(() => {});
                    }
                    throw new TypeError(`${signal} shutdown listener not found`);
                }
                shutdownListener(signal);
                await runningServer;
                expect(process.listeners("SIGINT")).toEqual(existingListeners.SIGINT);
                expect(process.listeners("SIGTERM")).toEqual(existingListeners.SIGTERM);
            }
        } finally {
            errorSpy.mockRestore();
            warnSpy.mockRestore();
            for (const key of environmentKeys) {
                const originalValue = originalEnvironment[key];
                if (originalValue === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = originalValue;
                }
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });

    it("wires Bun server websocket hooks and static fallbacks", async () => {
        const originalFrontendPath = process.env.MIRA_DASHBOARD_FRONTEND_PATH;
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-server-hooks-"));
        const frontendRoot = path.join(temporaryRoot, "frontend");
        mkdirSync(path.join(frontendRoot, "assets"), { recursive: true });
        writeFileSync(path.join(frontendRoot, "index.html"), "<!doctype html>");
        writeFileSync(path.join(frontendRoot, "assets", "chunk.js"), "export {};\n");
        writeFileSync(path.join(frontendRoot, ".hidden.txt"), "secret\n");
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;

        const serveSpy = jest.spyOn(Bun, "serve").mockImplementation(
            ((options: unknown) =>
                ({
                    port: 0,
                    requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }),
                    stop: async () => {},
                    [Symbol.for("mira.test.options")]: options,
                }) as unknown as Server<unknown>) as typeof Bun.serve
        );
        let handleDashboardClientSpy: { mockRestore: () => void } | undefined;
        try {
            const gatewayModule = await import("../src/gateway.ts");
            handleDashboardClientSpy = jest
                .spyOn(gatewayModule.default, "handleDashboardClient")
                .mockImplementation(() => {});
            const { createServer } = await import("../src/server.ts");
            const optionsSymbol = Symbol.for("mira.test.options");
            const server = createServer(0) as Server<unknown> & {
                [optionsSymbol]: {
                    fetch: (
                        request: Request,
                        server: Server<unknown>
                    ) => Promise<Response> | Response;
                    websocket: {
                        close: (ws: {
                            data: { closeHandlers: Array<() => void> };
                        }) => void;
                        error: (
                            ws: {
                                data: {
                                    errorHandlers: Array<(error: unknown) => void>;
                                };
                            },
                            error: unknown
                        ) => void;
                        message: (
                            ws: {
                                data: {
                                    messageHandlers: Array<
                                        (data: string | Buffer) => void
                                    >;
                                };
                            },
                            message: string | Uint8Array
                        ) => void;
                        open: (ws: {
                            close: (code?: number, reason?: string) => void;
                            data: {
                                closeHandlers: Array<() => void>;
                                errorHandlers: Array<(error: unknown) => void>;
                                messageHandlers: Array<(data: string | Buffer) => void>;
                                socket?: unknown;
                            };
                            readyState: number;
                            send: (data: string) => void;
                        }) => void;
                    };
                };
            };
            const options = server[optionsSymbol];

            const apiFallback = await options.fetch(
                new Request("https://test.local/api/missing"),
                server
            );
            expect(apiFallback.status).toBe(404);
            await expect(apiFallback.json()).resolves.toEqual({ error: "Not found" });

            const badPath = await options.fetch(
                new Request("https://test.local/%E0%A4%A"),
                server
            );
            expect(badPath.status).toBe(400);

            const hiddenFile = await options.fetch(
                new Request("https://test.local/.hidden.txt"),
                server
            );
            expect(hiddenFile.status).toBe(404);

            const rootAsset = await options.fetch(
                new Request("https://test.local/chunk.js"),
                server
            );
            expect(rootAsset.status).toBe(200);
            expect(await rootAsset.text()).toBe("export {};\n");

            const missingNestedAsset = await options.fetch(
                new Request("https://test.local/nested/chunk.js"),
                server
            );
            expect(missingNestedAsset.status).toBe(404);

            const wsForbidden = await options.fetch(
                new Request("https://test.local/ws", {
                    headers: { Origin: "https://evil.example" },
                }),
                server
            );
            expect(wsForbidden.status).toBe(403);

            const closeHandler = jest.fn();
            const errorHandler = jest.fn();
            const messageHandler = jest.fn();
            const sendSpy = jest.fn();
            const closeSpy = jest.fn();
            const ws: {
                close: (code?: number, reason?: string) => void;
                data: {
                    closeHandlers: Array<() => void>;
                    errorHandlers: Array<(error: unknown) => void>;
                    messageHandlers: Array<(data: string | Buffer) => void>;
                    socket?: {
                        close: (code?: number, reason?: string) => void;
                        send: (data: string) => void;
                    };
                };
                readyState: number;
                send: (data: string) => void;
            } = {
                close: closeSpy,
                data: {
                    closeHandlers: [closeHandler],
                    errorHandlers: [errorHandler],
                    messageHandlers: [messageHandler],
                },
                readyState: WebSocket.OPEN,
                send: sendSpy,
            };
            options.websocket.open(ws);
            expect(handleDashboardClientSpy).toHaveBeenCalledWith(ws.data.socket);
            ws.data.socket?.close(1000, "done");
            ws.data.socket?.send("state");
            expect(closeSpy).toHaveBeenCalledWith(1000, "done");
            expect(sendSpy).toHaveBeenCalledWith("state");

            options.websocket.message(ws, new TextEncoder().encode("hello"));
            expect(closeSpy).toHaveBeenCalledWith(
                4401,
                "Dashboard session is no longer valid"
            );
            options.websocket.error(ws, new Error("boom"));
            options.websocket.close(ws);
            expect(messageHandler).not.toHaveBeenCalled();
            expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
            expect(closeHandler).toHaveBeenCalled();
        } finally {
            handleDashboardClientSpy?.mockRestore();
            serveSpy.mockRestore();
            if (originalFrontendPath === undefined) {
                delete process.env.MIRA_DASHBOARD_FRONTEND_PATH;
            } else {
                process.env.MIRA_DASHBOARD_FRONTEND_PATH = originalFrontendPath;
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });
});
