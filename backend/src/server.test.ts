import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { db, ensureTaskAutomationColumn } from "./db.js";
import gateway from "./gateway.js";
import {
    __testing as scheduledJobsTesting,
    stopScheduledJobScheduler,
} from "./services/scheduledJobs.js";

let originalPort: string | undefined;
let originalTrustProxy: string | undefined;
let originalOpenClawHome: string | undefined;
let originalDashboardOpenClawHome: string | undefined;
let originalGatewayToken: { value: string } | undefined;
let openclawHome: string | undefined;
const ENTRYPOINT_SHUTDOWN_TIMEOUT_MS = 3_000;
const ENTRYPOINT_START_TIMEOUT_MS = 5_000;
const ENTRYPOINT_PORT_ATTEMPTS = 5;
const require = createRequire(import.meta.url);
const TSX_LOADER_PATH = require.resolve("tsx");

let apiAuthMiddleware: (typeof import("./server.js"))["apiAuthMiddleware"];
let handleWebSocketConnection: (typeof import("./server.js"))["handleWebSocketConnection"];
let parseTrustProxy: (typeof import("./server.js"))["parseTrustProxy"];
let resolveBackendCommit: (typeof import("./server.js"))["resolveBackendCommit"];
let resolveListenPort: (typeof import("./server.js"))["resolveListenPort"];
let server: (typeof import("./server.js"))["server"];
let sessionsHandler: (typeof import("./server.js"))["sessionsHandler"];
let handleServerListening: (typeof import("./serverStart.js"))["handleServerListening"];
let isDirectEntrypoint: (typeof import("./serverStart.js"))["isDirectEntrypoint"];
let serverStartTesting: (typeof import("./serverStart.js"))["__testing"];
let shouldStartOnImport: (typeof import("./serverStart.js"))["shouldStartOnImport"];
let startBackendServer: (typeof import("./serverStart.js"))["startBackendServer"];

function getBaseUrl(): string {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
}

