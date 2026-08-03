import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";

import { database } from "../../src/database/connection.ts";
import {
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
} from "../../src/lib/openclawGatewayClient/client.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
const cleanupCallbacks: Array<() => Promise<void> | void> = [];
function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}
function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() =>
        rmSync(root, {
            force: true,
            recursive: true,
        })
    );
    return root;
}
function isolateOpenClawEnvironment(prefix: string): void {
    rememberEnvironment("OPENCLAW_HOME");
    rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
    const root = createTemporaryRoot(prefix);
    process.env.OPENCLAW_HOME = path.join(root, "openclaw-home");
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(root, "dashboard-home");
}
function jsonRequest(route: string, body: unknown): Request {
    return new Request(`https://test.local${route}`, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
}
function fakeServer(address = "127.0.0.1"): Server<unknown> {
    return {
        requestIP: () => ({
            address,
            family: "IPv4",
            port: 12_345,
        }),
    } as unknown as Server<unknown>;
}
class NoopGatewayClient implements OpenClawGatewayClientInstance {
    readonly options: OpenClawGatewayClientOptions;
    constructor(options: OpenClawGatewayClientOptions) {
        this.options = options;
    }
    request(method: string, parameters?: unknown): Promise<unknown> {
        return Promise.try(() => {
            return {
                method,
                parameters,
            };
        });
    }
    start(): void {
        this.options.onHelloOk?.({
            type: "hello-ok",
        });
    }
    stop(): void {}
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
}
afterEach(async () => {
    while (cleanupCallbacks.length > 0) await cleanupCallbacks.pop()?.();
    database
        .prepare(
            "DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database
        .prepare(
            "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database.prepare("DELETE FROM tasks WHERE title LIKE 'Coverage %'").run();
    database
        .prepare(
            "DELETE FROM openclaw_cron_job_metadata WHERE job_id LIKE 'coverage-%' OR job_id = 'item-cron'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM notifications WHERE dedupe_key LIKE 'quota:%' OR dedupe_key LIKE 'openclaw:%'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM quota_alert_state WHERE provider IN ('openrouter', 'elevenlabs', 'synthetic', 'openai')"
        )
        .run();
    database.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
    database
        .prepare(
            "DELETE FROM scheduled_job_runs WHERE job_id LIKE 'cache.%' OR job_id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM scheduled_jobs WHERE id LIKE 'cache.%' OR id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM cache_entries WHERE key IN ('quotas.summary', 'system.host', 'system.openclaw', 'git.workspace', 'backup.kopia.status', 'backup.walg.status', 'log_rotation.state', 'weather.spydeberg')"
        )
        .run();
    database.prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'").run();
    database
        .prepare(
            "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'coverage-%')"
        )
        .run();
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
});
describe("backend authentication routes", () => {
    it("auth route validation, login, session, and logout branches", async () => {
        isolateOpenClawEnvironment("mira-auth-route-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        cleanupCallbacks.push(
            gatewayModule.setGatewayClientConstructorForTests(NoopGatewayClient),
            () => gatewayModule.default.shutdown()
        );
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { createUser } = await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        const bootstrap = authRoutes["/api/auth/bootstrap"].GET();
        expect(await responseJson(bootstrap)).toHaveProperty("isBootstrapRequired");
        const invalidFirstUser = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "",
                password: "short",
                username: "x",
            }),
            server
        );
        expect(invalidFirstUser.status).toBe(400);
        expect(invalidFirstUser.json()).resolves.toEqual(
            apiErrorExpectation(
                "Username must be 3-32 chars: letters, numbers, dot, dash, underscore"
            )
        );
        const invalidFirstUserPassword = await authRoutes[
            "/api/auth/register-first-user"
        ].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "token",
                password: "short",
                username,
            }),
            server
        );
        expect(invalidFirstUserPassword.status).toBe(400);
        expect(invalidFirstUserPassword.json()).resolves.toEqual(
            apiErrorExpectation("Password must be 8-256 characters")
        );
        const missingGatewayToken = await authRoutes[
            "/api/auth/register-first-user"
        ].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: " ",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(missingGatewayToken.status).toBe(400);
        expect(missingGatewayToken.json()).resolves.toEqual(
            apiErrorExpectation("Gateway token is required for first-user setup")
        );
        const bootstrapLogin = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "correct-password",
                username,
            }),
            server
        );
        expect(bootstrapLogin.status).toBe(409);
        const user = await createUser(username, "correct-password");
        const invalidLogin = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "wrong-password",
                username,
            }),
            server
        );
        expect(invalidLogin.status).toBe(401);
        const { recordAuthenticationFailure, clearAuthenticationFailures } =
            await import("../../src/services/authenticationThrottle.ts");
        recordAuthenticationFailure("login-password", username);
        recordAuthenticationFailure("login-password", username);
        const throttledLogin = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "correct-password",
                username,
            }),
            server
        );
        expect(throttledLogin.status).toBe(429);
        expect(throttledLogin.headers.get("retry-after")).toBeTruthy();
        clearAuthenticationFailures("login-password", username);
        const invalidLoginBody = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", ["not", "an", "object"]),
            server
        );
        expect(invalidLoginBody.status).toBe(400);
        expect(invalidLoginBody.json()).resolves.toEqual(
            apiErrorExpectation("body: must be an object", "invalid_request")
        );
        const invalidLoginFields = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "short",
                username: "x",
            }),
            server
        );
        expect(invalidLoginFields.status).toBe(400);
        expect(invalidLoginFields.json()).resolves.toEqual(
            apiErrorExpectation("Username and password are required", "bad_request")
        );
        const login = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "correct-password",
                username,
            }),
            server
        );
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("mira_dashboard_session=");
        const encodedSessionToken = cookie.match(/mira_dashboard_session=([^;]+)/u)?.[1];
        if (!encodedSessionToken) {
            throw new Error("Expected a Dashboard session cookie");
        }
        const sessionTokenParts = decodeURIComponent(encodedSessionToken).split(".", 3);
        const [sessionSelector, sessionValidator] = sessionTokenParts;
        if (!sessionSelector || !sessionValidator || sessionTokenParts.length !== 2) {
            throw new Error("Expected a selector/validator session token");
        }
        expect(sessionSelector).toMatch(/^[a-f0-9]{32}$/u);
        expect(sessionValidator).toMatch(/^[a-f0-9]{64}$/u);
        expect(login.json()).resolves.toMatchObject({
            authenticated: true,
            user: {
                id: user.id,
                username,
            },
        });
        const session = authRoutes["/api/auth/session"].GET(
            new Request("https://test.local/api/auth/session", {
                headers: {
                    cookie,
                },
            }),
            server
        );
        const sessionBody = (await session.json()) as {
            authenticated: boolean;
            isBootstrapRequired: boolean;
            session: {
                sessionId: string;
            };
        };
        expect(sessionBody.session.sessionId).toBe(sessionSelector);
        expect(JSON.stringify(sessionBody)).not.toContain(sessionValidator);
        expect(sessionBody).toMatchObject({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                sessionId: expect.stringMatching(/^[a-f0-9]{32}$/u),
            },
        });
        const anonymousSession = authRoutes["/api/auth/session"].GET(
            new Request("https://test.local/api/auth/session", {
                headers: {
                    "x-real-ip": "10.0.0.25",
                },
            }),
            server
        );
        expect(anonymousSession.json()).resolves.toMatchObject({
            authenticated: false,
            isBootstrapRequired: false,
        });
        const logout = authRoutes["/api/auth/logout"].POST(
            new Request("https://test.local/api/auth/logout", {
                headers: {
                    cookie,
                },
                method: "POST",
            }),
            server
        );
        expect(await responseJson(logout)).toEqual({
            isOk: true,
        });
        expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
        const anonymousLogout = authRoutes["/api/auth/logout"].POST(
            new Request("https://test.local/api/auth/logout", {
                method: "POST",
            }),
            server
        );
        expect(await responseJson(anonymousLogout)).toEqual({
            isOk: true,
        });
    });
    it("registers the first user and initializes Gateway using isolated state", async () => {
        isolateOpenClawEnvironment("mira-first-user-route-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        cleanupCallbacks.push(
            gatewayModule.setGatewayClientConstructorForTests(NoopGatewayClient),
            () => gatewayModule.default.shutdown()
        );
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "test-gateway-token",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(response.status).toBe(201);
        expect(response.headers.get("set-cookie")).toContain("mira_dashboard_session=");
        expect(response.json()).resolves.toMatchObject({
            authenticated: true,
            user: {
                username,
            },
        });
        const bootstrap = authRoutes["/api/auth/bootstrap"].GET();
        expect(bootstrap.json()).resolves.toEqual({
            hasGatewayToken: true,
            isBootstrapRequired: false,
        });
        const secondResponse = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "test-gateway-token",
                password: "correct-password",
                username: `coverage-${Bun.randomUUIDv7().slice(-8)}`,
            }),
            server
        );
        expect(secondResponse.status).toBe(409);
        expect(secondResponse.json()).resolves.toEqual(
            apiErrorExpectation("Bootstrap registration is no longer available")
        );
    });
    it("keeps first-user bootstrap closed until Gateway validation finishes", async () => {
        isolateOpenClawEnvironment("mira-first-user-deferred-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        const gatewayValidation = Promise.withResolvers<void>();
        let isGatewayValidationStarted = false;
        const validationTokens: string[] = [];
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async (token: string) => {
            isGatewayValidationStarted = true;
            validationTokens.push(token);
            return gatewayValidation.promise;
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        const responsePromise = authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "test-gateway-token-a",
                password: "correct-password",
                username,
            }),
            server
        );
        for (let attempt = 0; !isGatewayValidationStarted && attempt < 50; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(isGatewayValidationStarted).toBe(true);
        expect(findUserByUsername(username)).toBeUndefined();
        const loginDuringHandshake = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "correct-password",
                username,
            }),
            server
        );
        expect(loginDuringHandshake.status).toBe(409);
        const overlappingBootstrap = await authRoutes[
            "/api/auth/register-first-user"
        ].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "test-gateway-token-b",
                password: "correct-password",
                username: `coverage-${Bun.randomUUIDv7().slice(-8)}`,
            }),
            server
        );
        expect(overlappingBootstrap.status).toBe(409);
        expect(overlappingBootstrap.json()).resolves.toEqual(
            apiErrorExpectation("First-user setup is already in progress")
        );
        expect(validationTokens).toEqual(["test-gateway-token-a"]);
        expect(getPersistedGatewayToken()).toBe("test-gateway-token");
        gatewayValidation.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(201);
        expect(findUserByUsername(username)).toMatchObject({
            username,
        });
    });
    it("rejects closed first-user bootstrap before switching Gateway tokens", async () => {
        isolateOpenClawEnvironment("mira-first-user-closed-switch-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        const validationTokens: string[] = [];
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = (token: string) => {
            return Promise.try(() => {
                validationTokens.push(token);
            });
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { createUser, getPersistedGatewayToken, persistGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        await createUser(`coverage-${Bun.randomUUIDv7().slice(-8)}`, "correct-password");
        persistGatewayToken("previous-token");
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "hostile-token",
                password: "correct-password",
                username: `coverage-${Bun.randomUUIDv7().slice(-8)}`,
            }),
            server
        );
        expect(response.status).toBe(409);
        expect(response.json()).resolves.toEqual(
            apiErrorExpectation("Bootstrap registration is no longer available")
        );
        expect(validationTokens).toEqual([]);
        expect(getPersistedGatewayToken()).toBe("previous-token");
    });
    it("restores Gateway state when first-user bootstrap closes during token validation", async () => {
        isolateOpenClawEnvironment("mira-first-user-race-close-coverage-");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInit = gateway.init;
        const originalInitAndWait = gateway.initAndWait;
        const gatewayValidation = Promise.withResolvers<void>();
        let isGatewayValidationStarted = false;
        const initTokens: string[] = [];
        cleanupCallbacks.push(() => {
            gateway.init = originalInit;
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {
            isGatewayValidationStarted = true;
            return gatewayValidation.promise;
        };
        gateway.init = (token: string) => {
            initTokens.push(token);
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { createUser, getPersistedGatewayToken, persistGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("previous-token");
        const responsePromise = authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );
        for (let attempt = 0; !isGatewayValidationStarted && attempt < 50; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(isGatewayValidationStarted).toBe(true);
        await createUser(`coverage-${Bun.randomUUIDv7().slice(-8)}`, "correct-password");
        gatewayValidation.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(409);
        expect(response.json()).resolves.toEqual(
            apiErrorExpectation("Bootstrap registration is no longer available")
        );
        expect(getPersistedGatewayToken()).toBe("previous-token");
        expect(initTokens).toEqual(["previous-token"]);
    });
    it("shuts down rejected first-user bootstrap Gateway when no previous token exists", async () => {
        isolateOpenClawEnvironment("mira-first-user-race-shutdown-coverage-");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalShutdown = gateway.shutdown;
        const originalInitAndWait = gateway.initAndWait;
        const gatewayValidation = Promise.withResolvers<void>();
        let isGatewayValidationStarted = false;
        let shutdownCount = 0;
        cleanupCallbacks.push(() => {
            gateway.shutdown = originalShutdown;
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {
            isGatewayValidationStarted = true;
            return gatewayValidation.promise;
        };
        gateway.shutdown = () => {
            shutdownCount += 1;
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { createUser, getPersistedGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
        const responsePromise = authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username: `coverage-${Bun.randomUUIDv7().slice(-8)}`,
            }),
            server
        );
        for (let attempt = 0; !isGatewayValidationStarted && attempt < 50; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(isGatewayValidationStarted).toBe(true);
        await createUser(`coverage-${Bun.randomUUIDv7().slice(-8)}`, "correct-password");
        gatewayValidation.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(409);
        expect(getPersistedGatewayToken()).toBeUndefined();
        expect(shutdownCount).toBe(1);
    });
    it("rolls back first-user bootstrap when Gateway initialization fails", async () => {
        isolateOpenClawEnvironment("mira-first-user-rollback-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = () => {
            return Promise.try(() => {
                throw new Error("gateway unavailable");
            });
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("previous-token");
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(response.status).toBe(500);
        expect(response.json()).resolves.toEqual(
            apiErrorExpectation("Failed to complete first-user setup")
        );
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("previous-token");
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)"
                )
                .get(username)
        ).toEqual({
            count: 0,
        });
    });
    it("rolls back first-user bootstrap when session creation fails", async () => {
        isolateOpenClawEnvironment("mira-first-user-session-rollback-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {};
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("previous-token");
        database.run(`CREATE TEMP TRIGGER fail_auth_session_insert
             BEFORE INSERT ON auth_sessions
             BEGIN
                 SELECT RAISE(ABORT, 'session blocked');
             END`);
        cleanupCallbacks.push(() => {
            database.run("DROP TRIGGER IF EXISTS fail_auth_session_insert");
        });
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(response.status).toBe(500);
        expect(response.json()).resolves.toEqual(
            apiErrorExpectation("Failed to complete first-user setup")
        );
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("previous-token");
    });
    it("removes a newly persisted Gateway token when first-user bootstrap fails without a previous token", async () => {
        isolateOpenClawEnvironment("mira-first-user-token-cleanup-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = () => {
            return Promise.try(() => {
                throw new Error("gateway unavailable");
            });
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(response.status).toBe(500);
        expect(response.json()).resolves.toEqual(
            apiErrorExpectation("Failed to complete first-user setup")
        );
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBeUndefined();
    });
    it("restores the environment Gateway token after failed first-user bootstrap", async () => {
        isolateOpenClawEnvironment("mira-first-user-env-token-restore-");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        process.env.OPENCLAW_GATEWAY_TOKEN = "environment-token";
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInit = gateway.init;
        const originalInitAndWait = gateway.initAndWait;
        const initCalls: string[] = [];
        cleanupCallbacks.push(() => {
            gateway.init = originalInit;
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = () => {
            return Promise.try(() => {
                throw new Error("gateway unavailable");
            });
        };
        gateway.init = (token: string) => {
            initCalls.push(token);
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("persisted-token");
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(response.status).toBe(500);
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("persisted-token");
        expect(initCalls).toEqual(["environment-token"]);
    });
    it("rejects first-user bootstrap when the Gateway token is invalid", async () => {
        isolateOpenClawEnvironment("mira-first-user-invalid-token-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = () => {
            return Promise.try(() => {
                throw new Error(
                    "unauthorized: gateway token mismatch (provide gateway auth token)"
                );
            });
        };
        const { authRoutes } = await import("../../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../../src/auth/userRepository.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("previous-token");
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "wrong-token",
                password: "correct-password",
                username,
            }),
            server
        );
        expect(response.status).toBe(401);
        expect(response.json()).resolves.toEqual(
            apiErrorExpectation("Invalid OpenClaw gateway token")
        );
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("previous-token");
    });
});
