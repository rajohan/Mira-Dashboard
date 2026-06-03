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

function cleanupBootstrapTestUsers(): void {
    const users = db
        .prepare("SELECT id FROM users WHERE username LIKE 'bootstrap-%'")
        .all() as Array<{ id: number }>;
    for (const user of users) {
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
        db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    }
}

function cleanupBootstrapRows(username: string): void {
    cleanupUser(username);
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
        cleanupBootstrapTestUsers();
        cleanupBootstrapRows(username);
        server = await startServer();
    });

    after(async () => {
        gatewayTesting.resetGatewayStateForTest();
        await server.close();
        cleanupBootstrapRows(username);
        cleanupBootstrapTestUsers();
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

    it("does not use the legacy createUser dependency for first-user bootstrap", async () => {
        cleanupBootstrapRows(username);
        const fallbackUsername = "bootstrap-fallback-user";
        cleanupBootstrapRows(fallbackUsername);
        let createdWith: { username: string; password: string } | null = null;
        const fallbackDependencies = {
            createUser: (newUsername, newPassword) => {
                createdWith = { username: newUsername, password: newPassword };
                return { id: 42, username: newUsername };
            },
        } as Parameters<typeof authRoutes>[1] & { createUser: typeof createUser };
        const fallbackServer = await startServer(fallbackDependencies);
        try {
            const registered = await requestJson<{
                authenticated: boolean;
                user: { username: string };
            }>(fallbackServer, "/api/auth/register-first-user", {
                method: "POST",
                body: {
                    username: fallbackUsername,
                    password,
                    gatewayToken,
                },
            });

            assert.equal(registered.status, 201);
            assert.equal(createdWith, null);
            assert.equal(registered.body.authenticated, true);
            assert.equal(registered.body.user.username, fallbackUsername);
        } finally {
            await fallbackServer.close();
            cleanupBootstrapRows(username);
            cleanupBootstrapRows(fallbackUsername);
        }
    });

    it("maps first-user creation failures", async () => {
        cleanupBootstrapRows(username);
        let duplicateServer: TestServer | undefined;
        let failingServer: TestServer | undefined;
        try {
            duplicateServer = await startServer({
                createFirstUser: () => {
                    throw new Error("SQLITE_CONSTRAINT_UNIQUE");
                },
            });
            failingServer = await startServer({
                createFirstUser: () => {
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

            cleanupBootstrapRows(username);
            createUser("bootstrap-existing", password);
            const dependencyAfterBootstrap = await requestJson<{ error: string }>(
                duplicateServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: { username: "bootstrap-late", password, gatewayToken },
                }
            );
            assert.equal(dependencyAfterBootstrap.status, 409);
            assert.equal(dependencyAfterBootstrap.body.error, "Username already exists");
        } finally {
            await duplicateServer?.close();
            await failingServer?.close();
            cleanupBootstrapRows(username);
            cleanupUser("bootstrap-existing");
        }
    });

    it("rolls back first-user bootstrap when post-create side effects fail", async () => {
        cleanupBootstrapRows(username);
        let rolledBack = false;
        let shutdown = false;
        let restoredGatewayToken: string | null = null;
        let previousGatewayToken: string | null = null;
        db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run("preexisting-token", new Date().toISOString());
        let sideEffectServer: TestServer | undefined;
        let retryServer: TestServer | undefined;
        try {
            sideEffectServer = await startServer({
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
                initGateway: (token) => {
                    restoredGatewayToken = token;
                },
            });
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
            assert.equal(restoredGatewayToken, "preexisting-token");
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
            await sideEffectServer?.close();
            await retryServer?.close();
            cleanupUser("bootstrap-side-effect");
            cleanupUser("bootstrap-dupe");
            cleanupBootstrapRows(username);
            db.prepare(
                "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
            ).run("preexisting-token");
        }

        const originalExec = db.exec.bind(db);
        const execMock = mock.method(db, "exec", (sql: string) => {
            if (sql === "ROLLBACK") {
                originalExec(sql);
                throw new Error("rollback failed");
            }
            return originalExec(sql);
        });
        const errorMock = mock.method(console, "error", () => {});
        try {
            assert.throws(
                () =>
                    authTesting.rollbackFirstUserBootstrap(
                        0,
                        gatewayToken,
                        "previous-token",
                        () => {
                            throw new Error("persist failed");
                        }
                    ),
                (error) =>
                    error instanceof AggregateError &&
                    error.errors.some(
                        (entry) =>
                            entry instanceof Error &&
                            /persist failed/u.test(entry.message)
                    ) &&
                    error.errors.some(
                        (entry) =>
                            entry instanceof Error &&
                            /rollback failed/u.test(entry.message)
                    )
            );
            assert.equal(errorMock.mock.callCount(), 1);
        } finally {
            execMock.mock.restore();
            errorMock.mock.restore();
        }

        assert.throws(
            () =>
                authTesting.rollbackFirstUserBootstrap(
                    0,
                    gatewayToken,
                    "previous-token",
                    () => {
                        throw new Error("persist failed");
                    }
                ),
            /persist failed/u
        );
    });

    it("rolls back first-user bootstrap when token persistence fails", async () => {
        for (const scenario of ["lookup", "persist"] as const) {
            const failingUsername = `bootstrap-${scenario}-failure`;
            cleanupBootstrapRows(username);
            let rolledBack = false;
            let shutdown = false;
            let failureServer: TestServer | undefined;
            try {
                failureServer = await startServer({
                    getPersistedGatewayToken: () => {
                        if (scenario === "lookup") {
                            throw new Error("lookup unavailable");
                        }
                        return "previous-token";
                    },
                    persistGatewayToken: () => {
                        if (scenario === "persist") {
                            throw new Error("persist unavailable");
                        }
                    },
                    rollbackBootstrap: (userId, token, previousToken) => {
                        rolledBack = true;
                        authTesting.rollbackFirstUserBootstrap(
                            userId,
                            token,
                            previousToken
                        );
                    },
                    shutdownGateway: () => {
                        shutdown = true;
                    },
                });
                const registered = await requestJson<{ error: string }>(
                    failureServer,
                    "/api/auth/register-first-user",
                    {
                        method: "POST",
                        body: { username: failingUsername, password, gatewayToken },
                    }
                );

                assert.equal(registered.status, 500);
                assert.equal(
                    registered.body.error,
                    "Failed to complete first-user setup"
                );
                assert.equal(rolledBack, false);
                assert.equal(shutdown, false);
                assert.equal(
                    db
                        .prepare("SELECT id FROM users WHERE username = ?")
                        .get(failingUsername),
                    undefined
                );
            } finally {
                await failureServer?.close();
                cleanupUser(failingUsername);
                cleanupBootstrapRows(username);
                db.prepare(
                    "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
                ).run("previous-token");
            }
        }
    });

    it("reports first-user rollback errors while restoring the gateway", async () => {
        cleanupBootstrapRows(username);
        let rollbackCalled = false;
        let shutdown = false;
        const throwingRollbackServer = await startServer({
            createSession: () => {
                throw new Error("session unavailable");
            },
            rollbackBootstrap: () => {
                rollbackCalled = true;
                throw new Error("rollback unavailable");
            },
            shutdownGateway: () => {
                shutdown = true;
            },
        });
        try {
            const registered = await requestJson<{ error: string }>(
                throwingRollbackServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: { username: "bootstrap-side-effect", password, gatewayToken },
                }
            );

            assert.equal(registered.status, 500);
            assert.equal(
                registered.body.error,
                "Failed to roll back first-user bootstrap"
            );
            assert.equal(rollbackCalled, true);
            assert.equal(shutdown, true);
        } finally {
            await throwingRollbackServer.close();
            cleanupUser("bootstrap-side-effect");
            cleanupBootstrapRows(username);
        }
    });

    it("reports primitive first-user bootstrap rollback errors", async () => {
        cleanupBootstrapRows(username);
        const throwingRollbackServer = await startServer({
            createSession: () => {
                throw new Error("session unavailable");
            },
            rollbackBootstrap: () => {
                throw "primitive rollback unavailable";
            },
        });
        try {
            const registered = await requestJson<{ error: string }>(
                throwingRollbackServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: {
                        username: "bootstrap-primitive-rollback",
                        password,
                        gatewayToken,
                    },
                }
            );

            assert.equal(registered.status, 500);
            assert.equal(
                registered.body.error,
                "Failed to roll back first-user bootstrap"
            );
        } finally {
            await throwingRollbackServer.close();
            cleanupUser("bootstrap-primitive-rollback");
            cleanupBootstrapRows(username);
        }
    });

    it("keeps first-user cleanup best-effort when pre-switch cleanup throws", async () => {
        cleanupBootstrapRows(username);
        const consoleError = mock.method(console, "error", () => {});
        const cleanupFailureServer = await startServer({
            createSession: () => {
                throw new Error("session unavailable");
            },
            rollbackCreatedFirstUser: () => {
                throw new Error("cleanup unavailable");
            },
        });
        try {
            const registered = await requestJson<{ error: string }>(
                cleanupFailureServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: {
                        username: "bootstrap-cleanup-failure",
                        password,
                        gatewayToken,
                    },
                }
            );

            assert.equal(registered.status, 500);
            assert.equal(registered.body.error, "Failed to complete first-user setup");
            assert.equal(consoleError.mock.callCount(), 1);
        } finally {
            consoleError.mock.restore();
            await cleanupFailureServer.close();
            cleanupUser("bootstrap-cleanup-failure");
        }
    });

    it("keeps first-user cleanup best-effort when database cleanup throws", async () => {
        cleanupBootstrapRows(username);
        const originalExec = db.exec.bind(db);
        const execMock = mock.method(db, "exec", (sql: string) => {
            if (sql === "BEGIN IMMEDIATE") {
                return db;
            }
            if (sql === "COMMIT") {
                throw new Error("cleanup commit unavailable");
            }
            if (sql === "ROLLBACK") {
                return db;
            }
            return originalExec(sql);
        });
        const consoleError = mock.method(console, "error", () => {});
        const cleanupFailureServer = await startServer({
            createFirstUser: (newUsername, newPassword) =>
                createUser(newUsername, newPassword),
            persistGatewayToken: () => {
                throw new Error("token persistence unavailable");
            },
        });
        try {
            const registered = await requestJson<{ error: string }>(
                cleanupFailureServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: {
                        username: "bootstrap-db-cleanup-failure",
                        password,
                        gatewayToken,
                    },
                }
            );

            assert.equal(registered.status, 500);
            assert.equal(
                registered.body.error,
                "Failed to roll back first-user bootstrap"
            );
            assert.equal(consoleError.mock.callCount(), 2);
        } finally {
            await cleanupFailureServer.close();
            consoleError.mock.restore();
            execMock.mock.restore();
            cleanupUser("bootstrap-db-cleanup-failure");
            cleanupBootstrapRows(username);
        }
    });

    it("keeps bootstrap rollback best-effort when shutdown throws", async () => {
        cleanupBootstrapRows(username);
        db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run("shutdown-throws-token", new Date().toISOString());
        let restoreAttempted = false;
        let throwingShutdownServer: TestServer | null = null;
        try {
            throwingShutdownServer = await startServer({
                createSession: () => {
                    throw new Error("session unavailable");
                },
                shutdownGateway: () => {
                    throw new Error("shutdown unavailable");
                },
                initGateway: (token) => {
                    restoreAttempted = token === "shutdown-throws-token";
                },
            });
            const registered = await requestJson<{ error: string }>(
                throwingShutdownServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: { username: "bootstrap-side-effect", password, gatewayToken },
                }
            );

            assert.equal(registered.status, 500);
            assert.equal(registered.body.error, "Failed to complete first-user setup");
            assert.equal(restoreAttempted, true);
        } finally {
            await throwingShutdownServer?.close();
            cleanupUser("bootstrap-side-effect");
            cleanupBootstrapRows(username);
            db.prepare(
                "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
            ).run("shutdown-throws-token");
        }
    });

    it("keeps bootstrap rollback best-effort when restoring the previous gateway fails", async () => {
        cleanupBootstrapRows(username);
        db.prepare(
            "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run("restore-fails-token", new Date().toISOString());
        let restoreAttempted = false;
        let restoreServer: TestServer | null = null;
        try {
            restoreServer = await startServer({
                createSession: () => {
                    throw new Error("session unavailable");
                },
                initGateway: (token) => {
                    if (token === "restore-fails-token") {
                        restoreAttempted = true;
                        throw new Error("restore unavailable");
                    }
                },
            });
            const registered = await requestJson<{ error: string }>(
                restoreServer,
                "/api/auth/register-first-user",
                {
                    method: "POST",
                    body: { username: "bootstrap-restore", password, gatewayToken },
                }
            );

            assert.equal(registered.status, 500);
            assert.equal(registered.body.error, "Failed to complete first-user setup");
            assert.equal(restoreAttempted, true);
        } finally {
            await restoreServer?.close();
            cleanupUser("bootstrap-restore");
            cleanupBootstrapRows(username);
            db.prepare(
                "DELETE FROM app_config WHERE key = 'gateway_token' AND value = ?"
            ).run("restore-fails-token");
        }
    });

    it("surfaces first-user cleanup rollback transaction failures", () => {
        const originalExec = db.exec.bind(db);
        const execMock = mock.method(db, "exec", (sql: string) => {
            if (sql === "BEGIN IMMEDIATE") {
                return db;
            }
            if (sql === "COMMIT") {
                throw new Error("cleanup commit unavailable");
            }
            if (sql === "ROLLBACK") {
                throw new Error("cleanup rollback unavailable");
            }
            return originalExec(sql);
        });
        const consoleError = mock.method(console, "error", () => {});
        try {
            assert.throws(
                () => authTesting.rollbackCreatedFirstUser(-1),
                (error: unknown) =>
                    error instanceof AggregateError &&
                    error.message === "First-user cleanup transaction and rollback failed"
            );
            assert.equal(consoleError.mock.callCount(), 1);
        } finally {
            consoleError.mock.restore();
            execMock.mock.restore();
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
