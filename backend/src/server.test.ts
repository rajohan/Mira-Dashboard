import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { db, ensureTaskAutomationColumn } from "./db.js";
import gateway from "./gateway.js";

let originalPort: string | undefined;
let originalTrustProxy: string | undefined;
let originalOpenClawHome: string | undefined;
let originalGatewayToken: { value: string } | undefined;
let openclawHome: string | undefined;

let apiAuthMiddleware: (typeof import("./server.js"))["apiAuthMiddleware"];
let handleWebSocketConnection: (typeof import("./server.js"))["handleWebSocketConnection"];
let parseTrustProxy: (typeof import("./server.js"))["parseTrustProxy"];
let resolveBackendCommit: (typeof import("./server.js"))["resolveBackendCommit"];
let resolveListenPort: (typeof import("./server.js"))["resolveListenPort"];
let server: (typeof import("./server.js"))["server"];
let sessionsHandler: (typeof import("./server.js"))["sessionsHandler"];
let handleServerListening: (typeof import("./serverStart.js"))["handleServerListening"];
let isDirectEntrypoint: (typeof import("./serverStart.js"))["isDirectEntrypoint"];
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
        originalGatewayToken = db
            .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
            .get() as { value: string } | undefined;

        try {
            process.env.PORT = "0";
            process.env.TRUST_PROXY = "2";
            openclawHome = await mkdtemp(path.join(os.tmpdir(), "mira-server-openclaw-"));
            await mkdir(path.join(openclawHome, "media"));
            process.env.OPENCLAW_HOME = openclawHome;
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

    it("covers database migration and commit fallback helpers", () => {
        const executedSql: string[] = [];
        ensureTaskAutomationColumn({
            exec: (sql) => executedSql.push(sql),
            prepare: () => ({
                all: () => [{ name: "id" }],
            }),
        });
        assert.equal(executedSql.length, 1);

        executedSql.length = 0;
        let initialLockedPrepareCalls = 0;
        ensureTaskAutomationColumn({
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

        const initialPrepareError = new Error("schema unavailable");
        assert.throws(
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
        ensureTaskAutomationColumn({
            exec: (sql) => executedSql.push(sql),
            prepare: () => ({
                all: () => [{ name: "automation_json" }],
            }),
        });
        assert.deepEqual(executedSql, []);

        let lockedAttempts = 0;
        ensureTaskAutomationColumn({
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
        ensureTaskAutomationColumn({
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
        ensureTaskAutomationColumn({
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
        assert.throws(
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
        assert.throws(
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

        assert.throws(
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

        assert.throws(
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
        assert.throws(
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
        ensureTaskAutomationColumn({
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

        ensureTaskAutomationColumn({
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
        let initializedToken: string | undefined;
        let listenedPort: number | undefined;
        let closeCalled = false;
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
        try {
            process.env.OPENCLAW_TOKEN = "test-token";
            handleServerListening();
            assert.equal(initializedToken, "test-token");
            gateway.init = () => {
                throw new Error("gateway failed");
            };
            server.close = (() => {
                closeCalled = true;
                return server;
            }) as typeof server.close;
            assert.throws(() => handleServerListening(), /gateway failed/u);
            assert.equal(closeCalled, true);
            assert.match(String(errors.at(-1)?.[0]), /Failed to start background/u);
            server.close = originalClose;
            gateway.init = (token: string) => {
                initializedToken = token;
            };
            delete process.env.OPENCLAW_TOKEN;
            initializedToken = undefined;
            handleServerListening();
            assert.equal(initializedToken, undefined);
            assert.match(String(warnings.at(-1)?.[0]), /No gateway token/u);

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
            assert.equal(listenedPort, 0);
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
            if (originalListeningDescriptor) {
                Object.defineProperty(server, "listening", originalListeningDescriptor);
            } else {
                delete (server as { listening?: boolean }).listening;
            }
            console.warn = originalConsoleWarn;
            console.error = originalConsoleError;
        }
    });

    it("runs the startup module as a direct entrypoint", async () => {
        const serverStartEntrypoint = fileURLToPath(
            new URL("serverStart.ts", import.meta.url)
        );
        const child = spawn(
            process.execPath,
            ["--import", "tsx", serverStartEntrypoint],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    OPENCLAW_TOKEN: "test-token",
                    PORT: "0",
                },
                stdio: "ignore",
            }
        );
        try {
            await delay(300);
            assert.equal(child.exitCode, null);
        } finally {
            const exitPromise =
                child.exitCode !== null || child.killed
                    ? Promise.resolve()
                    : new Promise((resolve) => child.once("exit", resolve));
            child.kill("SIGTERM");
            await exitPromise;
        }
    });
});
