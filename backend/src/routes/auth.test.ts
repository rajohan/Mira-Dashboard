import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

import { createUser } from "../auth.js";
import { db } from "../db.js";
import { __testing as gatewayTesting } from "../gateway.js";
import authRoutes, { __testing as authTesting } from "./auth.js";

const bootstrapGatewayToken = `bootstrap-token-${Date.now()}`;

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(
    dependencies?: Parameters<typeof authRoutes>[1]
): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    authRoutes(app, dependencies);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            reject(error);
        };
        server.once("error", onError);
        server.listen(0, () => {
            server.off("error", onError);
            resolve();
        });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: T; headers: Headers }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.body === undefined
                ? options.headers
                : { "Content-Type": "application/json", ...options.headers },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
        headers: response.headers,
    };
}

function cleanupUser(username: string): void {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
        | { id: number }
        | undefined;
    if (!user) {
        return;
    }

    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
}

function cleanupBootstrapRows(username: string): void {
    cleanupUser(username);
    cleanupUser("bootstrap-dupe");
    cleanupUser("bootstrap-fail");
    db.prepare("DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?").run(
        bootstrapGatewayToken
    );
    gatewayTesting.resetGatewayStateForTest();
}

describe("auth first-user bootstrap routes", () => {
    const username = `bootstrap-route-${Date.now()}`;
    const password = "correct horse battery staple";
    const gatewayToken = bootstrapGatewayToken;
    let server: TestServer;

    before(async () => {
        cleanupBootstrapRows(username);
        server = await startServer();
    });

    after(async () => {
        gatewayTesting.resetGatewayStateForTest();
        await server.close();
        cleanupBootstrapRows(username);
    });

    it("validates and completes first-user registration", async () => {
        const loginBeforeBootstrap = await requestJson<{ error: string }>(
            server,
            "/api/auth/login",
            {
                method: "POST",
                body: { username, password },
            }
        );
        assert.equal(loginBeforeBootstrap.status, 409);
        assert.equal(
            loginBeforeBootstrap.body.error,
            "Create the first user before logging in"
        );

        const invalidUsername = await requestJson<{ error: string }>(
            server,
            "/api/auth/register-first-user",
            {
                method: "POST",
                body: { username: "no", password, gatewayToken },
            }
        );
        assert.equal(invalidUsername.status, 400);
        assert.match(invalidUsername.body.error, /Username/u);

        const invalidPassword = await requestJson<{ error: string }>(
            server,
            "/api/auth/register-first-user",
            {
                method: "POST",
                body: { username, password: "short", gatewayToken },
            }
        );
        assert.equal(invalidPassword.status, 400);
        assert.match(invalidPassword.body.error, /Password/u);

        const missingGatewayTokenField = await requestJson<{ error: string }>(
            server,
            "/api/auth/register-first-user",
            {
                method: "POST",
                body: { username, password },
            }
        );
        assert.equal(missingGatewayTokenField.status, 400);
        assert.match(missingGatewayTokenField.body.error, /Gateway token/u);

        const missingGatewayToken = await requestJson<{ error: string }>(
            server,
            "/api/auth/register-first-user",
            {
                method: "POST",
                body: { username, password, gatewayToken: "   " },
            }
        );
        assert.equal(missingGatewayToken.status, 400);
        assert.match(missingGatewayToken.body.error, /Gateway token/u);

        const registered = await requestJson<{
            authenticated: boolean;
            user: { username: string };
        }>(server, "/api/auth/register-first-user", {
            method: "POST",
            body: {
                username: ` ${username.toUpperCase()} `,
                password,
                gatewayToken,
            },
        });
        assert.equal(registered.status, 201);
        assert.equal(registered.body.authenticated, true);
        assert.equal(registered.body.user.username, username);
        assert.match(
            registered.headers.get("set-cookie") || "",
            /mira_dashboard_session=/u
        );
    });

    it("maps first-user creation failures", async () => {
        cleanupBootstrapRows(username);
        let duplicateServer: TestServer | undefined;
        let failingServer: TestServer | undefined;
        try {
            duplicateServer = await startServer({
                createUser: () => {
                    throw new Error("SQLITE_CONSTRAINT_UNIQUE");
                },
            });
            failingServer = await startServer({
                createUser: () => {
                    throw "boom";
                },
            });
            assert.ok(duplicateServer);
            assert.ok(failingServer);

            const duplicate = await requestJson<{ error: string }>(
                duplicateServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: { username: "bootstrap-dupe", password, gatewayToken },
                }
            );
            assert.equal(duplicate.status, 409);
            assert.equal(duplicate.body.error, "Username already exists");

            const failed = await requestJson<{ error: string }>(
                failingServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: { username: "bootstrap-fail", password, gatewayToken },
                }
            );
            assert.equal(failed.status, 500);
            assert.equal(failed.body.error, "Failed to create first user");
        } finally {
            await duplicateServer?.close();
            await failingServer?.close();
            cleanupBootstrapRows(username);
        }
    });

    it("rolls back first-user bootstrap when post-create side effects fail", async () => {
        cleanupBootstrapRows(username);
        let rolledBack = false;
        let shutdown = false;
        let previousGatewayToken: string | null = null;
        db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run("preexisting-token", new Date().toISOString());
        const sideEffectServer = await startServer({
            createSession: () => {
                throw new Error("session unavailable");
            },
            rollbackBootstrap: (userId, token, previousToken) => {
                rolledBack = true;
                previousGatewayToken = previousToken ?? null;
                authTesting.rollbackFirstUserBootstrap(userId, token, previousToken);
            },
            shutdownGateway: () => {
                shutdown = true;
            },
        });
        let retryServer: TestServer | undefined;
        try {
            const registered = await requestJson<{
                error: string;
            }>(sideEffectServer, "/api/auth/register-first-user", {
                method: "POST",
                body: { username: "bootstrap-side-effect", password, gatewayToken },
            });

            assert.equal(registered.status, 500);
            assert.equal(registered.body.error, "Failed to complete first-user setup");
            assert.equal(rolledBack, true);
            assert.equal(shutdown, true);
            assert.equal(previousGatewayToken, "preexisting-token");
            assert.equal(
                db
                    .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
                    .get()?.value,
                "preexisting-token"
            );
            assert.equal(
                db
                    .prepare("SELECT id FROM users WHERE username = ?")
                    .get("bootstrap-side-effect"),
                undefined
            );
            authTesting.rollbackFirstUserBootstrap(0, gatewayToken);
            assert.equal(
                db
                    .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
                    .get()?.value,
                "preexisting-token"
            );

            retryServer = await startServer();
            const retried = await requestJson<{
                authenticated: boolean;
                user: { username: string };
            }>(retryServer, "/api/auth/register-first-user", {
                method: "POST",
                body: { username: "bootstrap-dupe", password, gatewayToken },
            });
            assert.equal(retried.status, 201);
            assert.equal(retried.body.authenticated, true);
            assert.equal(retried.body.user.username, "bootstrap-dupe");
        } finally {
            await sideEffectServer.close();
            await retryServer?.close();
            cleanupUser("bootstrap-side-effect");
            cleanupBootstrapRows(username);
            db.prepare(
                "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
            ).run("preexisting-token");
        }
    });
});

