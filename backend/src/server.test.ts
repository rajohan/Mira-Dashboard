import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { WebSocket } from "ws";

import { db, ensureTaskAutomationColumn } from "./db.js";
import gateway from "./gateway.js";

const originalPort = process.env.PORT;
const originalTrustProxy = process.env.TRUST_PROXY;
const originalOpenClawHome = process.env.OPENCLAW_HOME;
const originalGatewayToken = db
    .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
    .get() as { value: string } | undefined;

process.env.PORT = "0";
process.env.TRUST_PROXY = "2";
const openclawHome = await mkdtemp(path.join(os.tmpdir(), "mira-server-openclaw-"));
await mkdir(path.join(openclawHome, "media"));
process.env.OPENCLAW_HOME = openclawHome;
db.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();

const {
    apiAuthMiddleware,
    handleServerListening,
    handleWebSocketConnection,
    parseTrustProxy,
    resolveBackendCommit,
    resolveListenPort,
    server,
    sessionsHandler,
} = await import("./server.js");

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

describe("server bootstrap", () => {
    before(async () => {
        if (server.listening) {
            return;
        }

        await new Promise<void>((resolve) => server.once("listening", resolve));
    });

    after(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
        await rm(openclawHome, { recursive: true, force: true });
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
                        throw new Error("SQLITE_BUSY");
                    },
                    prepare: () => ({
                        all: () => [{ name: "id" }],
                    }),
                }),
            /SQLITE_BUSY/u
        );

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

        const originalInit = gateway.init;
        let initializedToken: string | undefined;
        gateway.init = (token: string) => {
            initializedToken = token;
        };
        const originalToken = process.env.OPENCLAW_TOKEN;
        try {
            process.env.OPENCLAW_TOKEN = "test-token";
            handleServerListening();
            assert.equal(initializedToken, "test-token");
        } finally {
            if (originalToken === undefined) {
                delete process.env.OPENCLAW_TOKEN;
            } else {
                process.env.OPENCLAW_TOKEN = originalToken;
            }
            gateway.init = originalInit;
        }
    });
});
