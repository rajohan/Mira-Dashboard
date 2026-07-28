import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { describe, expect, it, jest } from "bun:test";

import * as releaseManifestModule from "../src/releaseManifest.ts";

const TEST_RELEASE_COMMIT = "a".repeat(40);

describe("server start scheduler policy", () => {
    it("starts scheduled jobs only in the combined non-production server", async () => {
        const { shouldStartScheduledJobs } = await import("../src/serverStartPolicy.ts");

        expect(shouldStartScheduledJobs({})).toBe(true);
        expect(shouldStartScheduledJobs({ NODE_ENV: "development" })).toBe(true);
        expect(shouldStartScheduledJobs({ NODE_ENV: "test" })).toBe(true);
        expect(shouldStartScheduledJobs({ NODE_ENV: "production" })).toBe(false);
    });

    it("keeps production frontend assets inside the checksummed release", async () => {
        const { resolveFrontendPath } = await import("../src/frontendAssets.ts");
        const releaseRoot = "/opt/mira-dashboard/releases/test-release";
        const releaseFrontend = path.join(releaseRoot, "dist");

        expect(resolveFrontendPath({ NODE_ENV: "production" }, releaseRoot)).toBe(
            releaseFrontend
        );
        expect(
            resolveFrontendPath(
                {
                    MIRA_DASHBOARD_FRONTEND_PATH: releaseFrontend,
                    NODE_ENV: "production",
                },
                releaseRoot
            )
        ).toBe(releaseFrontend);
        expect(
            resolveFrontendPath(
                {
                    MIRA_DASHBOARD_FRONTEND_PATH: "/tmp/unverified-frontend",
                    NODE_ENV: "production",
                },
                releaseRoot
            )
        ).toBe(releaseFrontend);
        expect(
            resolveFrontendPath(
                {
                    MIRA_DASHBOARD_FRONTEND_PATH: "/tmp/development-frontend",
                    NODE_ENV: "development",
                },
                releaseRoot
            )
        ).toBe("/tmp/development-frontend");
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
                },
                () => "persisted-token"
            )
        ).toBe("gateway-token");
        expect(resolveGatewayToken({}, () => " persisted-token ")).toBe(
            "persisted-token"
        );
        expect(resolveGatewayToken({}, () => "")).toBeUndefined();

        expect(isDirectEntrypoint(true)).toBe(true);
        expect(isDirectEntrypoint(false)).toBe(false);

        expect(shouldStartOnImport(true)).toBe(true);
        expect(shouldStartOnImport(false)).toBe(false);

        const disabledRunner = jest.fn(async () => {});
        await startBackendServerEntrypoint({
            isDirect: false,
            runServer: disabledRunner,
        });
        expect(disabledRunner).not.toHaveBeenCalled();

        const directServer = Promise.withResolvers<void>();
        const exitProcess = jest.fn(() => {});
        let isDirectStartupComplete = false;
        const runDirectStartup = async () => {
            await startBackendServerEntrypoint({
                exitProcess,
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
        expect(exitProcess).toHaveBeenCalledWith(0);
    });

    it("reports direct backend entrypoint failures", async () => {
        const originalExitCode = process.exitCode ?? 0;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const exitProcess = jest.fn(() => {});
        const startupError = new Error("direct startup failed");
        const { startBackendServerEntrypoint } = await import("../src/serverStart.ts");
        try {
            process.exitCode = 0;
            await startBackendServerEntrypoint({
                exitProcess,
                isDirect: true,
                runServer: async () => {
                    throw startupError;
                },
            });
            expect(errorSpy).toHaveBeenCalledWith("[Backend] Failed:", startupError);
            expect(exitProcess).toHaveBeenCalledWith(1);
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
            expect(startSpy).toHaveBeenCalledWith(
                expect.stringMatching(/^[\da-f]{8,40}$/u)
            );
            expect(stopSpy).toHaveBeenCalledTimes(1);
            expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
            expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
        } finally {
            startSpy.mockRestore();
            stopSpy.mockRestore();
        }
    });

    it("verifies the production worker release before opening SQLite", async () => {
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-worker-release-"));
        const databasePath = path.join(
            temporaryRoot,
            "production",
            "state",
            "mira-dashboard.db"
        );
        const backendRoot = path.join(temporaryRoot, "backend");
        mkdirSync(backendRoot);
        const child = Bun.spawn({
            cmd: [
                process.execPath,
                path.resolve(import.meta.dirname, "../src/workerStart.ts"),
            ],
            cwd: backendRoot,
            env: {
                ...process.env,
                MIRA_DASHBOARD_PROJECT_ROOT: temporaryRoot,
                NODE_ENV: "production",
            },
            stderr: "pipe",
            stdin: "ignore",
            stdout: "ignore",
        });

        try {
            const [exitCode, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain(
                "Worker release identity is not ready (manifest-missing)"
            );
            expect(existsSync(databasePath)).toBe(false);
        } finally {
            child.kill();
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });

    it("verifies the production backend release before opening SQLite", async () => {
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-backend-release-"));
        const databasePath = path.join(
            temporaryRoot,
            "production",
            "state",
            "mira-dashboard.db"
        );
        const backendRoot = path.join(temporaryRoot, "backend");
        mkdirSync(backendRoot);
        const child = Bun.spawn({
            cmd: [
                process.execPath,
                path.resolve(import.meta.dirname, "../src/serverStart.ts"),
            ],
            cwd: backendRoot,
            env: {
                ...process.env,
                MIRA_DASHBOARD_PROJECT_ROOT: temporaryRoot,
                NODE_ENV: "production",
                PORT: "0",
            },
            stderr: "pipe",
            stdin: "ignore",
            stdout: "ignore",
        });

        try {
            const [exitCode, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain(
                "Backend release identity is not ready (manifest-missing)"
            );
            expect(existsSync(databasePath)).toBe(false);
        } finally {
            child.kill();
            rmSync(temporaryRoot, { force: true, recursive: true });
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
        const originalNodeEnvironment = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
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
            serverStartModule.handleServerListening(TEST_RELEASE_COMMIT);
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
            if (originalNodeEnvironment === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnvironment;
            }
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'quotas.summary'")
                .run();
        }
    });

    it("starts the combined worker with the verified release identity", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const originalNodeEnvironment = process.env.NODE_ENV;
        process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";
        process.env.NODE_ENV = "development";
        const gatewayModule = await import("../src/gateway.ts");
        const jobWorker = await import("../src/services/jobWorker.ts");
        const serverStartModule = await import("../src/serverStart.ts");
        const initSpy = jest
            .spyOn(gatewayModule.default, "init")
            .mockImplementation(() => {});
        const startWorkerSpy = jest
            .spyOn(jobWorker, "startDashboardJobWorker")
            .mockImplementation(() => {});
        try {
            serverStartModule.handleServerListening(TEST_RELEASE_COMMIT);
            expect(startWorkerSpy).toHaveBeenCalledWith(TEST_RELEASE_COMMIT);
        } finally {
            initSpy.mockRestore();
            startWorkerSpy.mockRestore();
            if (originalGatewayToken === undefined) {
                delete process.env.OPENCLAW_GATEWAY_TOKEN;
            } else {
                process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
            }
            if (originalNodeEnvironment === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnvironment;
            }
        }
    });

    it("warns but keeps startup alive when no gateway token is configured", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const originalNodeEnvironment = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
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
            serverStartModule.handleServerListening(TEST_RELEASE_COMMIT);
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
            if (originalNodeEnvironment === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnvironment;
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
        const originalNodeEnvironment = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
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
            expect(() =>
                serverStartModule.handleServerListening(TEST_RELEASE_COMMIT)
            ).toThrow("gateway boot failed");
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
            if (originalNodeEnvironment === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnvironment;
            }
        }
    });

    it("shares concurrent startup failures and clears the completed attempt", async () => {
        const startupFailure = new Error("release verification failed");
        const release =
            Promise.withResolvers<
                Awaited<
                    ReturnType<typeof releaseManifestModule.getRuntimeReleaseIdentity>
                >
            >();
        const releaseSpy = jest
            .spyOn(releaseManifestModule, "getRuntimeReleaseIdentity")
            .mockReturnValue(release.promise);
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const originalExitCode = process.exitCode;
        const { startBackendServer, stopBackendServer } =
            await import("../src/serverStart.ts");
        try {
            await stopBackendServer();
            process.exitCode = 0;

            const firstStartup = startBackendServer(0);
            const concurrentStartup = startBackendServer(0);
            expect(concurrentStartup).toBe(firstStartup);

            release.reject(startupFailure);
            await expect(firstStartup).rejects.toBe(startupFailure);
            await expect(concurrentStartup).rejects.toBe(startupFailure);

            const retry = startBackendServer(0);
            expect(retry).not.toBe(firstStartup);
            await expect(retry).rejects.toBe(startupFailure);
        } finally {
            await stopBackendServer();
            releaseSpy.mockRestore();
            errorSpy.mockRestore();
            process.exitCode = originalExitCode;
        }
    });

    it("starts, stops, and handles web shutdown signals with isolated runtime state", async () => {
        const environmentKeys = [
            "MIRA_DASHBOARD_DB_PATH",
            "MIRA_DASHBOARD_DEV_SAFE_MODE",
            "MIRA_DASHBOARD_FRONTEND_PATH",
            "NODE_ENV",
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
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.NODE_ENV = "test";
        process.env.OPENCLAW_HOME = openclawRoot;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const { runBackendServer, startBackendServer, stopBackendServer } =
                await import("../src/serverStart.ts");

            const firstStartup = startBackendServer(0);
            const concurrentStartup = startBackendServer(0);
            expect(concurrentStartup).toBe(firstStartup);
            await concurrentStartup;
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

    it("exits the direct web process after graceful shutdown when another handle remains", async () => {
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-server-process-"));
        const frontendRoot = path.join(temporaryRoot, "frontend");
        const openclawRoot = path.join(temporaryRoot, "openclaw");
        const preloadPath = path.join(temporaryRoot, "retained-handle.ts");
        mkdirSync(frontendRoot, { recursive: true });
        mkdirSync(openclawRoot, { recursive: true });
        writeFileSync(path.join(frontendRoot, "index.html"), "<!doctype html>");
        writeFileSync(path.join(openclawRoot, "openclaw.json"), "{}\n");
        writeFileSync(preloadPath, "setInterval(() => {}, 1_000);\n");

        const portReservation = Bun.serve({
            fetch: () => new Response("reserved"),
            hostname: "127.0.0.1",
            port: 0,
        });
        const port = portReservation.port;
        await portReservation.stop(true);

        const child = Bun.spawn({
            cmd: [
                process.execPath,
                "--preload",
                preloadPath,
                path.resolve(import.meta.dirname, "../src/serverStart.ts"),
            ],
            cwd: path.resolve(import.meta.dirname, ".."),
            env: {
                ...process.env,
                MIRA_DASHBOARD_ALLOWED_ORIGINS: "",
                MIRA_DASHBOARD_AUTOMATION_CREDENTIALS: "",
                MIRA_DASHBOARD_DB_PATH: path.join(temporaryRoot, "dashboard.db"),
                MIRA_DASHBOARD_DEV_SAFE_MODE: "1",
                MIRA_DASHBOARD_FRONTEND_PATH: frontendRoot,
                MIRA_DASHBOARD_OPENCLAW_HOME: path.join(temporaryRoot, "openclaw-client"),
                MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY: new Uint8Array(32)
                    .fill(9)
                    .toBase64(),
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "",
                NODE_ENV: "development",
                OPENCLAW_GATEWAY_TOKEN: "",
                OPENCLAW_HOME: openclawRoot,
                PORT: String(port),
            },
            stderr: "pipe",
            stdin: "ignore",
            stdout: "ignore",
        });
        const stderrText = new Response(child.stderr).text();

        let hasChildExited = false;
        try {
            let isReady = false;
            for (let attempt = 0; attempt < 100; attempt += 1) {
                try {
                    const response = await fetch(
                        `http://127.0.0.1:${port}/api/health/live`,
                        {
                            signal: AbortSignal.timeout(100),
                        }
                    );
                    if (response.ok) {
                        isReady = true;
                        break;
                    }
                } catch {
                    // Ignore transient connection errors while the process starts.
                }
                await Bun.sleep(25);
            }
            if (!isReady) {
                child.kill("SIGKILL");
                await child.exited;
                hasChildExited = true;
                throw new Error(
                    `Direct web process did not become healthy.\n${await stderrText}`
                );
            }

            child.kill("SIGTERM");
            const waitForExit = async () => ({
                didExit: true as const,
                exitCode: await child.exited,
            });
            const waitForTimeout = async () => {
                await Bun.sleep(1500);
                return {
                    didExit: false as const,
                    exitCode: undefined,
                };
            };
            const result = await Promise.race([waitForExit(), waitForTimeout()]);
            if (!result.didExit) {
                child.kill("SIGKILL");
                await child.exited;
                hasChildExited = true;
                throw new Error(
                    `Direct web process did not exit after SIGTERM.\n${await stderrText}`
                );
            }
            hasChildExited = true;
            const childStderr = await stderrText;
            if (result.exitCode !== 0) {
                throw new Error(
                    `Direct web process exited with status ${result.exitCode}.\n${childStderr}`
                );
            }
            expect(result).toEqual({ didExit: true, exitCode: 0 });
        } finally {
            if (!hasChildExited) {
                child.kill("SIGKILL");
                await child.exited;
            }
            await stderrText;
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });

    it("wires Bun server websocket hooks and static fallbacks", async () => {
        const originalFrontendPath = process.env.MIRA_DASHBOARD_FRONTEND_PATH;
        const originalDevelopmentSafeMode = process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
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
        let getAuthSessionSpy:
            { mockClear: () => void; mockRestore: () => void } | undefined;
        let deploymentCutoverSpy: { mockRestore: () => void } | undefined;
        let isDeploymentCutoverActive = false;
        try {
            const now = new Date().toISOString();
            const authModule = await import("../src/auth.ts");
            getAuthSessionSpy = jest
                .spyOn(authModule, "getAuthSessionFromSessionId")
                .mockReturnValue({
                    authMethod: "webauthn",
                    authenticatedAt: now,
                    createdAt: now,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    id: 7,
                    lastSeenAt: now,
                    mfaEnabled: true,
                    mfaVerifiedAt: now,
                    sessionId: "dev-session",
                    username: "mira",
                });
            const gatewayModule = await import("../src/gateway.ts");
            handleDashboardClientSpy = jest
                .spyOn(gatewayModule.default, "handleDashboardClient")
                .mockImplementation(() => {});
            const deploymentCutoverModule =
                await import("../src/services/deploymentCutoverState.ts");
            deploymentCutoverSpy = jest
                .spyOn(deploymentCutoverModule, "isProductionDeploymentCutoverActive")
                .mockImplementation(() => isDeploymentCutoverActive);
            const { createServer } = await import("../src/server.ts");
            const optionsSymbol = Symbol.for("mira.test.options");
            const server = createServer(0, "127.0.0.1") as Server<unknown> & {
                [optionsSymbol]: {
                    fetch: (
                        request: Request,
                        server: Server<unknown>
                    ) => Promise<Response> | Response;
                    hostname?: string;
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
                                sessionToken?: string;
                                socket?: unknown;
                                userId?: number;
                            };
                            readyState: number;
                            send: (data: string) => void;
                        }) => void;
                    };
                };
            };
            const options = server[optionsSymbol];
            expect(options.hostname).toBe("127.0.0.1");

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

            isDeploymentCutoverActive = true;
            const wsDuringCutover = await options.fetch(
                new Request("https://test.local/ws", {
                    headers: { Origin: "https://test.local" },
                }),
                server
            );
            expect(wsDuringCutover.status).toBe(503);
            expect(wsDuringCutover.headers.get("retry-after")).toBe("5");
            isDeploymentCutoverActive = false;

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
                    sessionToken?: string;
                    socket?: {
                        close: (code?: number, reason?: string) => void;
                        send: (data: string) => void;
                    };
                    userId?: number;
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

            closeSpy.mockClear();
            messageHandler.mockClear();
            isDeploymentCutoverActive = true;
            options.websocket.open(ws);
            expect(closeSpy).toHaveBeenCalledWith(
                1012,
                "Dashboard release cutover in progress"
            );
            expect(handleDashboardClientSpy).toHaveBeenCalledTimes(1);

            closeSpy.mockClear();
            getAuthSessionSpy.mockClear();
            ws.data.sessionToken = "dev-session";
            ws.data.userId = 7;
            options.websocket.message(
                ws,
                JSON.stringify({
                    id: "cutover-request",
                    method: "chat.send",
                    type: "request",
                    userActivity: true,
                })
            );
            expect(closeSpy).toHaveBeenCalledWith(
                1012,
                "Dashboard release cutover in progress"
            );
            expect(getAuthSessionSpy).not.toHaveBeenCalled();
            expect(messageHandler).not.toHaveBeenCalled();
            isDeploymentCutoverActive = false;
            delete ws.data.sessionToken;
            delete ws.data.userId;

            closeSpy.mockClear();
            options.websocket.message(ws, new TextEncoder().encode("hello"));
            expect(closeSpy).toHaveBeenCalledWith(
                4401,
                "Dashboard session is no longer valid"
            );

            closeSpy.mockClear();
            messageHandler.mockClear();
            sendSpy.mockClear();
            process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";
            ws.data.sessionToken = "dev-session";
            ws.data.userId = 7;
            options.websocket.message(
                ws,
                JSON.stringify({
                    id: "blocked-request",
                    method: "config.patch",
                    type: "request",
                })
            );
            expect(closeSpy).not.toHaveBeenCalled();
            expect(messageHandler).not.toHaveBeenCalled();
            expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toEqual({
                code: "development_method_blocked",
                error: "This Gateway action is disabled in Dashboard dev",
                id: "blocked-request",
                isOk: false,
                type: "response",
            });

            options.websocket.message(
                ws,
                JSON.stringify({
                    id: "allowed-request",
                    method: "chat.send",
                    type: "request",
                })
            );
            expect(messageHandler).toHaveBeenCalledWith(
                expect.stringContaining('"method":"chat.send"')
            );

            options.websocket.error(ws, new Error("boom"));
            options.websocket.close(ws);
            expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
            expect(closeHandler).toHaveBeenCalled();
        } finally {
            deploymentCutoverSpy?.mockRestore();
            getAuthSessionSpy?.mockRestore();
            handleDashboardClientSpy?.mockRestore();
            serveSpy.mockRestore();
            if (originalFrontendPath === undefined) {
                delete process.env.MIRA_DASHBOARD_FRONTEND_PATH;
            } else {
                process.env.MIRA_DASHBOARD_FRONTEND_PATH = originalFrontendPath;
            }
            if (originalDevelopmentSafeMode === undefined) {
                delete process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
            } else {
                process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = originalDevelopmentSafeMode;
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });
});