async function requestJson<T>(pathName: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${getBaseUrl()}${pathName}`);

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

async function assertChildStillRunning(
    child: ReturnType<typeof spawn>,
    timeoutMs = ENTRYPOINT_START_TIMEOUT_MS
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            assert.fail("Process exited prematurely");
        }
        await delay(50);
    }
    assert.equal(child.exitCode, null);
}

async function getFreePort(): Promise<number> {
    const portServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
        portServer.once("error", reject);
        portServer.listen(0, "127.0.0.1", resolve);
    });
    const address = portServer.address();
    assert.ok(address && typeof address === "object");
    await new Promise<void>((resolve, reject) => {
        portServer.close((error) => (error ? reject(error) : resolve()));
    });
    return address.port;
}

async function waitForChildHealth(
    child: ReturnType<typeof spawn>,
    port: number,
    getOutput = () => "",
    timeoutMs = ENTRYPOINT_START_TIMEOUT_MS
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            assert.fail(`Process exited before serving health checks\n${getOutput()}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (response.ok) {
                return;
            }
        } catch {
            // The listener is not ready yet.
        }
        await delay(50);
    }
    await assertChildStillRunning(child, 0);
    assert.fail(`Timed out waiting for entrypoint health check\n${getOutput()}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
    let exited = child.exitCode !== null || child.signalCode !== null;
    if (!exited) {
        const exitPromise = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        exited =
            (await Promise.race([
                exitPromise.then(() => true),
                delay(ENTRYPOINT_SHUTDOWN_TIMEOUT_MS).then(() => false),
            ])) === true;
    }
    exited ||= child.exitCode !== null || child.signalCode !== null;
    if (!exited) {
        const exitPromise = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exitPromise;
    }
}

async function startEntrypointChild(
    serverStartEntrypoint: string,
    env: NodeJS.ProcessEnv,
    cwd = process.cwd()
): Promise<{ child: ReturnType<typeof spawn>; getOutput: () => string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ENTRYPOINT_PORT_ATTEMPTS; attempt += 1) {
        const port = await getFreePort();
        let childOutput = "";
        const child = spawn(
            process.execPath,
            ["--import", TSX_LOADER_PATH, serverStartEntrypoint],
            {
                cwd,
                env: {
                    ...env,
                    PORT: String(port),
                },
                stdio: ["ignore", "pipe", "pipe"],
            }
        );
        child.stdout?.on("data", (data) => {
            childOutput += String(data);
        });
        child.stderr?.on("data", (data) => {
            childOutput += String(data);
        });
        const getOutput = () => childOutput;
        try {
            await waitForChildHealth(child, port, getOutput);
            return { child, getOutput };
        } catch (error) {
            lastError = error;
            await stopChild(child);
            if (
                !/\bEADDRINUSE\b/.test(childOutput) ||
                attempt === ENTRYPOINT_PORT_ATTEMPTS
            ) {
                throw error;
            }
        }
    }

    throw lastError;
}

async function restoreBootstrapState(): Promise<void> {
    if (openclawHome) {
        await rm(openclawHome, { recursive: true, force: true });
        openclawHome = undefined;
    }

    if (originalPort === undefined) {
        delete process.env.PORT;
    } else {
        process.env.PORT = originalPort;
    }
    if (originalTrustProxy === undefined) {
        delete process.env.TRUST_PROXY;
    } else {
        process.env.TRUST_PROXY = originalTrustProxy;
    }
    if (originalOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
    } else {
        process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
    if (originalDashboardOpenClawHome === undefined) {
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
    } else {
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = originalDashboardOpenClawHome;
    }

    db.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
    if (originalGatewayToken) {
        db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?)"
        ).run(originalGatewayToken.value, new Date().toISOString());
    }
}

describe("server bootstrap", () => {
    before(async () => {
        originalPort = process.env.PORT;
        originalTrustProxy = process.env.TRUST_PROXY;
        originalOpenClawHome = process.env.OPENCLAW_HOME;
        originalDashboardOpenClawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        originalGatewayToken = db
            .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
            .get() as { value: string } | undefined;

        try {
            process.env.PORT = "0";
            process.env.TRUST_PROXY = "2";
            openclawHome = await mkdtemp(path.join(os.tmpdir(), "mira-server-openclaw-"));
            await mkdir(path.join(openclawHome, "media"));
            process.env.OPENCLAW_HOME = openclawHome;
            delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            db.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();

            ({
                apiAuthMiddleware,
                handleWebSocketConnection,
                parseTrustProxy,
                resolveBackendCommit,
                resolveListenPort,
                server,
                sessionsHandler,
            } = await import("./server.js"));
            ({
                handleServerListening,
                __testing: serverStartTesting,
                isDirectEntrypoint,
                shouldStartOnImport,
                startBackendServer,
            } = await import("./serverStart.js"));
        } catch (error) {
            await restoreBootstrapState();
            throw error;
        }

        if (server.listening) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const onListening = () => {
                server.off("error", onError);
                resolve();
            };
            const onError = (error: Error) => {
                server.off("listening", onListening);
                reject(error);
            };
            server.once("listening", onListening);
            server.once("error", onError);
            server.listen(0);
        });
    });

    after(async () => {
        try {
            if (server?.listening) {
                await new Promise<void>((resolve, reject) => {
                    server.close((error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    });
                });
            }
        } finally {
            await restoreBootstrapState();
        }
    });

    it("parses trust proxy environment values", () => {
        assert.equal(parseTrustProxy(), "loopback");
        assert.equal(parseTrustProxy("  "), "loopback");
        assert.equal(parseTrustProxy("true"), true);
        assert.equal(parseTrustProxy("FALSE"), false);
        assert.equal(parseTrustProxy("2"), 2);
        assert.equal(parseTrustProxy("0"), 0);
        assert.equal(parseTrustProxy("255"), 255);
        assert.equal(parseTrustProxy("256"), "loopback");
        assert.equal(parseTrustProxy("999999999999999999999999999999"), "loopback");
        assert.equal(parseTrustProxy("0010"), 10);
        assert.equal(parseTrustProxy("+2"), "+2");
        assert.equal(parseTrustProxy("0x10"), "0x10");
        assert.equal(parseTrustProxy("1e2"), "1e2");
        assert.equal(parseTrustProxy("public-proxy"), "public-proxy");
        assert.equal(parseTrustProxy(" loopback "), "loopback");
        assert.equal(resolveListenPort("1234"), 1234);
        assert.equal(resolveListenPort(" 3100 "), 3100);
        assert.equal(resolveListenPort("0"), 0);
        assert.equal(resolveListenPort(""), 3100);
        assert.equal(resolveListenPort("dashboard.sock"), 3100);
        assert.equal(resolveListenPort("1234abc"), 3100);
        assert.equal(resolveListenPort("65536"), 3100);
        const configuredPort = process.env.PORT;
        delete process.env.PORT;
        try {
            assert.equal(resolveListenPort(), 3100);
        } finally {
            if (configuredPort === undefined) {
                delete process.env.PORT;
            } else {
                process.env.PORT = configuredPort;
            }
        }
    });

    it("covers database migration and commit fallback helpers", async () => {
        const executedSql: string[] = [];
        await ensureTaskAutomationColumn({
            exec: (sql) => executedSql.push(sql),
            prepare: () => ({
                all: () => [{ name: "id" }],
            }),
        });
        assert.equal(executedSql.length, 1);

        executedSql.length = 0;
        let initialLockedPrepareCalls = 0;
        await ensureTaskAutomationColumn({
            exec: (sql) => executedSql.push(sql),
            prepare: () => ({
                all: () => {
                    initialLockedPrepareCalls += 1;
                    if (initialLockedPrepareCalls === 1) {
                        throw new Error("database is locked");
                    }
                    return [{ name: "id" }];
                },
            }),
        });
        assert.equal(initialLockedPrepareCalls, 1);
        assert.equal(executedSql.length, 1);

        executedSql.length = 0;
        let tableLockedPrepareCalls = 0;
        await ensureTaskAutomationColumn({
            exec: (sql) => executedSql.push(sql),
            prepare: () => ({
                all: () => {
                    tableLockedPrepareCalls += 1;
                    if (tableLockedPrepareCalls === 1) {
                        throw new Error("database table is locked");
                    }
                    return [{ name: "id" }];
                },
            }),
        });
        assert.equal(tableLockedPrepareCalls, 1);
        assert.equal(executedSql.length, 1);

        const initialPrepareError = new Error("schema unavailable");
        await assert.rejects(
            () =>
                ensureTaskAutomationColumn({
                    exec: () => {},
                    prepare: () => ({
                        all: () => {
                            throw initialPrepareError;
                        },
                    }),
                }),
            initialPrepareError
        );

        executedSql.length = 0;
        await ensureTaskAutomationColumn({
            exec: (sql) => executedSql.push(sql),
            prepare: () => ({
                all: () => [{ name: "automation_json" }],
            }),
        });
        assert.deepEqual(executedSql, []);

        let lockedAttempts = 0;
        await ensureTaskAutomationColumn({
            exec: () => {
                lockedAttempts += 1;
                if (lockedAttempts < 3) {
                    const error = new Error("database is locked") as Error & {
                        code: string;
                    };
                    error.code = "SQLITE_LOCKED";
                    throw error;
                }
            },
            prepare: () => ({
                all: () => [{ name: "id" }],
            }),
        });
        assert.equal(lockedAttempts, 3);

        let concurrentPrepareChecks = 0;
        await ensureTaskAutomationColumn({
            exec: () => {
                throw new Error("SQLITE_BUSY");
            },
            prepare: () => ({
                all: () => {
                    concurrentPrepareChecks += 1;
                    return concurrentPrepareChecks >= 2
                        ? [{ name: "automation_json" }]
                        : [{ name: "id" }];
                },
            }),
        });
        assert.equal(concurrentPrepareChecks, 2);

        let transientRecheckAttempts = 0;
        await ensureTaskAutomationColumn({
            exec: () => {
                transientRecheckAttempts += 1;
                if (transientRecheckAttempts === 1) {
                    throw new Error("SQLITE_BUSY");
                }
            },
            prepare: () => ({
                all: () => {
                    if (transientRecheckAttempts === 1) {
                        throw new Error("SQLITE_BUSY");
                    }
                    return [{ name: "id" }];
                },
            }),
        });
        assert.equal(transientRecheckAttempts, 2);

        const recheckError = new Error("recheck failed");
        let recheckPrepareCalls = 0;
        await assert.rejects(
            () =>
                ensureTaskAutomationColumn({
                    exec: () => {
                        throw new Error("SQLITE_BUSY");
                    },
                    prepare: () => ({
                        all: () => {
                            recheckPrepareCalls += 1;
                            if (recheckPrepareCalls === 1) {
                                return [{ name: "id" }];
                            }
                            throw recheckError;
                        },
                    }),
                }),
            recheckError
        );

        const nonTransientError = new Error("disk unavailable");
        await assert.rejects(
            () =>
                ensureTaskAutomationColumn({
                    exec: () => {
                        throw nonTransientError;
                    },
                    prepare: () => ({
                        all: () => [{ name: "id" }],
                    }),
                }),
            nonTransientError
        );

        await assert.rejects(
            () =>
                ensureTaskAutomationColumn({
                    exec: () => {
                        throw "SQLITE_LOCKED";
                    },
                    prepare: () => ({
                        all: () => [{ name: "id" }],
                    }),
                }),
            /SQLITE_LOCKED/u
        );

        await assert.rejects(
            () =>
                ensureTaskAutomationColumn({
                    exec: () => {
                        throw new Error("SQLITE_BUSY");
                    },
                    prepare: () => ({
                        all: () => [{ name: "id" }],
                    }),
                }),
            /SQLITE_BUSY/u
        );

        let finalCheckCalls = 0;
        await assert.rejects(
            () =>
                ensureTaskAutomationColumn({
                    exec: () => {
                        throw new Error("SQLITE_BUSY");
                    },
                    prepare: () => ({
                        all: () => {
                            finalCheckCalls += 1;
                            if (finalCheckCalls === 6) {
                                throw new Error("final check unavailable");
                            }
                            return [{ name: "id" }];
                        },
                    }),
                }),
            /SQLITE_BUSY/u
        );
        assert.equal(finalCheckCalls, 6);

        let resolvedAfterRetries = 0;
        let resolvedAfterRetryChecks = 0;
        await ensureTaskAutomationColumn({
            exec: () => {
                resolvedAfterRetries += 1;
                throw new Error("SQLITE_BUSY");
            },
            prepare: () => ({
                all: () => {
                    resolvedAfterRetryChecks += 1;
                    return resolvedAfterRetryChecks >= 6
                        ? [{ name: "automation_json" }]
                        : [{ name: "id" }];
                },
            }),
        });
        assert.equal(resolvedAfterRetries, 4);

        await ensureTaskAutomationColumn({
            exec: () => {
                throw new Error("duplicate column name: automation_json");
            },
            prepare: () => ({
                all: () => [{ name: "id" }],
            }),
        });

        assert.equal(
            resolveBackendCommit("/missing", () => {
                throw new Error("git unavailable");
            }),
            "unknown"
        );
        assert.equal(
            resolveBackendCommit("/repo", () => Buffer.from("abc123\n")),
            "abc123"
        );
    });

    it("serves health endpoints without auth", async () => {
        for (const pathName of ["/health", "/api/health"]) {
            const response = await requestJson<{
                status: string;
                gatewayConnected: boolean;
                sessionCount: number;
                backendCommit: string;
            }>(pathName);

            assert.equal(response.status, 200);
            assert.equal(response.body.status, "ok");
            assert.equal(typeof response.body.gatewayConnected, "boolean");
            assert.equal(typeof response.body.sessionCount, "number");
            assert.equal(typeof response.body.backendCommit, "string");
        }
    });

    it("allows loopback API session and WebSocket access", async () => {
        const sessions = await requestJson<unknown[]>("/api/sessions");

        assert.equal(sessions.status, 200);
        assert.ok(Array.isArray(sessions.body));

        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(getBaseUrl().replace("http:", "ws:"));

            ws.once("open", () => {
                ws.close();
                resolve();
            });
            ws.once("error", reject);
        });
    });

    it("lets config-file writes use the route-specific JSON parser", async () => {
        const originalHome = process.env.HOME;
        const originalOpenClawHome = process.env.OPENCLAW_HOME;
        const originalRouteOpenClawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const tempHome = await mkdtemp(path.join(os.tmpdir(), "mira-server-home-"));
        const configRoot = path.join(tempHome, ".openclaw");
        const configPath = path.join(configRoot, "openclaw.json");
        const largeContent = "a".repeat(2 * 1024 * 1024);

        try {
            await mkdir(configRoot, { recursive: true });
            await writeFile(configPath, "{}", "utf8");
            process.env.HOME = tempHome;
            process.env.OPENCLAW_HOME = configRoot;
            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = configRoot;

            const response = await fetch(
                `${getBaseUrl()}/api/config-files/openclaw.json`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content: largeContent }),
                }
            );

            assert.equal(response.status, 200);
            assert.equal(await readFile(configPath, "utf8"), largeContent);
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalRouteOpenClawHome === undefined) {
                delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            } else {
                process.env.MIRA_DASHBOARD_OPENCLAW_HOME = originalRouteOpenClawHome;
            }
            if (originalOpenClawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenClawHome;
            }
            await rm(tempHome, { recursive: true, force: true });
        }
    });

    it("lets file writes use the route-specific JSON parser", async () => {
        const filePath = `.server-json-bypass-${Date.now()}.txt`;
        const largeEscapedContent = "\\".repeat(1024 * 1024);
        assert.ok(openclawHome);
        const workspaceFile = path.join(openclawHome, "workspace", filePath);

        try {
            const response = await fetch(`${getBaseUrl()}/api/files/${filePath}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: largeEscapedContent }),
            });

            assert.equal(response.status, 200);
            assert.equal(await readFile(workspaceFile, "utf8"), largeEscapedContent);
        } finally {
            await rm(workspaceFile, { force: true });
        }
    });

    it("lets job patches use the route-specific JSON parser", async () => {
        const largePayload = "x".repeat(150_000);
        const response = await fetch(`${getBaseUrl()}/api/jobs/cache.weather`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ patch: { padding: largePayload } }),
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            error: "invalid patch field: padding",
        });
    });

    it("covers non-loopback auth and startup handler branches", () => {
        const responses: Array<{ status?: number; body?: unknown }> = [];
        const response = {
            json: (body: unknown) => {
                responses.at(-1)!.body = body;
                return response;
            },
            status: (status: number) => {
                responses.push({ status });
                return response;
            },
        };
        const request = {
            headers: {},
            path: "/sessions",
            socket: { remoteAddress: "203.0.113.10" },
        };

        sessionsHandler(request as never, response as never, () => {});
        assert.deepEqual(responses.at(-1), {
            status: 401,
            body: { error: "Unauthorized" },
        });

        let nextCalled = false;
        apiAuthMiddleware({ path: "/auth/login" } as never, response as never, () => {
            nextCalled = true;
        });
        assert.equal(nextCalled, true);

        apiAuthMiddleware(
            { ...request, path: "/authorize" } as never,
            response as never,
            () => {}
        );
        assert.deepEqual(responses.at(-1), {
            status: 401,
            body: { error: "Unauthorized" },
        });

        apiAuthMiddleware(request as never, response as never, () => {});
        assert.deepEqual(responses.at(-1), {
            status: 401,
            body: { error: "Unauthorized" },
        });

        const closes: Array<{ code?: number; reason?: string }> = [];
        handleWebSocketConnection(
            {
                close: (code?: number, reason?: string) => {
                    closes.push({ code, reason });
                },
            } as unknown as WebSocket,
            request as unknown as http.IncomingMessage
        );
        assert.deepEqual(closes.at(-1), { code: 4401, reason: "Unauthorized" });
    });

    it("runs every installed server close cleanup", async () => {
        const calls: string[] = [];
        serverStartTesting.removeCloseCleanup();
        try {
            serverStartTesting.installCloseCleanup(() => {
                calls.push("first");
            });
            serverStartTesting.installCloseCleanup(() => {
                calls.push("second");
            });
            server.emit("close");
            await serverStartTesting.waitForCloseCleanups();
            assert.deepEqual(calls, ["first", "second"]);
            await serverStartTesting.waitForCloseCleanups();
            assert.deepEqual(calls, ["first", "second"]);
            server.emit("close");
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(calls, ["first", "second"]);
        } finally {
            serverStartTesting.removeCloseCleanup();
        }
    });

    it("removes the most recently installed matching server close cleanup", () => {
        const calls: string[] = [];
        const cleanup = () => {
            calls.push("cleanup");
        };
        serverStartTesting.removeCloseCleanup();
        try {
            serverStartTesting.installCloseCleanup(cleanup);
            const removeLatest = serverStartTesting.installCloseCleanup(cleanup);
            removeLatest();
            server.emit("close");
            assert.deepEqual(calls, ["cleanup"]);
        } finally {
            serverStartTesting.removeCloseCleanup();
        }
    });

    it("logs async server close cleanup failures", async () => {
        const errors: unknown[][] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };
        serverStartTesting.removeCloseCleanup();
        try {
            serverStartTesting.installCloseCleanup(async () => {
                throw new Error("async cleanup failed");
            });
            server.emit("close");
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
                errors.some((entry) =>
                    String(entry[0]).includes("Failed to run server close cleanup")
                ),
                true
            );
        } finally {
            console.error = originalConsoleError;
            serverStartTesting.removeCloseCleanup();
        }
    });

    it("keeps rollback close cleanup installed when server close fails", async () => {
        const originalClose = server.close;
        const calls: string[] = [];
        serverStartTesting.removeCloseCleanup();
        serverStartTesting.installCloseCleanup(() => {
            calls.push("cleanup");
        });
        server.close = ((callback?: (error?: Error) => void) => {
            callback?.(new Error("close failed"));
            return server;
        }) as unknown as typeof server.close;

        try {
            await assert.rejects(
                () => serverStartTesting.closeServerForRollback(),
                /close failed/u
            );
            assert.deepEqual(calls, []);
            server.emit("close");
            await serverStartTesting.waitForCloseCleanups();
            assert.deepEqual(calls, ["cleanup"]);
        } finally {
            server.close = originalClose;
            serverStartTesting.removeCloseCleanup();
        }
    });

    it("starts runtime services from the entrypoint helpers", async () => {
        const originalInit = gateway.init;
        const originalListen = server.listen;
        const originalAddress = server.address;
        const originalClose = server.close;
        const originalListeningDescriptor = Object.getOwnPropertyDescriptor(
            server,
            "listening"
        );
        const originalToken = process.env.OPENCLAW_TOKEN;
        const originalStartOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT;
        const originalConsoleWarn = console.warn;
        const originalConsoleError = console.error;
        const originalSetInterval = globalThis.setInterval;
        const originalShutdown = gateway.shutdown;
        let initializedToken: string | undefined;
        let listenedPort: number | undefined;
        let closeCalled = false;
        let shutdownCalled = false;
        const warnings: unknown[][] = [];
        const errors: unknown[][] = [];
        gateway.init = (token: string) => {
            initializedToken = token;
        };
        console.warn = (...args: unknown[]) => {
            warnings.push(args);
        };
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };
        gateway.shutdown = () => {
            shutdownCalled = true;
        };
        scheduledJobsTesting.setActionExecutorForTests(async (job) => ({
            actionTarget: job.actionTarget,
        }));
        try {
            process.env.OPENCLAW_TOKEN = "test-token";
            await handleServerListening();
            assert.equal(initializedToken, "test-token");
            server.emit("close");
            await stopScheduledJobScheduler();
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(shutdownCalled, true);
            shutdownCalled = false;
            gateway.init = () => {
                throw new Error("gateway failed");
            };
            server.close = ((callback?: (error?: Error) => void) => {
                closeCalled = true;
                callback?.();
                return server;
            }) as unknown as typeof server.close;
            await assert.rejects(() => handleServerListening(), /gateway failed/u);
            assert.equal(closeCalled, true);
            assert.match(String(errors.at(-1)?.[0]), /Failed to start background/u);
            server.close = ((callback?: (error?: Error) => void) => {
                closeCalled = true;
                callback?.(new Error("close failed"));
                return server;
            }) as unknown as typeof server.close;
            await assert.rejects(() => handleServerListening(), /gateway failed/u);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(closeCalled, true);
            assert.equal(
                errors.some((entry) =>
                    String(entry[0]).includes("Failed to close server:")
                ),
                true
            );
            server.close = originalClose;
            closeCalled = false;
            gateway.init = (token: string) => {
                initializedToken = token;
            };
            let intervalCalls = 0;
            const originalSchedulerNodeEnv = process.env.NODE_ENV;
            globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
                intervalCalls += 1;
                if (intervalCalls === 1) {
                    throw new Error("scheduler failed");
                }
                return originalSetInterval(...args);
            }) as typeof setInterval;
            server.close = ((callback?: (error?: Error) => void) => {
                closeCalled = true;
                callback?.();
                return server;
            }) as unknown as typeof server.close;
            process.env.NODE_ENV = "production";
            try {
                await assert.rejects(() => handleServerListening(), /scheduler failed/u);
                assert.equal(closeCalled, true);
                assert.equal(shutdownCalled, true);
                await stopScheduledJobScheduler();
                globalThis.setInterval = originalSetInterval;
                closeCalled = false;
                shutdownCalled = false;
                serverStartTesting.setAfterBackgroundServicesStartedForTest(() => {
                    throw new Error("post scheduler failed");
                });
                await assert.rejects(
                    () => handleServerListening(),
                    /post scheduler failed/u
                );
                assert.equal(closeCalled, true);
                assert.equal(shutdownCalled, true);
            } finally {
                if (originalSchedulerNodeEnv === undefined) {
                    delete process.env.NODE_ENV;
                } else {
                    process.env.NODE_ENV = originalSchedulerNodeEnv;
                }
                globalThis.setInterval = originalSetInterval;
            }
            serverStartTesting.setAfterBackgroundServicesStartedForTest(undefined);
            await stopScheduledJobScheduler();
            gateway.shutdown = () => {
                throw new Error("shutdown cleanup failed");
            };
            server.close = (() => {
                throw new Error("server cleanup failed");
            }) as typeof server.close;
            serverStartTesting.setAfterBackgroundServicesStartedForTest(() => {
                throw new Error("post scheduler cleanup failed");
            });
            const originalCleanupNodeEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = "production";
            try {
                await assert.rejects(
                    () => handleServerListening(),
                    /post scheduler cleanup failed/u
                );
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(
                    errors.some((entry) =>
                        String(entry[0]).includes("Failed to stop gateway")
                    ),
                    true
                );
                assert.equal(
                    errors.some((entry) =>
                        String(entry[0]).includes("Failed to close server")
                    ),
                    true
                );
            } finally {
                if (originalCleanupNodeEnv === undefined) {
                    delete process.env.NODE_ENV;
                } else {
                    process.env.NODE_ENV = originalCleanupNodeEnv;
                }
            }
            serverStartTesting.setAfterBackgroundServicesStartedForTest(undefined);
            await stopScheduledJobScheduler();
            gateway.shutdown = originalShutdown;
            server.close = originalClose;
            gateway.init = (token: string) => {
                initializedToken = token;
            };
            delete process.env.OPENCLAW_TOKEN;
            initializedToken = undefined;
            await handleServerListening();
            assert.equal(initializedToken, undefined);
            assert.match(String(warnings.at(-1)?.[0]), /No gateway token/u);
            assert.equal(
                serverStartTesting.shouldStartScheduledJobs("development"),
                false
            );
            assert.equal(serverStartTesting.shouldStartScheduledJobs("test"), false);
            assert.equal(serverStartTesting.shouldStartScheduledJobs(), false);
            assert.equal(serverStartTesting.shouldStartScheduledJobs("production"), true);
            const originalDefaultNodeEnv = process.env.NODE_ENV;
            try {
                delete process.env.NODE_ENV;
                assert.equal(serverStartTesting.shouldStartScheduledJobs(), true);
            } finally {
                if (originalDefaultNodeEnv === undefined) {
                    delete process.env.NODE_ENV;
                } else {
                    process.env.NODE_ENV = originalDefaultNodeEnv;
                }
            }
            const originalProductionCleanupNodeEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = "production";
            try {
                await handleServerListening();
                server.emit("close");
                await new Promise((resolve) => setImmediate(resolve));
            } finally {
                if (originalProductionCleanupNodeEnv === undefined) {
                    delete process.env.NODE_ENV;
                } else {
                    process.env.NODE_ENV = originalProductionCleanupNodeEnv;
                }
                await stopScheduledJobScheduler();
            }
            const originalDisableScheduler = process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
            try {
                process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
                assert.equal(
                    serverStartTesting.shouldStartScheduledJobs("production"),
                    false
                );
            } finally {
                if (originalDisableScheduler === undefined) {
                    delete process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
                } else {
                    process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER =
                        originalDisableScheduler;
                }
            }
            const originalNodeEnv = process.env.NODE_ENV;
            let devModeIntervals = 0;
            globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
                devModeIntervals += 1;
                return originalSetInterval(...args);
            }) as typeof setInterval;
            process.env.NODE_ENV = "development";
            try {
                await handleServerListening();
                assert.equal(devModeIntervals, 0);
            } finally {
                if (originalNodeEnv === undefined) {
                    delete process.env.NODE_ENV;
                } else {
                    process.env.NODE_ENV = originalNodeEnv;
                }
                globalThis.setInterval = originalSetInterval;
                await stopScheduledJobScheduler();
            }

            server.listen = ((port: number, listener?: () => void) => {
                listenedPort = port;
                listener?.();
                return server;
            }) as typeof server.listen;
            server.address = (() => null) as typeof server.address;
            Object.defineProperty(server, "listening", {
                configurable: true,
                value: false,
            });

            startBackendServer(41_001);
            assert.equal(listenedPort, 41_001);
            server.emit("listening");
            const originalExitCode = process.exitCode;
            try {
                process.exitCode = undefined;
                serverStartTesting.setAfterBackgroundServicesStartedForTest(() => {
                    throw new Error("background startup failed");
                });
                server.close = ((callback?: (error?: Error) => void) => {
                    callback?.();
                    return server;
                }) as unknown as typeof server.close;
                server.address = (() => null) as typeof server.address;
                startBackendServer(41_001);
                server.emit("listening");
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(process.exitCode, 1);
            } finally {
                process.exitCode = originalExitCode;
            }
            serverStartTesting.setAfterBackgroundServicesStartedForTest(undefined);
            await stopScheduledJobScheduler();
            server.close = originalClose;
            server.address = (() => null) as typeof server.address;
            let pendingStartListenCalls = 0;
            server.listen = ((port: number) => {
                listenedPort = port;
                pendingStartListenCalls += 1;
                return server;
            }) as typeof server.listen;
            listenedPort = undefined;
            startBackendServer(41_003);
            startBackendServer(41_004);
            assert.equal(pendingStartListenCalls, 1);
            assert.equal(listenedPort, 41_003);
            try {
                (
                    server.listeners("error").at(-1) as
                        | ((error: Error) => void)
                        | undefined
                )?.(new Error("listen failed"));
                assert.equal(process.exitCode, 1);
            } finally {
                process.exitCode = originalExitCode;
            }
            startBackendServer(41_004);
            assert.equal(pendingStartListenCalls, 2);
            assert.equal(listenedPort, 41_004);
            server.emit("listening");
            server.listen = ((port: number) => {
                listenedPort = port;
                throw new Error("sync listen failed");
            }) as unknown as typeof server.listen;
            assert.throws(() => startBackendServer(41_005), /sync listen failed/u);
            assert.equal(listenedPort, 41_005);
            server.listen = ((port: number, listener?: () => void) => {
                listenedPort = port;
                listener?.();
                return server;
            }) as typeof server.listen;
            listenedPort = undefined;
            startBackendServer(41_006);
            assert.equal(listenedPort, 41_006);
            server.emit("listening");
            try {
                server.address = (() => ({
                    address: "127.0.0.1",
                    family: "IPv4",
                    port: 41_001,
                })) as typeof server.address;
                listenedPort = undefined;
                startBackendServer(41_002);
                assert.equal(listenedPort, undefined);
            } finally {
                server.address = originalAddress;
            }
            assert.equal(
                isDirectEntrypoint("/tmp/serverStart.js", "file:///tmp/serverStart.js"),
                true
            );
            assert.equal(
                isDirectEntrypoint("/tmp/other.js", "file:///tmp/serverStart.js"),
                false
            );
            assert.equal(
                isDirectEntrypoint(undefined, "file:///tmp/serverStart.js"),
                false
            );
            assert.equal(shouldStartOnImport(), false);
            assert.equal(shouldStartOnImport(undefined, true), true);
            assert.equal(shouldStartOnImport("0", false), false);
            assert.equal(shouldStartOnImport("1", false), true);

            process.env.MIRA_DASHBOARD_START_ON_IMPORT = "1";
            assert.equal(shouldStartOnImport(), true);
            listenedPort = undefined;
            server.address = (() => null) as typeof server.address;
            await import(`./serverStart.js?entry=${Date.now()}`);
            assert.equal(listenedPort, undefined);
        } finally {
            if (originalToken === undefined) {
                delete process.env.OPENCLAW_TOKEN;
            } else {
                process.env.OPENCLAW_TOKEN = originalToken;
            }
            if (originalStartOnImport === undefined) {
                delete process.env.MIRA_DASHBOARD_START_ON_IMPORT;
            } else {
                process.env.MIRA_DASHBOARD_START_ON_IMPORT = originalStartOnImport;
            }
            gateway.init = originalInit;
            server.listen = originalListen;
            server.address = originalAddress;
            server.close = originalClose;
            globalThis.setInterval = originalSetInterval;
            gateway.shutdown = originalShutdown;
            scheduledJobsTesting.setActionExecutorForTests(undefined);
            serverStartTesting.setAfterBackgroundServicesStartedForTest(undefined);
            serverStartTesting.removeCloseCleanup();
            await stopScheduledJobScheduler();
            if (originalListeningDescriptor) {
                Object.defineProperty(server, "listening", originalListeningDescriptor);
            } else {
                delete (server as { listening?: boolean }).listening;
            }
            console.warn = originalConsoleWarn;
            console.error = originalConsoleError;
        }
    });

    it("does not start the server as a serverStart import side effect", async () => {
        const originalStartOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT;
        const originalListen = server.listen;
        const originalAddress = server.address;
        const originalListeningDescriptor = Object.getOwnPropertyDescriptor(
            server,
            "listening"
        );
        let listenedPort: number | undefined;
        server.listen = ((port: number) => {
            listenedPort = port;
            return server;
        }) as typeof server.listen;
        server.address = (() => null) as typeof server.address;
        Object.defineProperty(server, "listening", {
            configurable: true,
            value: false,
        });
        try {
            process.env.MIRA_DASHBOARD_START_ON_IMPORT = "1";
            await import(`./serverStart.js?noStart=${Date.now()}`);
            assert.equal(listenedPort, undefined);
        } finally {
            server.listen = originalListen;
            server.address = originalAddress;
            if (originalListeningDescriptor) {
                Object.defineProperty(server, "listening", originalListeningDescriptor);
            } else {
                delete (server as { listening?: boolean }).listening;
            }
            if (originalStartOnImport === undefined) {
                delete process.env.MIRA_DASHBOARD_START_ON_IMPORT;
            } else {
                process.env.MIRA_DASHBOARD_START_ON_IMPORT = originalStartOnImport;
            }
        }
    });

    it("starts only from the executable entrypoint", async () => {
        const originalStartOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT;
        const originalListen = server.listen;
        const originalAddress = server.address;
        const originalListeningDescriptor = Object.getOwnPropertyDescriptor(
            server,
            "listening"
        );
        let listenedPort: number | undefined;
        server.listen = ((port: number) => {
            listenedPort = port;
            return server;
        }) as typeof server.listen;
        server.address = (() => null) as typeof server.address;
        Object.defineProperty(server, "listening", {
            configurable: true,
            value: false,
        });
        try {
            delete process.env.MIRA_DASHBOARD_START_ON_IMPORT;
            await import(`./main.js?noStart=${Date.now()}`);
            assert.equal(listenedPort, undefined);

            process.env.MIRA_DASHBOARD_START_ON_IMPORT = "1";
            await import(`./main.js?start=${Date.now()}`);
            assert.equal(listenedPort, 0);
        } finally {
            server.listen = originalListen;
            server.address = originalAddress;
            if (originalListeningDescriptor) {
                Object.defineProperty(server, "listening", originalListeningDescriptor);
            } else {
                delete (server as { listening?: boolean }).listening;
            }
            if (originalStartOnImport === undefined) {
                delete process.env.MIRA_DASHBOARD_START_ON_IMPORT;
            } else {
                process.env.MIRA_DASHBOARD_START_ON_IMPORT = originalStartOnImport;
            }
        }
    });

    it("runs the startup entrypoint directly", async () => {
        const serverStartEntrypoint = fileURLToPath(new URL("main.ts", import.meta.url));
        const entrypointCwd = await mkdtemp(path.join(os.tmpdir(), "mira-server-cwd-"));
        const { child } = await startEntrypointChild(
            serverStartEntrypoint,
            {
                ...process.env,
                NODE_V8_COVERAGE: path.join(
                    os.tmpdir(),
                    "mira-server-entrypoint-coverage"
                ),
                OPENCLAW_TOKEN: "test-token",
                OPENCLAW_HOME: openclawHome,
                MIRA_DASHBOARD_OPENCLAW_HOME: openclawHome,
                MIRA_DASHBOARD_DB_PATH: path.join(
                    entrypointCwd,
                    "data",
                    "mira-dashboard.db"
                ),
            },
            entrypointCwd
        );
        try {
            await assertChildStillRunning(child, 0);
        } finally {
            await stopChild(child);
            await rm(entrypointCwd, { recursive: true, force: true });
        }
    });

    it("loads dotenv before route imports bind the dashboard database", async () => {
        const serverStartEntrypoint = fileURLToPath(new URL("main.ts", import.meta.url));
        const entrypointCwd = await mkdtemp(path.join(os.tmpdir(), "mira-server-env-"));
        const configuredDbPath = path.join(entrypointCwd, "env-db", "dashboard.db");
        const childEnv = { ...process.env };
        delete childEnv.MIRA_DASHBOARD_DB_PATH;
        delete childEnv.NODE_V8_COVERAGE;
        await writeFile(
            path.join(entrypointCwd, ".env"),
            `MIRA_DASHBOARD_DB_PATH=${configuredDbPath}\n`,
            "utf8"
        );
        const { child } = await startEntrypointChild(
            serverStartEntrypoint,
            {
                ...childEnv,
                NODE_V8_COVERAGE: path.join(os.tmpdir(), "mira-server-dotenv-coverage"),
                OPENCLAW_TOKEN: "test-token",
                OPENCLAW_HOME: openclawHome,
                MIRA_DASHBOARD_OPENCLAW_HOME: openclawHome,
            },
            entrypointCwd
        );
        try {
            await assertChildStillRunning(child, 0);
            await stat(configuredDbPath);
        } finally {
            await stopChild(child);
            await rm(entrypointCwd, { recursive: true, force: true });
        }
    });
});