describe("auth routes", () => {
    const username = `backend-route-${Date.now()}`;
    const password = "correct horse battery staple";
    let server: TestServer;

    before(async () => {
        cleanupUser(username);
        createUser(username, password);
        server = await startServer();
    });

    after(async () => {
        await server.close();
        cleanupUser(username);
    });

    it("rejects server startup listen errors", async () => {
        const listen = mock.method(
            http.Server.prototype,
            "listen",
            function listen(this: http.Server) {
                this.emit("error", new Error("listen failed"));
                return this;
            }
        );
        try {
            await assert.rejects(startServer(), /listen failed/u);
        } finally {
            listen.mock.restore();
        }
    });

    it("reports bootstrap state without exposing secrets", async () => {
        const response = await requestJson<{
            bootstrapRequired: boolean;
            hasGatewayToken: boolean;
        }>(server, "/api/auth/bootstrap");

        assert.equal(response.status, 200);
        assert.equal(response.body.bootstrapRequired, false);
        assert.equal(typeof response.body.hasGatewayToken, "boolean");
    });

    it("covers auth route parsing and validation helpers", async () => {
        const { __testing } = await import("./auth.js");

        assert.equal(__testing.readSessionId(), null);
        assert.equal(__testing.readSessionId("other=value"), null);
        assert.equal(
            __testing.readSessionId("other=value; mira_dashboard_session=session%201"),
            "session 1"
        );
        assert.equal(__testing.validateUsername("  Raymond_1  "), "raymond_1");
        assert.equal(__testing.validateUsername("no"), null);
        assert.equal(__testing.validateUsername(42), null);
        assert.equal(__testing.validatePassword("12345678"), "12345678");
        assert.equal(__testing.validatePassword("short"), null);
        assert.equal(__testing.validatePassword("x".repeat(257)), null);
        assert.equal(__testing.validatePassword(null), null);
    });

    it("reports loopback sessions", async () => {
        const session = await requestJson<{
            authenticated: boolean;
            bootstrapRequired: boolean;
            user: { id: number; username: string };
        }>(server, "/api/auth/session");

        assert.equal(session.status, 200);
        assert.equal(session.body.authenticated, true);
        assert.equal(session.body.bootstrapRequired, false);
        assert.deepEqual(session.body.user, { id: 0, username: "mira-local" });
    });

    it("rejects first-user registration after bootstrap is complete", async () => {
        const response = await requestJson<{ error: string }>(
            server,
            "/api/auth/register-first-user",
            {
                method: "POST",
                body: {
                    username: "new-user",
                    password,
                    gatewayToken: bootstrapGatewayToken,
                },
            }
        );

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, {
            error: "Bootstrap registration is no longer available",
        });
    });

    it("rejects malformed and invalid login attempts", async () => {
        const malformed = await requestJson<{ error: string }>(
            server,
            "/api/auth/login",
            {
                method: "POST",
                body: { username: "no", password },
            }
        );

        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.error, "Username and password are required");

        const invalid = await requestJson<{ error: string }>(server, "/api/auth/login", {
            method: "POST",
            body: { username, password: "wrong password" },
        });

        assert.equal(invalid.status, 401);
        assert.equal(invalid.body.error, "Invalid username or password");
    });

    it("logs in with normalized usernames and clears sessions on logout", async () => {
        const login = await requestJson<{
            authenticated: boolean;
            user: { id: number; username: string };
        }>(server, "/api/auth/login", {
            method: "POST",
            body: { username: `  ${username.toUpperCase()}  `, password },
        });

        assert.equal(login.status, 200);
        assert.equal(login.body.authenticated, true);
        assert.equal(login.body.user.username, username);

        const cookie = login.headers.get("set-cookie") || "";
        assert.match(cookie, /mira_dashboard_session=/u);
        assert.match(cookie, /HttpOnly/u);
        assert.match(cookie, /SameSite=Strict/u);

        const sessionId = cookie.match(/mira_dashboard_session=([^;]+)/u)?.[1];
        assert.ok(sessionId);
        assert.equal(
            Boolean(
                db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sessionId)
            ),
            true
        );

        const logout = await requestJson<{ ok: true }>(server, "/api/auth/logout", {
            method: "POST",
            headers: { cookie: `mira_dashboard_session=${sessionId}` },
        });

        assert.equal(logout.status, 200);
        assert.deepEqual(logout.body, { ok: true });
        assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/u);
        assert.equal(
            Boolean(
                db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sessionId)
            ),
            false
        );

        const logoutWithoutCookie = await requestJson<{ ok: true }>(
            server,
            "/api/auth/logout",
            { method: "POST" }
        );

        assert.equal(logoutWithoutCookie.status, 200);
        assert.deepEqual(logoutWithoutCookie.body, { ok: true });
    });
});
