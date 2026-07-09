import {
    chmodSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { Server } from "bun";
import { afterEach, describe, expect, it, jest } from "bun:test";

import { database } from "../src/database.ts";
import type {
    OpenClawGatewayClientInstance,
    OpenClawGatewayClientOptions,
} from "../src/lib/openclawGatewayClient.ts";

const cleanupCallbacks: Array<() => void> = [];

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
    cleanupCallbacks.push(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

function writeExecutable(filePath: string, content: string): void {
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o755);
}

function writeFakeBackupDocker(binaryPath: string): void {
    writeExecutable(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '%s\n' "__MIRA_CONTAINER_PGREP_NO_MATCH__"
  exit 1
fi
if [[ "$*" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"backup_name":"base_0001","finish_time":"$now","start_time":"$now","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg /bin/sh /usr/local/bin/backup-push.sh" ]]; then
  printf '%s\n' "backup ok"
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
`
    );
}

function writeFakeDockerCli(binaryPath: string): void {
    writeExecutable(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  'ps -a --format {{json .}}')
    printf '%s\n' '{"ID":"abc123def456","Names":"demo","Image":"repo/app:1.0","Command":"run","CreatedAt":"2026-06-25 00:00:00 +0000 UTC","Labels":"com.docker.compose.project=stack,com.docker.compose.service=web","Mounts":"data","Networks":"bridge","Ports":"80/tcp","RunningFor":"1 hour","State":"running","Status":"Up 1 hour"}'
    ;;
  'stats --no-stream --format {{json .}}')
    printf '%s\n' '{"ID":"abc123def456","CPUPerc":"1.00%","MemPerc":"2.00%","MemUsage":"10MiB / 1GiB","NetIO":"1kB / 2kB","BlockIO":"3kB / 4kB","PIDs":"5"}'
    ;;
  'inspect abc123def456'|'inspect abc123def456 abc123def456')
    cat <<'JSON'
[{"Id":"abc123def4567890","Created":"2026-06-25T00:00:00Z","Image":"sha256:image123","RestartCount":2,"Config":{"Env":["PUBLIC=value","API_TOKEN=secret","URL=https://user:pass@example.test"],"Labels":{"com.docker.compose.project":"stack","com.docker.compose.service":"web","secret.url":"https://user:pass@example.test"}},"Mounts":[{"Type":"volume","Name":"data","Source":"/var/lib/docker/volumes/data","Destination":"/data","Mode":"rw","RW":true}],"NetworkSettings":{"Networks":{"bridge":{"Gateway":"172.17.0.1","IPAddress":"172.17.0.2","MacAddress":"aa:bb"}}},"State":{"StartedAt":"2026-06-25T00:00:01Z","FinishedAt":"","Health":{"Status":"healthy"}}}]
JSON
    ;;
  'image ls --format {{json .}} --no-trunc')
    printf '%s\n' '{"ID":"sha256:image123","Repository":"repo/app","Tag":"1.0","Size":"12.5MB","CreatedAt":"2026-06-25","Platform":"linux/amd64"}'
    ;;
  'volume ls --format {{json .}}')
    printf '%s\n' '{"Name":"data","Driver":"local","Mountpoint":"/tmp/data","Scope":"local","Labels":"owner=test","Size":"1MB"}'
    ;;
  'logs --tail 50 abc123def456'|'logs --tail 200 abc123def456'|'logs --tail 5000 abc123def456')
    printf '%s\n' 'container log line'
    ;;
  'logs --tail 200 missing')
    echo 'no such container' >&2
    exit 1
    ;;
  exec\ -e\ MIRA_DASHBOARD_EXEC_COMMAND=*\ abc123def4567890\ sh\ -lc*)
    printf '%s\n' '__MIRA_DOCKER_EXEC_PID_fake:123' 'exec output'
    ;;
  'start abc123def4567890'|'stop abc123def4567890'|'restart abc123def4567890'|'start abc123def456'|'stop abc123def456'|'restart abc123def456'|'image rm image123'|'volume rm data'|'image prune -a -f'|'volume prune -f')
    printf '%s\n' "ok: $args"
    ;;
  *)
    echo "unexpected docker args: $args" >&2
    exit 2
    ;;
esac
`
    );
}

function isolateOpenClawEnvironment(prefix: string): void {
    rememberEnvironment("OPENCLAW_HOME");
    rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
    const root = createTemporaryRoot(prefix);
    process.env.OPENCLAW_HOME = path.join(root, "openclaw-home");
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(root, "dashboard-home");
}

function requestWithParameters<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & { params: Record<T, string> } {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
}

function jsonRequest(route: string, body: unknown): Request {
    return new Request(`https://test.local${route}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
}

function fakeServer(address = "127.0.0.1"): Server<unknown> {
    return {
        requestIP: () => ({ address, family: "IPv4", port: 12_345 }),
    } as unknown as Server<unknown>;
}

class NoopGatewayClient implements OpenClawGatewayClientInstance {
    constructor(readonly options: OpenClawGatewayClientOptions) {}

    async request(method: string, parameters?: unknown): Promise<unknown> {
        return { method, parameters };
    }

    start(): void {
        this.options.onHelloOk?.({ type: "hello-ok" });
    }

    stop(): void {}
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
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
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
});

describe("backend route and service behavior", () => {
    it("auth route validation, login, session, and logout branches", async () => {
        isolateOpenClawEnvironment("mira-auth-route-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
        cleanupCallbacks.push(
            gatewayModule.setGatewayClientConstructorForTests(NoopGatewayClient),
            () => gatewayModule.default.shutdown()
        );
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { createUser } = await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;

        const bootstrap = await authRoutes["/api/auth/bootstrap"].GET();
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
        await expect(invalidFirstUser.json()).resolves.toEqual({
            error: "Username must be 3-32 chars: letters, numbers, dot, dash, underscore",
        });

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
        await expect(invalidFirstUserPassword.json()).resolves.toEqual({
            error: "Password must be 8-256 characters",
        });

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
        await expect(missingGatewayToken.json()).resolves.toEqual({
            error: "Gateway token is required for first-user setup",
        });

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

        const invalidLoginBody = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", ["not", "an", "object"]),
            server
        );
        expect(invalidLoginBody.status).toBe(400);
        await expect(invalidLoginBody.json()).resolves.toEqual({
            error: "Invalid request body",
        });

        const invalidLoginFields = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "short",
                username: "x",
            }),
            server
        );
        expect(invalidLoginFields.status).toBe(400);
        await expect(invalidLoginFields.json()).resolves.toEqual({
            error: "Username and password are required",
        });

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
        await expect(login.json()).resolves.toMatchObject({
            authenticated: true,
            user: { id: user.id, username },
        });

        const session = await authRoutes["/api/auth/session"].GET(
            new Request("https://test.local/api/auth/session", {
                headers: { cookie },
            }),
            server
        );
        await expect(session.json()).resolves.toMatchObject({
            authenticated: true,
            isBootstrapRequired: false,
        });

        const anonymousSession = await authRoutes["/api/auth/session"].GET(
            new Request("https://test.local/api/auth/session", {
                headers: { "x-real-ip": "10.0.0.25" },
            }),
            server
        );
        await expect(anonymousSession.json()).resolves.toMatchObject({
            authenticated: false,
            isBootstrapRequired: false,
        });

        const logout = authRoutes["/api/auth/logout"].POST(
            new Request("https://test.local/api/auth/logout", {
                headers: { cookie },
                method: "POST",
            }),
            server
        );
        expect(await responseJson(logout)).toEqual({ isOk: true });
        expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

        const anonymousLogout = authRoutes["/api/auth/logout"].POST(
            new Request("https://test.local/api/auth/logout", { method: "POST" }),
            server
        );
        expect(await responseJson(anonymousLogout)).toEqual({ isOk: true });
    });

    it("registers the first user and initializes Gateway using isolated state", async () => {
        isolateOpenClawEnvironment("mira-first-user-route-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
        cleanupCallbacks.push(
            gatewayModule.setGatewayClientConstructorForTests(NoopGatewayClient),
            () => gatewayModule.default.shutdown()
        );
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
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
        await expect(response.json()).resolves.toMatchObject({
            authenticated: true,
            user: { username },
        });
        const bootstrap = await authRoutes["/api/auth/bootstrap"].GET();
        await expect(bootstrap.json()).resolves.toEqual({
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
        await expect(secondResponse.json()).resolves.toEqual({
            error: "Bootstrap registration is no longer available",
        });
    });

    it("keeps first-user bootstrap closed until Gateway validation finishes", async () => {
        isolateOpenClawEnvironment("mira-first-user-deferred-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
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
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken } =
            await import("../src/auth.ts");
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

        for (let attempt = 0; attempt < 50 && !isGatewayValidationStarted; attempt += 1) {
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
        await expect(overlappingBootstrap.json()).resolves.toEqual({
            error: "First-user setup is already in progress",
        });
        expect(validationTokens).toEqual(["test-gateway-token-a"]);
        expect(getPersistedGatewayToken()).toBe("test-gateway-token-a");

        gatewayValidation.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(201);
        expect(findUserByUsername(username)).toMatchObject({ username });
    });

    it("rejects closed first-user bootstrap before switching Gateway tokens", async () => {
        isolateOpenClawEnvironment("mira-first-user-closed-switch-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        const validationTokens: string[] = [];
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async (token: string) => {
            validationTokens.push(token);
        };
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { createUser, getPersistedGatewayToken, persistGatewayToken } =
            await import("../src/auth.ts");
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
        await expect(response.json()).resolves.toEqual({
            error: "Bootstrap registration is no longer available",
        });
        expect(validationTokens).toEqual([]);
        expect(getPersistedGatewayToken()).toBe("previous-token");
    });

    it("restores Gateway state when first-user bootstrap closes during token validation", async () => {
        isolateOpenClawEnvironment("mira-first-user-race-close-coverage-");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        rememberEnvironment("OPENCLAW_TOKEN");
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        delete process.env.OPENCLAW_TOKEN;
        const gatewayModule = await import("../src/gateway.ts");
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
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { createUser, getPersistedGatewayToken, persistGatewayToken } =
            await import("../src/auth.ts");
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
        for (let attempt = 0; attempt < 50 && !isGatewayValidationStarted; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(isGatewayValidationStarted).toBe(true);
        await createUser(`coverage-${Bun.randomUUIDv7().slice(-8)}`, "correct-password");

        gatewayValidation.resolve();
        const response = await responsePromise;

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            error: "Bootstrap registration is no longer available",
        });
        expect(getPersistedGatewayToken()).toBe("previous-token");
        expect(initTokens).toEqual(["previous-token"]);
    });

    it("shuts down rejected first-user bootstrap Gateway when no previous token exists", async () => {
        isolateOpenClawEnvironment("mira-first-user-race-shutdown-coverage-");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        rememberEnvironment("OPENCLAW_TOKEN");
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        delete process.env.OPENCLAW_TOKEN;
        const gatewayModule = await import("../src/gateway.ts");
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
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { createUser, getPersistedGatewayToken } = await import("../src/auth.ts");
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
        for (let attempt = 0; attempt < 50 && !isGatewayValidationStarted; attempt += 1) {
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
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {
            throw new Error("gateway unavailable");
        };
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;

        persistGatewayToken("previous-token");
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            error: "Failed to complete first-user setup",
        });
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("previous-token");
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)"
                )
                .get(username)
        ).toEqual({ count: 0 });
    });

    it("rolls back first-user bootstrap when session creation fails", async () => {
        isolateOpenClawEnvironment("mira-first-user-session-rollback-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {};
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("previous-token");
        database.run(
            `CREATE TEMP TRIGGER fail_auth_session_insert
             BEFORE INSERT ON auth_sessions
             BEGIN
                 SELECT RAISE(ABORT, 'session blocked');
             END`
        );
        cleanupCallbacks.push(() => {
            database.run("DROP TRIGGER IF EXISTS fail_auth_session_insert");
        });

        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            error: "Failed to complete first-user setup",
        });
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("previous-token");
    });

    it("removes a newly persisted Gateway token when first-user bootstrap fails without a previous token", async () => {
        isolateOpenClawEnvironment("mira-first-user-token-cleanup-");
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {
            throw new Error("gateway unavailable");
        };
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken } =
            await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();

        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "new-token",
                password: "correct-password",
                username,
            }),
            server
        );

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            error: "Failed to complete first-user setup",
        });
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBeUndefined();
    });

    it("restores the environment Gateway token after failed first-user bootstrap", async () => {
        isolateOpenClawEnvironment("mira-first-user-env-token-restore-");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        process.env.OPENCLAW_GATEWAY_TOKEN = "environment-token";
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalInit = gateway.init;
        const originalInitAndWait = gateway.initAndWait;
        const initCalls: string[] = [];
        cleanupCallbacks.push(() => {
            gateway.init = originalInit;
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {
            throw new Error("gateway unavailable");
        };
        gateway.init = (token: string) => {
            initCalls.push(token);
        };
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;
        persistGatewayToken("persisted-token");

        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
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
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalInitAndWait = gateway.initAndWait;
        cleanupCallbacks.push(() => {
            gateway.initAndWait = originalInitAndWait;
            gateway.shutdown();
        });
        gateway.initAndWait = async () => {
            throw new Error(
                "unauthorized: gateway token mismatch (provide gateway auth token)"
            );
        };
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { findUserByUsername, getPersistedGatewayToken, persistGatewayToken } =
            await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;

        persistGatewayToken("previous-token");
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        cleanupCallbacks.push(() => errorSpy.mockRestore());
        const response = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "wrong-token",
                password: "correct-password",
                username,
            }),
            server
        );

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            error: "Invalid OpenClaw gateway token",
        });
        expect(findUserByUsername(username)).toBeUndefined();
        expect(getPersistedGatewayToken()).toBe("previous-token");
    });

    it("task route automation, validation, assignment, movement, updates, and deletion", async () => {
        isolateOpenClawEnvironment("mira-task-route-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const originalSendSessionMessage = gateway.sendSessionMessage;
        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
            gateway.sendSessionMessage = originalSendSessionMessage;
        });
        const taskNotifications: string[] = [];
        gateway.request = async () => ({
            jobs: [
                {
                    enabled: true,
                    id: "cron-unit",
                    name: "Coverage cron",
                    payload: { model: "codex", thinking: "high" },
                    schedule: { everyMs: 3_600_000, kind: "every" },
                    sessionTarget: "agent:main:main",
                    state: { lastDurationMs: 42, lastRunStatus: "success" },
                },
            ],
        });
        gateway.sendSessionMessage = async (_sessionKey, message) => {
            taskNotifications.push(message);
        };

        const { taskRoutes } = await import("../src/routes/taskRoutes.ts");
        const invalidCreate = await taskRoutes["/api/tasks"].POST(
            jsonRequest("/api/tasks", { labels: "bug", title: "Coverage invalid" })
        );
        expect(invalidCreate.status).toBe(400);

        const create = await taskRoutes["/api/tasks"].POST(
            jsonRequest("/api/tasks", {
                automation: {
                    cronJobId: "cron-unit",
                    model: "stored-model",
                    scheduleSummary: "stored schedule",
                },
                body: "Body",
                labels: ["blocked", "priority-high"],
                title: "Coverage route task",
            })
        );
        expect(create.status).toBe(201);
        const created = await responseJson(create);
        const id = Number(created.number);
        expect(created).toMatchObject({
            automation: {
                cronJobId: "cron-unit",
                model: "stored-model",
                scheduleSummary: "stored schedule",
                source: "stored",
            },
            state: "OPEN",
            title: "Coverage route task",
        });

        const enriched = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters(`/api/tasks/${id}`, { id: String(id) })
        );
        await expect(enriched.json()).resolves.toMatchObject({
            automation: {
                enabled: true,
                model: "codex",
                scheduleSummary: "Every 1h",
                source: "cron",
            },
        });

        const getInvalid = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters("/api/tasks/not-a-number", { id: "not-a-number" })
        );
        expect(getInvalid.status).toBe(400);

        const patch = await taskRoutes["/api/tasks/:id"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}`,
                { id: String(id) },
                {
                    body: JSON.stringify({
                        automation: {},
                        labels: ["done", "priority-low"],
                        title: "Coverage route task updated",
                    }),
                    method: "PATCH",
                }
            )
        );
        await expect(patch.json()).resolves.toMatchObject({
            state: "CLOSED",
            title: "Coverage route task updated",
        });

        const invalidAssign = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                { id: String(id) },
                { body: JSON.stringify({ assignee: "nobody" }), method: "POST" }
            )
        );
        expect(invalidAssign.status).toBe(400);

        const assign = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                { id: String(id) },
                { body: JSON.stringify({ assignee: "mira-2026" }), method: "POST" }
            )
        );
        await expect(assign.json()).resolves.toMatchObject({
            assignees: [{ login: "mira-2026", name: "mira-2026" }],
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task assigned: #${id} Coverage route task updated. This task is assigned to Mira and may need attention when the current work is clear.`
        );

        const invalidMove = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${id}/move`,
                { id: String(id) },
                { body: JSON.stringify({ columnLabel: "icebox" }), method: "POST" }
            )
        );
        expect(invalidMove.status).toBe(400);

        const move = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${id}/move`,
                { id: String(id) },
                { body: JSON.stringify({ columnLabel: "in-progress" }), method: "POST" }
            )
        );
        await expect(move.json()).resolves.toMatchObject({ state: "OPEN" });

        const invalidUpdate = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${id}/updates`,
                { id: String(id) },
                {
                    body: JSON.stringify({ author: "mira-2026", messageMd: "" }),
                    method: "POST",
                }
            )
        );
        expect(invalidUpdate.status).toBe(400);

        const update = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${id}/updates`,
                { id: String(id) },
                {
                    body: JSON.stringify({
                        author: "mira-2026",
                        messageMd: "Progress update",
                    }),
                    method: "POST",
                }
            )
        );
        expect(update.status).toBe(201);
        const updateBody = await responseJson(update);
        const updateId = Number(updateBody.id);
        expect(updateBody).toMatchObject({
            author: "mira-2026",
            messageMd: "Progress update",
            taskId: id,
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task progress: #${id} Coverage route task updated. This existing Mira task has new progress and may need attention when the current work is clear.`
        );
        expect(typeof updateBody.createdAt).toBe("string");

        const listedUpdates = await taskRoutes["/api/tasks/:id/updates"].GET(
            requestWithParameters(`/api/tasks/${id}/updates`, { id: String(id) })
        );
        await expect(listedUpdates.json()).resolves.toContainEqual({
            ...updateBody,
            id: updateId,
        });

        const taskAfterProgress = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters(`/api/tasks/${id}`, { id: String(id) })
        );
        await expect(taskAfterProgress.json()).resolves.toMatchObject({
            updatedAt: updateBody.createdAt,
        });

        const patchUpdate = await taskRoutes["/api/tasks/:id/updates/:updateId"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}/updates/${updateId}`,
                { id: String(id), updateId: String(updateId) },
                {
                    body: JSON.stringify({
                        author: "rajohan",
                        messageMd: "Raymond update",
                    }),
                    method: "PATCH",
                }
            )
        );
        await expect(patchUpdate.json()).resolves.toMatchObject({
            author: "mira-2026",
            messageMd: "Raymond update",
        });

        const deleteUpdate = taskRoutes["/api/tasks/:id/updates/:updateId"].DELETE(
            requestWithParameters(`/api/tasks/${id}/updates/${updateId}`, {
                id: String(id),
                updateId: String(updateId),
            })
        );
        expect(await responseJson(deleteUpdate)).toEqual({ isOk: true });

        const deleteTask = taskRoutes["/api/tasks/:id"].DELETE(
            requestWithParameters(`/api/tasks/${id}`, { id: String(id) })
        );
        expect(await responseJson(deleteTask)).toEqual({ isOk: true });
        expect(taskNotifications.at(-1)).toBe(
            `Task deleted: #${id} Coverage route task updated. This Mira-assigned task changed and may need attention when the current work is clear.`
        );
    });

    it("file route listing, hidden path rejection, text writes, binary reads, and directory errors", async () => {
        rememberEnvironment("WORKSPACE_ROOT");
        const workspaceRoot = createTemporaryRoot("mira-file-route-coverage-");
        process.env.WORKSPACE_ROOT = workspaceRoot;
        mkdirSync(path.join(workspaceRoot, "notes"), { recursive: true });
        writeFileSync(path.join(workspaceRoot, "notes", "readme.txt"), "hello");
        writeFileSync(path.join(workspaceRoot, "image.png"), "png");
        writeFileSync(path.join(workspaceRoot, "binary.bin"), "a\0b");

        const { fileRoutes } = await import("../src/routes/fileRoutes.ts");
        const list = await fileRoutes["/api/files"].GET(
            new Request("https://test.local/api/files")
        );
        await expect(list.json()).resolves.toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({ name: "notes", type: "directory" }),
                expect.objectContaining({ name: "image.png", type: "file" }),
            ]),
            root: workspaceRoot,
        });

        const hidden = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/.secret")
        );
        expect(hidden.status).toBe(403);

        const hiddenDirectoryList = await fileRoutes["/api/files"].GET(
            new Request("https://test.local/api/files?path=notes/.secret")
        );
        expect(hiddenDirectoryList.status).toBe(403);
        await expect(hiddenDirectoryList.json()).resolves.toEqual({
            error: "Access denied: path outside workspace",
        });

        const malformedPath = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/%E0%A4%A")
        );
        expect(malformedPath.status).toBe(400);
        await expect(malformedPath.json()).resolves.toEqual({
            error: "Malformed file path",
        });

        const traversal = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/..%2Foutside.txt")
        );
        expect(traversal.status).toBe(403);

        const missingFile = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/missing.txt")
        );
        expect(missingFile.status).toBe(404);

        const directory = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/notes")
        );
        expect(directory.status).toBe(400);

        const binary = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/binary.bin")
        );
        await expect(binary.json()).resolves.toMatchObject({
            content: "[Binary file]",
            isBinary: true,
            path: "binary.bin",
        });

        const image = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/image.png")
        );
        await expect(image.json()).resolves.toMatchObject({
            isBinary: true,
            isImage: true,
            mimeType: "image/png",
            path: "image.png",
        });

        const write = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify({ content: "updated" }),
                method: "PUT",
            })
        );
        expect(await responseJson(write)).toMatchObject({
            isSuccess: true,
            path: "notes/readme.txt",
        });
        expect(
            readFileSync(path.join(workspaceRoot, "notes", "readme.txt"), "utf8")
        ).toBe("updated");
        expect(
            readFileSync(path.join(workspaceRoot, "notes", "readme.txt.bak"), "utf8")
        ).toBe("hello");

        const directoryWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes", {
                body: JSON.stringify({ content: "updated" }),
                method: "PUT",
            })
        );
        expect(directoryWrite.status).toBe(400);

        const hiddenWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/.secret", {
                body: JSON.stringify({ content: "hidden" }),
                method: "PUT",
            })
        );
        expect(hiddenWrite.status).toBe(403);

        const invalidWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify({ content: 42 }),
                method: "PUT",
            })
        );
        expect(invalidWrite.status).toBe(400);

        const arrayWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify(["not", "an", "object"]),
                method: "PUT",
            })
        );
        expect(arrayWrite.status).toBe(400);
        await expect(arrayWrite.json()).resolves.toEqual({
            error: "Request body must be an object",
        });

        const malformedWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: "{",
                method: "PUT",
            })
        );
        expect(malformedWrite.status).toBe(400);

        const fileParentWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt/child.txt", {
                body: JSON.stringify({ content: "new" }),
                method: "PUT",
            })
        );
        expect(fileParentWrite.status).toBe(403);
        await expect(fileParentWrite.json()).resolves.toEqual({
            error: "Access denied: path outside workspace",
        });

        const tooLargeContent = "x".repeat(1024 * 1024 + 1);
        const largeWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/large.txt", {
                body: JSON.stringify({ content: tooLargeContent }),
                method: "PUT",
            })
        );
        expect(largeWrite.status).toBe(413);

        const largeImagePath = path.join(workspaceRoot, "large.png");
        writeFileSync(largeImagePath, Buffer.alloc(1024 * 1024 + 1));
        const largeImage = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/large.png")
        );
        expect(largeImage.status).toBe(413);

        const hardLinkedPath = path.join(workspaceRoot, "notes", "hardlinked.txt");
        writeFileSync(hardLinkedPath, "linked");
        linkSync(
            hardLinkedPath,
            path.join(workspaceRoot, "notes", "hardlinked-copy.txt")
        );
        const hardLinkedRead = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/notes/hardlinked.txt")
        );
        expect(hardLinkedRead.status).toBe(403);
        const hardLinkedWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/hardlinked.txt", {
                body: JSON.stringify({ content: "updated" }),
                method: "PUT",
            })
        );
        expect(hardLinkedWrite.status).toBe(403);
    });

    it("config file route allowlist, reads, writes, and backups", async () => {
        isolateOpenClawEnvironment("mira-config-file-route-");
        const root = process.env.OPENCLAW_HOME!;
        mkdirSync(path.join(root, "hooks", "transforms"), { recursive: true });
        writeFileSync(path.join(root, "openclaw.json"), '{"model":"codex"}\n');
        writeFileSync(
            path.join(root, "hooks", "transforms", "agentmail.ts"),
            "export default {}\n"
        );
        const { configFileRoutes } = await import("../src/routes/configFileRoutes.ts");

        const listed = await configFileRoutes["/api/config-files"].GET();
        const listedJson = await responseJson(listed);
        expect((listedJson.files as unknown[]).length).toBe(2);
        expect(listedJson.root).toBe(root);

        const deniedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/secrets.env")
        );
        expect(deniedRead.status).toBe(403);

        const missingAllowedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/hooks/transforms/missing.ts")
        );
        expect(missingAllowedRead.status).toBe(403);

        const malformedConfigPath = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/%E0%A4%A")
        );
        expect(malformedConfigPath.status).toBe(400);

        const read = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        await expect(read.json()).resolves.toMatchObject({
            content: '{"model":"codex"}\n',
            isBinary: false,
            path: "config:openclaw.json",
            relativePath: "openclaw.json",
            size: 18,
        });

        const invalidWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({ content: 42 }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(invalidWrite.status).toBe(400);

        const malformedWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: "{",
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(malformedWrite.status).toBe(400);

        const arrayWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify([]),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(arrayWrite.status).toBe(400);

        const missingContentWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({}),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(missingContentWrite.status).toBe(400);

        const oversizedConfigContent = "x".repeat(2 * 1024 * 1024 + 1);
        const tooLargeConfigWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({ content: oversizedConfigContent }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(tooLargeConfigWrite.status).toBe(400);

        const written = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({ content: '{"model":"glm51"}\n' }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        await expect(written.json()).resolves.toMatchObject({
            isSuccess: true,
            path: "config:openclaw.json",
            relativePath: "openclaw.json",
            size: 18,
        });
        await expect(Bun.file(path.join(root, "openclaw.json")).text()).resolves.toBe(
            '{"model":"glm51"}\n'
        );
        await expect(Bun.file(path.join(root, "openclaw.json.bak")).text()).resolves.toBe(
            '{"model":"codex"}\n'
        );

        writeFileSync(path.join(root, "openclaw.json"), "a\0b");
        const binaryRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        await expect(binaryRead.json()).resolves.toMatchObject({
            content: "[Binary file]",
            isBinary: true,
            path: "config:openclaw.json",
        });

        const symlinkedConfig = path.join(root, "hooks", "transforms", "agentmail.ts");
        unlinkSync(symlinkedConfig);
        symlinkSync(path.join(root, "openclaw.json"), symlinkedConfig);
        const symlinkedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts"
            )
        );
        expect(symlinkedRead.status).toBe(404);
        const symlinkedWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts",
                {
                    body: JSON.stringify({ content: "export default {}\n" }),
                    headers: { "Content-Type": "application/json" },
                    method: "PUT",
                }
            )
        );
        expect(symlinkedWrite.status).toBe(403);
        unlinkSync(symlinkedConfig);
        writeFileSync(symlinkedConfig, "export default {}\n");

        const linkedConfig = path.join(root, "hooks", "transforms", "agentmail.ts");
        linkSync(linkedConfig, `${linkedConfig}.hardlink`);
        const hardLinkedConfigWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts",
                {
                    body: JSON.stringify({ content: "export default {}\n" }),
                    headers: { "Content-Type": "application/json" },
                    method: "PUT",
                }
            )
        );
        expect(hardLinkedConfigWrite.status).toBe(403);

        writeFileSync(path.join(root, "openclaw.json"), "x".repeat(2 * 1024 * 1024 + 1));
        const oversizedExistingWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({ content: "{}\n" }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(oversizedExistingWrite.status).toBe(413);
    });

    it("defensive route contracts for Docker, pull requests, cache, database, and backup APIs", async () => {
        isolateOpenClawEnvironment("mira-route-contract-coverage-");
        const terminalRoot = createTemporaryRoot("mira-terminal-route-coverage-");
        const terminalDirectory = path.join(terminalRoot, "work dir");
        const terminalFile = path.join(terminalRoot, "work file.txt");
        const terminalExecutable = path.join(terminalRoot, "work-bin");
        mkdirSync(terminalDirectory);
        writeFileSync(terminalFile, "text");
        writeExecutable(terminalExecutable, "#!/usr/bin/env bash\nexit 0\n");
        const [
            { backupRoutes },
            { cacheRoutes },
            { cronRoutes },
            { dockerRoutes },
            gatewayModule,
            { jobRoutes },
            { moltbookRoutes },
            { pullRequestRoutes },
            { terminalRoutes },
        ] = await Promise.all([
            import("../src/routes/backupRoutes.ts"),
            import("../src/routes/cacheRoutes.ts"),
            import("../src/routes/cronRoutes.ts"),
            import("../src/routes/dockerRoutes.ts"),
            import("../src/gateway.ts"),
            import("../src/routes/jobRoutes.ts"),
            import("../src/routes/moltbookRoutes.ts"),
            import("../src/routes/pullRequestRoutes.ts"),
            import("../src/routes/terminalRoutes.ts"),
        ]);

        const gateway = gatewayModule.default;
        const gatewayRequestSpy = jest
            .spyOn(gateway, "request")
            .mockImplementation(async (method) => {
                if (method === "cron.list") {
                    return { items: [{ enabled: true, id: "item-cron" }] };
                }
                throw Object.assign(new Error(`gateway failed for ${method}`), {
                    statusCode: 502,
                });
            });
        cleanupCallbacks.push(() => gatewayRequestSpy.mockRestore());

        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES ('route.string', 'raw-value', 'test', ?, ?, ?, 'fresh', 2, '{bad-json') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at"
            )
            .run(Date.now(), Date.now(), Date.now() + 60_000);
        cleanupCallbacks.push(() => {
            database
                .prepare(
                    "DELETE FROM cache_entries WHERE key = 'route.string' OR key LIKE 'moltbook.%'"
                )
                .run();
        });

        const cacheHeartbeat = await cacheRoutes["/api/cache/heartbeat"].GET();
        const cacheHeartbeatText = await cacheHeartbeat.text();
        const cacheHeartbeatJson = JSON.parse(cacheHeartbeatText) as {
            count: number;
            entries: Record<string, { data?: unknown; key?: string }>;
        };
        expect(cacheHeartbeatJson).toMatchObject({
            count: expect.any(Number),
            entries: expect.arrayContaining([
                expect.objectContaining({
                    consecutiveFailures: 2,
                    data: "raw-value",
                    key: "route.string",
                    meta: {},
                }),
            ]),
        });
        const missingValue = JSON.parse("null") as null;
        const cacheStatus = await cacheRoutes["/api/cache/status"].GET();
        await expect(cacheStatus.json()).resolves.toMatchObject({
            count: expect.any(Number),
            entries: expect.arrayContaining([
                expect.objectContaining({
                    consecutiveFailures: 2,
                    data: missingValue,
                    key: "route.string",
                    meta: {},
                }),
            ]),
        });

        const missingCache = await cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/", { key: "" })
        );
        expect(missingCache.status).toBe(400);

        const stringCache = await cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/route.string", { key: "route.string" })
        );
        await expect(stringCache.json()).resolves.toMatchObject({
            data: "raw-value",
            key: "route.string",
            meta: {},
        });

        const unknownCache = await cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/nope", { key: "nope" })
        );
        expect(unknownCache.status).toBe(404);

        const missingCacheRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            requestWithParameters("/api/cache//refresh", { key: "" })
        );
        await expect(missingCacheRefresh.json()).resolves.toEqual({
            error: "Missing cache key",
        });
        expect(missingCacheRefresh.status).toBe(400);

        const unknownCacheRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            requestWithParameters("/api/cache/nope/refresh", { key: "nope" })
        );
        await expect(unknownCacheRefresh.json()).resolves.toEqual({
            error: "No backend refresh producer configured for cache key: nope",
        });
        expect(unknownCacheRefresh.status).toBe(400);

        const backupStatus = backupRoutes["/api/backups/kopia"].GET();
        await expect(backupStatus.json()).resolves.toEqual({ job: undefined });

        const missingJob = jobRoutes["/api/jobs/:id"].GET(
            requestWithParameters("/api/jobs/missing-route-job", {
                id: "missing-route-job",
            })
        );
        expect(missingJob.status).toBe(404);
        await expect(missingJob.json()).resolves.toEqual({
            error: "Scheduled job not found",
        });

        const malformedJobPatch = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                "/api/jobs/missing-route-job",
                { id: "missing-route-job" },
                { body: "{", method: "PATCH" }
            )
        );
        expect(malformedJobPatch.status).toBe(400);

        const invalidJobPatchBody = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                "/api/jobs/missing-route-job",
                { id: "missing-route-job" },
                { body: JSON.stringify({ patch: [] }), method: "PATCH" }
            )
        );
        expect(invalidJobPatchBody.status).toBe(400);

        const invalidJobPatchField = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                "/api/jobs/missing-route-job",
                { id: "missing-route-job" },
                {
                    body: JSON.stringify({ patch: { enabled: "yes" } }),
                    method: "PATCH",
                }
            )
        );
        expect(invalidJobPatchField.status).toBe(400);
        await expect(invalidJobPatchField.json()).resolves.toEqual({
            error: "invalid patch field: enabled",
        });

        const missingJobRun = await jobRoutes["/api/jobs/:id/run"].POST(
            requestWithParameters("/api/jobs/missing-route-job/run", {
                id: "missing-route-job",
            })
        );
        expect(missingJobRun.status).toBe(404);

        const missingJobRuns = jobRoutes["/api/jobs/:id/runs"].GET(
            requestWithParameters("/api/jobs/missing-route-job/runs", {
                id: "missing-route-job",
            })
        );
        expect(missingJobRuns.status).toBe(404);

        const terminalComplete = await terminalRoutes["/api/terminal/complete"].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "echo work",
            })
        );
        await expect(terminalComplete.json()).resolves.toMatchObject({
            commonPrefix: "echo work",
            completions: [
                {
                    completion: String.raw`echo work\ dir`,
                    display: "work dir/",
                    type: "directory",
                },
                {
                    completion: "echo work-bin",
                    display: "work-bin",
                    type: "executable",
                },
                {
                    completion: String.raw`echo work\ file.txt`,
                    display: "work file.txt",
                    type: "file",
                },
            ],
        });

        const invalidTerminalComplete = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: "relative",
                partial: "work",
            })
        );
        expect(invalidTerminalComplete.status).toBe(400);

        const malformedTerminalComplete = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            new Request("https://test.local/api/terminal/complete", {
                body: "{",
                method: "POST",
            })
        );
        expect(malformedTerminalComplete.status).toBe(400);

        const missingTerminalCompleteBody = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(jsonRequest("/api/terminal/complete", []));
        expect(missingTerminalCompleteBody.status).toBe(400);

        const invalidTerminalPartial = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "bad\0partial",
            })
        );
        expect(invalidTerminalPartial.status).toBe(400);

        const missingDirectoryCompletion = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "missing/",
            })
        );
        await expect(missingDirectoryCompletion.json()).resolves.toEqual({
            commonPrefix: "",
            completions: [],
        });

        const terminalCdFile = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "work file.txt",
            })
        );
        await expect(terminalCdFile.json()).resolves.toMatchObject({
            error: "Not a directory: work file.txt",
            isSuccess: false,
            newCwd: terminalRoot,
        });

        const terminalCdHome = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "~",
            })
        );
        await expect(terminalCdHome.json()).resolves.toMatchObject({
            isSuccess: true,
            newCwd: expect.any(String),
        });

        const terminalCdNormalized = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalDirectory,
                path: "../work dir/.",
            })
        );
        await expect(terminalCdNormalized.json()).resolves.toEqual({
            isSuccess: true,
            newCwd: terminalDirectory,
        });

        const malformedTerminalCd = await terminalRoutes["/api/terminal/cd"].POST(
            new Request("https://test.local/api/terminal/cd", {
                body: "{",
                method: "POST",
            })
        );
        expect(malformedTerminalCd.status).toBe(400);

        const invalidTerminalCd = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: "relative",
                path: "work dir",
            })
        );
        expect(invalidTerminalCd.status).toBe(400);

        const missingTerminalCd = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "missing",
            })
        );
        expect(missingTerminalCd.status).toBe(400);

        const invalidContainer = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/--bad", {
                containerId: "--bad",
            })
        );
        expect(invalidContainer.status).toBe(400);

        const invalidAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/abc/action",
                { containerId: "abc" },
                { body: JSON.stringify({ action: "destroy" }), method: "POST" }
            )
        );
        expect(invalidAction.status).toBe(400);

        const missingExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
            requestWithParameters("/api/docker/exec/missing", { jobId: "missing" })
        );
        expect(missingExec.status).toBe(404);

        const invalidExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", { command: "", containerId: "" })
        );
        expect(invalidExecStart.status).toBe(400);

        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", { target: "networks" })
        );
        expect(invalidPrune.status).toBe(400);

        const malformedPrune = await dockerRoutes["/api/docker/prune"].POST(
            new Request("https://test.local/api/docker/prune", {
                body: "{",
                method: "POST",
            })
        );
        expect(malformedPrune.status).toBe(400);

        const invalidStackActionBody = await dockerRoutes[
            "/api/docker/stack/action"
        ].POST(jsonRequest("/api/docker/stack/action", []));
        expect(invalidStackActionBody.status).toBe(400);

        const invalidStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", { action: "reload" })
        );
        expect(invalidStackAction.status).toBe(400);

        const invalidStackService = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "restart",
                service: "--bad",
            })
        );
        expect(invalidStackService.status).toBe(400);

        const invalidImageDelete = await dockerRoutes[
            "/api/docker/images/:imageId"
        ].DELETE(requestWithParameters("/api/docker/images/--bad", { imageId: "--bad" }));
        expect(invalidImageDelete.status).toBe(400);

        const invalidVolumeDelete = await dockerRoutes[
            "/api/docker/volumes/:volumeName"
        ].DELETE(
            requestWithParameters("/api/docker/volumes/--bad", {
                volumeName: "--bad",
            })
        );
        expect(invalidVolumeDelete.status).toBe(400);

        const invalidUpdater = await dockerRoutes[
            "/api/docker/updater/services/:serviceId/update"
        ].POST(
            requestWithParameters("/api/docker/updater/services/not-number/update", {
                serviceId: "not-number",
            })
        );
        expect(invalidUpdater.status).toBe(400);

        database
            .prepare(
                `INSERT INTO docker_managed_services (
                    app_slug,
                    service_name,
                    compose_path,
                    image_repo,
                    compose_image_ref,
                    current_tag,
                    current_digest,
                    latest_tag,
                    latest_digest,
                    policy,
                    pin_mode,
                    enabled,
                    metadata_json,
                    last_checked_at,
                    last_updated_at,
                    last_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                "coverage-app",
                "api",
                "/tmp/compose.yml",
                "example/api",
                "example/api:1.0",
                "1.0",
                "sha256:old",
                "1.1",
                "sha256:new",
                "notify",
                "tag",
                1,
                '{"source":"test"}',
                "2026-06-25T10:00:00.000Z",
                "2026-06-25T11:00:00.000Z",
                "auto_update_failed"
            );
        const updaterServiceId = Number(
            (
                database
                    .prepare(
                        "SELECT id FROM docker_managed_services WHERE app_slug = 'coverage-app' AND service_name = 'api'"
                    )
                    .get() as { id: number }
            ).id
        );
        database
            .prepare(
                `INSERT INTO docker_update_events (
                    managed_service_id,
                    app_slug,
                    service_name,
                    event_type,
                    from_tag,
                    to_tag,
                    from_digest,
                    to_digest,
                    message,
                    details_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                updaterServiceId,
                "",
                "",
                "update_available",
                "1.0",
                "1.1",
                "sha256:old",
                "sha256:new",
                "candidate found",
                "{}",
                "2026-06-25T12:00:00.000Z"
            );
        cleanupCallbacks.push(() => {
            database
                .prepare(
                    "DELETE FROM docker_update_events WHERE managed_service_id = ? OR app_slug = 'coverage-app'"
                )
                .run(updaterServiceId);
            database
                .prepare(
                    "DELETE FROM docker_managed_services WHERE app_slug = 'coverage-app'"
                )
                .run();
        });

        const updaterServices = await dockerRoutes["/api/docker/updater/services"].GET();
        await expect(updaterServices.json()).resolves.toMatchObject({
            services: [
                expect.objectContaining({
                    appSlug: "coverage-app",
                    enabled: true,
                    metadata: { source: "test" },
                    serviceName: "api",
                    updateAvailable: true,
                }),
            ],
            summary: expect.objectContaining({
                enabled: 1,
                failed: 1,
                notifyPolicy: 1,
                total: 1,
                updateAvailable: 1,
            }),
        });

        const updaterEvents = await dockerRoutes["/api/docker/updater/events"].GET(
            new Request("https://test.local/api/docker/updater/events?limit=500")
        );
        await expect(updaterEvents.json()).resolves.toMatchObject({
            events: [
                expect.objectContaining({
                    appSlug: "coverage-app",
                    eventType: "update_available",
                    fromTag: "1.0",
                    managedServiceId: updaterServiceId,
                    serviceName: "api",
                    toTag: "1.1",
                }),
            ],
        });

        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        rememberEnvironment("MIRA_DOCKER_UPDATER_SKIP_REGISTRY");
        process.env.MIRA_DOCKER_APPS_ROOT = path.join(
            terminalRoot,
            "missing-docker-apps"
        );
        process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY = "1";
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'")
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'docker.updater'")
                .run();
        });
        const updaterRun = await dockerRoutes["/api/docker/updater/run"].POST();
        expect(updaterRun.status).toBe(200);
        await expect(updaterRun.json()).resolves.toMatchObject({
            isSuccess: false,
            steps: [
                expect.objectContaining({
                    isOk: false,
                    stderr: expect.stringContaining("Compose apps root not found"),
                    step: "register-services",
                }),
            ],
        });
        const updaterRunRow = database
            .prepare(
                "SELECT status FROM scheduled_job_runs WHERE job_id = 'docker.updater' ORDER BY id DESC LIMIT 1"
            )
            .get() as { status?: string } | undefined;
        expect(updaterRunRow).toEqual({ status: "failed" });

        const missingUpdaterService = await dockerRoutes[
            "/api/docker/updater/services/:serviceId/update"
        ].POST(
            requestWithParameters("/api/docker/updater/services/999999/update", {
                serviceId: "999999",
            })
        );
        expect(missingUpdaterService.status).toBe(404);

        const cronList = await cronRoutes["/api/cron/jobs"].GET();
        await expect(cronList.json()).resolves.toEqual({
            jobs: [{ enabled: true, id: "item-cron" }],
        });

        const badCronToggleBody = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/toggle",
                { id: "item-cron" },
                { body: "null", method: "POST" }
            )
        );
        expect(badCronToggleBody.status).toBe(400);

        const badCronToggleValue = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/toggle",
                { id: "item-cron" },
                { body: JSON.stringify({ enabled: "yes" }), method: "POST" }
            )
        );
        expect(badCronToggleValue.status).toBe(400);

        const failedCronRun = await cronRoutes["/api/cron/jobs/:id/run"].POST(
            requestWithParameters("/api/cron/jobs/item-cron/run", { id: "item-cron" })
        );
        expect(failedCronRun.status).toBe(502);
        await expect(failedCronRun.json()).resolves.toEqual({
            error: "gateway failed for cron.run",
        });

        const badCronUpdateBody = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/update",
                { id: "item-cron" },
                { body: JSON.stringify([]), method: "POST" }
            )
        );
        expect(badCronUpdateBody.status).toBe(400);

        const badCronUpdatePatch = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/update",
                { id: "item-cron" },
                { body: JSON.stringify({}), method: "POST" }
            )
        );
        expect(badCronUpdatePatch.status).toBe(400);

        for (const [route, handler] of [
            ["/api/moltbook/home", moltbookRoutes["/api/moltbook/home"].GET],
            [
                "/api/moltbook/feed?sort=new",
                (request?: Request) =>
                    moltbookRoutes["/api/moltbook/feed"].GET(
                        request ?? new Request("https://test.local/api/moltbook/feed")
                    ),
            ],
            ["/api/moltbook/profile", moltbookRoutes["/api/moltbook/profile"].GET],
            ["/api/moltbook/my-posts", moltbookRoutes["/api/moltbook/my-posts"].GET],
        ] as const) {
            const response = await handler(new Request(`https://test.local${route}`));
            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toEqual({
                error: expect.any(String),
            });
        }

        for (const [route, handler] of [
            [
                "/api/pull-requests/:number/approve",
                pullRequestRoutes["/api/pull-requests/:number/approve"].POST,
            ],
            [
                "/api/pull-requests/:number/reject",
                pullRequestRoutes["/api/pull-requests/:number/reject"].POST,
            ],
            [
                "/api/pull-requests/:number/review-approval",
                pullRequestRoutes["/api/pull-requests/:number/review-approval"].POST,
            ],
            [
                "/api/pull-requests/:number/update-branch",
                pullRequestRoutes["/api/pull-requests/:number/update-branch"].POST,
            ],
        ] as const) {
            const response = await handler(
                requestWithParameters(route.replace(":number", "bad"), { number: "bad" })
            );
            expect(response.status).toBe(400);
        }
    });

    it("aggregates metrics tokens by model, display label, and session type", async () => {
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const getSessionsSpy = jest.spyOn(gateway, "getSessions").mockReturnValue([
            {
                displayLabel: "Main chat",
                label: "main",
                model: "openai/gpt-5.5",
                tokenCount: 120,
                type: "chat",
            },
            {
                displayLabel: "",
                label: "coder",
                model: "anthropic/claude-sonnet",
                tokenCount: 80,
                type: "agent",
            },
            {
                displayLabel: "Untyped",
                label: "fallback",
                model: "",
                tokenCount: 5,
                type: "",
            },
        ] as ReturnType<typeof gateway.getSessions>);
        cleanupCallbacks.push(() => getSessionsSpy.mockRestore());

        const { metricsRoutes } = await import("../src/routes/metricsRoutes.ts");
        const response = await metricsRoutes["/api/metrics"].GET();
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            tokens: {
                byAgent: [
                    {
                        label: "Main chat",
                        model: "openai/gpt-5.5",
                        tokens: 120,
                        type: "chat",
                    },
                    {
                        label: "coder",
                        model: "anthropic/claude-sonnet",
                        tokens: 80,
                        type: "agent",
                    },
                    {
                        label: "Untyped",
                        model: "unknown",
                        tokens: 5,
                        type: "Unknown",
                    },
                ],
                byModel: {
                    "anthropic/claude-sonnet": 80,
                    "openai/gpt-5.5": 120,
                    unknown: 5,
                },
                sessionsByModel: {
                    "claude-sonnet": 1,
                    "gpt-5.5": 1,
                    unknown: 1,
                },
                total: 205,
            },
        });
    });

    it("serves log route listing and guarded tail reads from an isolated log root", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-route-coverage-");
        const currentLog = path.join(logsRoot, "openclaw-2026-06-25.log");
        const olderLog = path.join(logsRoot, "openclaw-2026-06-24.log");
        const ignoredLog = path.join(logsRoot, "other.log");
        writeFileSync(currentLog, "line 1\nline 2\nline 3\n");
        writeFileSync(olderLog, "older\n");
        writeFileSync(ignoredLog, "ignore\n");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;

        const { logRoutes } = await import("../src/routes/logRoutes.ts");

        const info = await logRoutes["/api/logs/info"].GET();
        await expect(info.json()).resolves.toMatchObject({
            logs: expect.arrayContaining([
                expect.objectContaining({ name: "openclaw-2026-06-25.log" }),
                expect.objectContaining({ name: "openclaw-2026-06-24.log" }),
            ]),
        });

        const explicitTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=2"
            )
        );
        await expect(explicitTail.json()).resolves.toEqual({
            content: "line 2\nline 3\n",
            file: "openclaw-2026-06-25.log",
            lineIds: ["7", "14", "21"],
        });

        const tailLineIds = (startOffset: number, content: string) => {
            const rawLines = content.split("\n");
            const lineIds: string[] = [];
            let offset = startOffset;

            for (const [index, line] of rawLines.entries()) {
                lineIds.push(String(offset));
                offset += Buffer.byteLength(line);
                if (index < rawLines.length - 1) {
                    offset += 1;
                }
            }

            return lineIds;
        };
        const largePrefix = `${"x".repeat(2 * 1024 * 1024 + 1024)}\n`;
        const largePrefixLength = Buffer.byteLength(largePrefix);

        writeFileSync(currentLog, `${largePrefix}complete tail\n`);
        const cappedTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        await expect(cappedTail.json()).resolves.toMatchObject({
            content: "complete tail\n",
            file: "openclaw-2026-06-25.log",
            lineIds: tailLineIds(largePrefixLength, "complete tail\n"),
        });

        const boundaryTailStart = "boundary first\nboundary second\n";
        const boundaryPrefix = "prefix before boundary\n";
        const boundaryTail =
            boundaryTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(boundaryTailStart));
        writeFileSync(currentLog, `${boundaryPrefix}${boundaryTail}`);
        const boundaryTailResponse = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log"
            )
        );
        const boundaryTailBody = (await boundaryTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(boundaryTailBody.content.startsWith(boundaryTailStart)).toBe(true);
        expect(boundaryTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(boundaryPrefix))
        );

        const prefixedJsonTailStart =
            '2026-06-27T20:00:00Z {"_meta":{"logLevelName":"INFO"},"0":"prefixed json tail"}\nplain after prefixed json\n';
        const prefixedJsonTail =
            prefixedJsonTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(prefixedJsonTailStart));
        writeFileSync(currentLog, `${boundaryPrefix}${prefixedJsonTail}`);
        const prefixedJsonTailResponse = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log"
            )
        );
        const prefixedJsonTailBody = (await prefixedJsonTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(prefixedJsonTailBody.content.startsWith(prefixedJsonTailStart)).toBe(true);
        expect(prefixedJsonTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(boundaryPrefix))
        );

        const multibytePrefix = "aé";
        const multibyteTailStart = "\nmultibyte boundary\n";
        const multibyteTail =
            multibyteTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(multibyteTailStart) - 1);
        writeFileSync(currentLog, `${multibytePrefix}${multibyteTail}`);
        const multibyteTailResponse = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log"
            )
        );
        const multibyteTailBody = (await multibyteTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(multibyteTailBody.content.startsWith("multibyte boundary\n")).toBe(true);
        expect(multibyteTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(multibytePrefix) + 1)
        );

        const metadataPlainTailStart =
            "runtimeVersion mismatch in _meta plain warning\nplain after metadata warning\n";
        const metadataPlainTail =
            metadataPlainTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(metadataPlainTailStart));
        writeFileSync(currentLog, `${boundaryPrefix}${metadataPlainTail}`);
        const metadataPlainTailResponse = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log"
            )
        );
        const metadataPlainTailBody = (await metadataPlainTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(metadataPlainTailBody.content.startsWith(metadataPlainTailStart)).toBe(
            true
        );
        expect(metadataPlainTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(boundaryPrefix))
        );

        const structuredFragment = String.raw`{\"subsystem\":\"gateway/ws\"}","1":"partial"`;
        writeFileSync(
            currentLog,
            largePrefix +
                structuredFragment +
                "\n" +
                "plain warning tail\n" +
                '{"level":"info","message":"complete json tail"}\n'
        );
        const cappedJsonTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        const cappedJsonTailContent =
            'plain warning tail\n{"level":"info","message":"complete json tail"}\n';
        await expect(cappedJsonTail.json()).resolves.toMatchObject({
            content: cappedJsonTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: tailLineIds(
                largePrefixLength + Buffer.byteLength(structuredFragment) + 1,
                cappedJsonTailContent
            ),
        });

        writeFileSync(
            currentLog,
            largePrefix +
                structuredFragment +
                "\n" +
                "plain warning tail\n" +
                ": retrying tail\n" +
                '{"level":"info","message":"complete json tail"}\n'
        );
        const cappedPlainTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=2"
            )
        );
        const cappedPlainTailContent =
            ': retrying tail\n{"level":"info","message":"complete json tail"}\n';
        await expect(cappedPlainTail.json()).resolves.toMatchObject({
            content: cappedPlainTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: tailLineIds(
                largePrefixLength +
                    Buffer.byteLength(structuredFragment) +
                    1 +
                    Buffer.byteLength("plain warning tail\n"),
                cappedPlainTailContent
            ),
        });

        const fragmentLookingPlainTailContent =
            ': first complete plain tail\n{"level":"info","message":"complete json tail"}\n';
        writeFileSync(currentLog, `${largePrefix}${fragmentLookingPlainTailContent}`);
        const cappedFragmentLookingPlainTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        await expect(cappedFragmentLookingPlainTail.json()).resolves.toMatchObject({
            content: fragmentLookingPlainTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: tailLineIds(largePrefixLength, fragmentLookingPlainTailContent),
        });

        const leadingBlankTailContent =
            '\n\n{"level":"info","message":"blank-preserved json tail"}\n';
        writeFileSync(currentLog, `${largePrefix}${leadingBlankTailContent}`);
        const leadingBlankTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        await expect(leadingBlankTail.json()).resolves.toMatchObject({
            content: leadingBlankTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: tailLineIds(largePrefixLength, leadingBlankTailContent),
        });

        const blankSeparatedTailContent =
            "older plain tail\n" + "\n".repeat(70 * 1024) + "newest plain tail\n";
        writeFileSync(currentLog, blankSeparatedTailContent);
        const blankSeparatedTail = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=2"
            )
        );
        const blankSeparatedTailBody = (await blankSeparatedTail.json()) as {
            content: string;
            file: string;
            lineIds: string[];
        };
        expect(blankSeparatedTailBody.file).toBe("openclaw-2026-06-25.log");
        expect(blankSeparatedTailBody.content).toContain("older plain tail\n");
        expect(blankSeparatedTailBody.content).toContain("newest plain tail\n");
        expect(blankSeparatedTailBody.lineIds).toContain("0");
        expect(blankSeparatedTailBody.lineIds).toContain(
            String(Buffer.byteLength("older plain tail\n") + 70 * 1024)
        );

        const invalidLines = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log&lines=abc"
            )
        );
        expect(invalidLines.status).toBe(400);

        const pathTraversal = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=../openclaw-2026-06-25.log"
            )
        );
        expect(pathTraversal.status).toBe(404);

        rmSync(currentLog);
        const missingLog = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log"
            )
        );
        expect(missingLog.status).toBe(404);

        rmSync(logsRoot, { force: true, recursive: true });
        const missingInfoRoot = await logRoutes["/api/logs/info"].GET();
        await expect(missingInfoRoot.json()).resolves.toEqual({ logs: [] });
        const missingContentRoot = await logRoutes["/api/logs/content"].GET(
            new Request(
                "https://test.local/api/logs/content?file=openclaw-2026-06-25.log"
            )
        );
        expect(missingContentRoot.status).toBe(404);
    });

    it("serves media from isolated OpenClaw roots while rejecting unsafe paths", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-media-route-");
        const outsideRoot = createTemporaryRoot("mira-media-outside-");
        const mediaRoot = path.join(openclawRoot, "media");
        mkdirSync(path.join(mediaRoot, "images"), { recursive: true });
        mkdirSync(path.join(mediaRoot, "folder"), { recursive: true });
        writeFileSync(path.join(mediaRoot, "images", "dashboard.txt"), "media ok");
        writeFileSync(path.join(mediaRoot, "images", "linked.txt"), "linked media");
        linkSync(
            path.join(mediaRoot, "images", "linked.txt"),
            path.join(mediaRoot, "images", "linked-hardlink.txt")
        );
        writeFileSync(
            path.join(outsideRoot, "secret.txt"),
            "outside media should not be served"
        );
        symlinkSync(
            path.join(outsideRoot, "secret.txt"),
            path.join(mediaRoot, "images", "outside-link.txt")
        );
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const { mediaRoutes } = await import("../src/routes/mediaRoutes.ts");

        const missingPath = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media")
        );
        expect(missingPath.status).toBe(403);

        const invalidPath = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=bad%00path")
        );
        expect(invalidPath.status).toBe(400);

        const directory = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=folder")
        );
        expect(directory.status).toBe(400);

        const outside = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/outside-link.txt")
        );
        expect(outside.status).toBe(403);

        const hardlink = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/linked-hardlink.txt")
        );
        expect(hardlink.status).toBe(403);

        const served = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/dashboard.txt")
        );
        expect(served.status).toBe(200);
        expect(served.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
        await expect(served.text()).resolves.toBe("media ok");

        process.env.OPENCLAW_HOME = createTemporaryRoot("mira-media-empty-root-");
        const missingMediaRoot = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/dashboard.txt")
        );
        expect(missingMediaRoot.status).toBe(404);
    });

    it("starts manual WAL-G backups through the backup route using fake Docker", async () => {
        rememberEnvironment("PATH");
        const fakeBin = createTemporaryRoot("mira-backup-route-docker-bin-");
        writeFakeBackupDocker(path.join(fakeBin, "docker"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        const { backupRoutes } = await import("../src/routes/backupRoutes.ts");
        const { getCurrentBackupJob, registerBackupScheduledJobs } =
            await import("../src/services/backups.ts");

        try {
            registerBackupScheduledJobs();
            const response = await backupRoutes["/api/backups/walg/run"].POST();
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                isOk?: boolean;
                job?: { id?: string; status?: string; type?: string };
            };
            expect(body).toMatchObject({
                isOk: true,
                job: { status: "running", type: "walg" },
            });

            const completed = await getCurrentBackupJob("walg")?.completed;
            expect(completed).toMatchObject({
                code: 0,
                status: "done",
                stdout: expect.stringContaining("backup ok"),
                type: "walg",
            });

            const status = backupRoutes["/api/backups/walg"].GET();
            await expect(status.json()).resolves.toMatchObject({
                job: { code: 0, status: "done", type: "walg" },
            });
            const clearedStatus = backupRoutes["/api/backups/walg"].GET();
            await expect(clearedStatus.json()).resolves.toEqual({ job: undefined });
        } finally {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'backup.%'")
                .run();
            database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'backup.%'").run();
        }
    });

    it("serves Docker inventory and safe mutations through a fake Docker CLI", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DOCKER_COMPOSE_WRAPPER");
        rememberEnvironment("MIRA_DOCKER_ROOT");
        const fakeBin = createTemporaryRoot("mira-docker-route-bin-");
        const dockerRoot = createTemporaryRoot("mira-docker-route-root-");
        writeFakeDockerCli(path.join(fakeBin, "docker"));
        writeExecutable(
            path.join(fakeBin, "compose"),
            "#!/usr/bin/env bash\nprintf 'compose:%s\\n' \"$*\"\n"
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER = path.join(fakeBin, "compose");
        process.env.MIRA_DOCKER_ROOT = dockerRoot;
        const { dockerRoutes } = await import("../src/routes/dockerRoutes.ts");

        const containers = await dockerRoutes["/api/docker/containers"].GET();
        await expect(containers.json()).resolves.toMatchObject({
            containers: [
                {
                    health: "healthy",
                    id: "abc123def456",
                    name: "demo",
                    project: "stack",
                    service: "web",
                    stats: { cpu: "1.00%" },
                },
            ],
        });

        const details = await dockerRoutes["/api/docker/containers/:containerId"].GET(
            requestWithParameters("/api/docker/containers/demo", { containerId: "demo" })
        );
        await expect(details.json()).resolves.toMatchObject({
            env: ["PUBLIC=value", "API_TOKEN=***", "URL=***"],
            id: "abc123def456",
            labels: {
                "com.docker.compose.project": "stack",
                "secret.url": "***",
            },
            networks: [{ ipAddress: "172.17.0.2", name: "bridge" }],
        });

        const invalidDetails = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/-bad", { containerId: "-bad" })
        );
        expect(invalidDetails.status).toBe(400);
        await expect(invalidDetails.json()).resolves.toEqual({
            error: "Invalid containerId",
        });

        const missingDetails = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/unknown", {
                containerId: "unknown",
            })
        );
        expect(missingDetails.status).toBe(404);
        await expect(missingDetails.json()).resolves.toEqual({
            error: "Container not found",
        });

        const logs = await dockerRoutes["/api/docker/containers/:containerId/logs"].GET(
            requestWithParameters("/api/docker/containers/abc123def456/logs?tail=10", {
                containerId: "abc123def456",
            })
        );
        await expect(logs.json()).resolves.toEqual({
            content: "container log line",
        });

        await expect(
            dockerRoutes["/api/docker/containers/:containerId/logs"].GET(
                requestWithParameters("/api/docker/containers/missing/logs?tail=abc", {
                    containerId: "missing",
                })
            )
        ).rejects.toThrow("docker logs failed with exit code 1: no such container");

        const restart = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/demo/action",
                { containerId: "demo" },
                {
                    body: JSON.stringify({ action: "restart" }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }
            )
        );
        await expect(restart.json()).resolves.toEqual({
            output: "restart sent to demo",
        });

        const invalidContainerAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/demo/action",
                { containerId: "demo" },
                {
                    body: JSON.stringify({ action: "pause" }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }
            )
        );
        expect(invalidContainerAction.status).toBe(400);
        await expect(invalidContainerAction.json()).resolves.toEqual({
            error: "Invalid container action",
        });

        const images = await dockerRoutes["/api/docker/images"].GET();
        await expect(images.json()).resolves.toMatchObject({
            images: [
                {
                    id: "sha256:image123",
                    inUseBy: ["demo"],
                    repository: "repo/app",
                    size: 13_107_200,
                    tag: "1.0",
                },
            ],
        });

        const removeImage = await dockerRoutes["/api/docker/images/:imageId"].DELETE(
            requestWithParameters("/api/docker/images/image123", { imageId: "image123" })
        );
        await expect(removeImage.json()).resolves.toEqual({ isSuccess: true });

        const invalidRemoveImage = await dockerRoutes[
            "/api/docker/images/:imageId"
        ].DELETE(requestWithParameters("/api/docker/images/-bad", { imageId: "-bad" }));
        expect(invalidRemoveImage.status).toBe(400);

        const volumes = await dockerRoutes["/api/docker/volumes"].GET();
        await expect(volumes.json()).resolves.toMatchObject({
            volumes: [{ name: "data", size: "1MB", usedBy: ["demo"] }],
        });

        const removeVolume = await dockerRoutes["/api/docker/volumes/:volumeName"].DELETE(
            requestWithParameters("/api/docker/volumes/data", { volumeName: "data" })
        );
        await expect(removeVolume.json()).resolves.toEqual({ isSuccess: true });

        const invalidRemoveVolume = await dockerRoutes[
            "/api/docker/volumes/:volumeName"
        ].DELETE(
            requestWithParameters("/api/docker/volumes/-bad", { volumeName: "-bad" })
        );
        expect(invalidRemoveVolume.status).toBe(400);

        const pruneImages = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", { target: "images" })
        );
        await expect(pruneImages.json()).resolves.toMatchObject({
            isSuccess: true,
            output: expect.stringContaining("image prune"),
        });

        const pruneVolumes = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", { target: "volumes" })
        );
        await expect(pruneVolumes.json()).resolves.toMatchObject({
            isSuccess: true,
            output: expect.stringContaining("volume prune"),
        });

        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", { target: "containers" })
        );
        expect(invalidPrune.status).toBe(400);
        await expect(invalidPrune.json()).resolves.toEqual({
            error: "Invalid prune target",
        });

        const malformedPrune = await dockerRoutes["/api/docker/prune"].POST(
            new Request("https://test.local/api/docker/prune", {
                body: "{",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(malformedPrune.status).toBe(400);
        await expect(malformedPrune.json()).resolves.toEqual({
            error: "Invalid JSON",
        });

        const stackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", { action: "stop" })
        );
        await expect(stackAction.json()).resolves.toEqual({
            output: "compose:stop",
        });

        const stackServiceAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", { action: "restart", service: "web" })
        );
        await expect(stackServiceAction.json()).resolves.toEqual({
            output: "compose:restart web",
        });

        const invalidStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", { action: "reload" })
        );
        expect(invalidStackAction.status).toBe(400);

        const invalidStackService = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", { action: "start", service: "-bad" })
        );
        expect(invalidStackService.status).toBe(400);

        const malformedStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            new Request("https://test.local/api/docker/stack/action", {
                body: "{",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(malformedStackAction.status).toBe(400);

        const malformedExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            new Request("https://test.local/api/docker/exec/start", {
                body: "{",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
        );
        expect(malformedExecStart.status).toBe(400);

        const invalidExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "",
                containerId: "demo",
            })
        );
        expect(invalidExecStart.status).toBe(400);

        const missingExecContainer = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "printf ok",
                containerId: "missing",
            })
        );
        expect(missingExecContainer.status).toBe(404);

        const missingAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/unknown/action",
                { containerId: "unknown" },
                {
                    body: JSON.stringify({ action: "start" }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                }
            )
        );
        expect(missingAction.status).toBe(404);
        await expect(missingAction.json()).resolves.toEqual({
            error: "Container not found",
        });

        const execStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "printf ok",
                containerId: "demo",
            })
        );
        const { jobId } = (await execStart.json()) as { jobId: string };
        expect(jobId).toEqual(expect.any(String));

        let execStatus = dockerRoutes["/api/docker/exec/:jobId"].GET(
            requestWithParameters(`/api/docker/exec/${jobId}`, { jobId })
        );
        let execData = (await execStatus.json()) as { status: string; stdout: string };
        const execDeadline = Date.now() + 15_000;
        while (execData.status !== "done" && Date.now() < execDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            execStatus = dockerRoutes["/api/docker/exec/:jobId"].GET(
                requestWithParameters(`/api/docker/exec/${jobId}`, { jobId })
            );
            execData = (await execStatus.json()) as { status: string; stdout: string };
        }
        expect(execData.status).toBe("done");
        expect(execData).toMatchObject({
            status: "done",
            stdout: expect.stringContaining("exec output"),
        });

        const stopCompletedExec = await dockerRoutes["/api/docker/exec/:jobId/stop"].POST(
            requestWithParameters(`/api/docker/exec/${jobId}/stop`, { jobId })
        );
        expect(stopCompletedExec.status).toBe(400);
        await expect(stopCompletedExec.json()).resolves.toEqual({
            error: "Job is not running",
        });
    });

    it("normalizes ops log-rotation status cache state", async () => {
        const { opsRoutes } = await import("../src/routes/opsRoutes.ts");
        const state = {
            lastRun: {
                checkedFiles: "3",
                checkedGroups: "2",
                compressedFiles: "1",
                deletedArchives: "4",
                finishedAt: "2026-06-25T00:01:00.000Z",
                groups: [{ name: "openclaw" }],
                isDryRun: true,
                isOk: false,
                message: "rotation failed",
                result: { code: "LOCKED" },
                rotatedFiles: "5",
                skippedFiles: "6",
                startedAt: "2026-06-25T00:00:00.000Z",
                stderr: "stderr details",
                warnings: ["warn"],
            },
        };
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES (?, ?, 'test', ?, ?, ?, 'fresh', 0, '{}') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, source = excluded.source, status = excluded.status, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at"
            )
            .run(
                "log_rotation.state",
                JSON.stringify(state),
                Date.now(),
                Date.now(),
                Date.now() + 60_000
            );

        const status = await opsRoutes["/api/ops/log-rotation/status"].GET();
        await expect(status.json()).resolves.toMatchObject({
            isSuccess: true,
            lastRun: {
                checkedFiles: 3,
                checkedGroups: 2,
                compressedFiles: 1,
                deletedArchives: 4,
                errors: [
                    {
                        message: "rotation failed",
                        result: { code: "LOCKED" },
                        stderr: "stderr details",
                    },
                ],
                isDryRun: true,
                isOk: false,
                rotatedFiles: 5,
                skippedFiles: 6,
                warnings: ["warn"],
            },
        });

        database
            .prepare(
                "UPDATE cache_entries SET data_json = ? WHERE key = 'log_rotation.state'"
            )
            .run("{not-json");
        const malformed = await opsRoutes["/api/ops/log-rotation/status"].GET();
        await expect(malformed.json()).resolves.toEqual({
            isSuccess: true,
            lastRun: undefined,
        });
    });

    it("exec service validation and error normalization branches", async () => {
        const { execErrorResponse, getExecJob, runExecOnce, startExecJob, stopExecJob } =
            await import("../src/services/execJobs.ts");

        await expect(runExecOnce(undefined)).rejects.toThrow(
            "request body must be a JSON object"
        );
        await expect(runExecOnce({ command: "" })).rejects.toThrow(
            "command must be a non-empty string"
        );
        await expect(
            runExecOnce({ command: "x".repeat(4097), shell: true })
        ).rejects.toThrow("command exceeds maximum length");
        await expect(runExecOnce({ command: "echo\nnope", shell: true })).rejects.toThrow(
            "command contains disallowed control characters"
        );
        await expect(runExecOnce({ command: "echo", shell: "yes" })).rejects.toThrow(
            "shell must be a boolean"
        );
        await expect(
            runExecOnce({ args: ["hi"], command: "echo", shell: true })
        ).rejects.toThrow("args cannot be combined with shell mode");
        await expect(runExecOnce({ command: "echo", shell: true })).rejects.toThrow(
            "shell mode is only available"
        );
        await expect(runExecOnce({ command: "echo" })).rejects.toThrow(
            "args are required"
        );
        await expect(runExecOnce({ args: "hi", command: "bash" })).rejects.toThrow(
            "args must be an array"
        );
        await expect(runExecOnce({ args: ["hi"], command: "./echo" })).rejects.toThrow(
            "command must be an approved executable name"
        );
        await expect(runExecOnce({ args: ["hi"], command: "echo" })).rejects.toThrow(
            "command executable is not approved"
        );
        await expect(
            runExecOnce({ args: ["-lc", "echo hi"], command: "bash" })
        ).rejects.toThrow("bash argv execution requires job tracking");
        expect(() => startExecJob({ args: ["-c", "echo hi"], command: "bash" })).toThrow(
            "bash args must be exactly"
        );
        expect(() =>
            startExecJob({ args: ["-lc", "x".repeat(4097)], command: "bash" })
        ).toThrow("command exceeds maximum length");
        expect(() =>
            startExecJob({ args: ["-lc", "echo\nnope"], command: "bash" })
        ).toThrow("command contains disallowed control characters");
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: "relative",
                shell: true,
            })
        ).rejects.toThrow("cwd must be an absolute path");
        const missingCwd = path.join(tmpdir(), "missing-mira-dashboard-exec-cwd");
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: missingCwd,
                shell: true,
            })
        ).rejects.toThrow("cwd does not exist");

        const result = await runExecOnce({
            command: "__mira_dashboard_shell_smoke_test__",
            cwd: process.cwd(),
            shell: true,
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("__mira_dashboard_shell_smoke_test__");

        const teapotError = Object.assign(new Error("nope"), { statusCode: 418 });
        expect(execErrorResponse(teapotError)).toEqual({
            error: "nope",
            status: 418,
        });
        const unknownExecError = JSON.parse("null") as unknown;
        expect(execErrorResponse(unknownExecError)).toEqual({
            error: "internal server error",
            status: 500,
        });

        expect(() => getExecJob("missing")).toThrow("Exec job not found");
        expect(() => stopExecJob("missing")).toThrow("Exec job not found");
        expect(() => startExecJob({ command: "" })).toThrow(
            "command must be a non-empty string"
        );

        const started = startExecJob({
            command: "__mira_dashboard_shell_smoke_test__",
            cwd: process.cwd(),
            shell: true,
        });
        expect(typeof started.jobId).toBe("string");
        const deadline = Date.now() + 5000;
        let completed = getExecJob(started.jobId);
        while (completed.status === "running" && Date.now() < deadline) {
            await Bun.sleep(10);
            completed = getExecJob(started.jobId);
        }
        expect(completed.status).toBe("done");
        expect(completed.code).not.toBe(0);
        expect(completed.stderr).toContain("__mira_dashboard_shell_smoke_test__");
        expect(() => stopExecJob(started.jobId)).toThrow("Job is not running");
    });

    it("log rotation config validation and dry-run summaries", async () => {
        const { runLogRotationService } = await import("../src/services/logRotation.ts");
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        const root = createTemporaryRoot("mira-log-rotation-");
        const logFile = path.join(root, "service.log");
        const excludedFile = path.join(root, "excluded.log");
        writeFileSync(logFile, "line 1\nline 2\n");
        writeFileSync(excludedFile, "skip me\n");

        const validConfig = path.join(root, "log-rotation.json");
        writeFileSync(
            validConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: { keep: 2, maxSizeMb: 0.000001, missingOk: false },
                groups: [
                    {
                        name: "app",
                        paths: [path.join(root, "*.log")],
                        excludePaths: [excludedFile],
                        strategy: "copytruncate",
                    },
                    {
                        enabled: false,
                        name: "disabled",
                        paths: [logFile],
                    },
                ],
            })
        );

        const summary = await runLogRotationService({
            config: validConfig,
            group: "app",
            isDryRun: true,
            verbose: true,
        });
        expect(summary.isOk).toBe(true);
        expect(summary.checkedGroups).toBe(1);
        expect(summary.checkedFiles).toBe(1);
        expect(summary.rotatedFiles).toBe(1);
        expect(summary.skippedFiles).toBe(0);

        const badVersionConfig = path.join(root, "bad-version.json");
        writeFileSync(
            badVersionConfig,
            JSON.stringify({ version: 2, groups: [{ name: "app", paths: [logFile] }] })
        );
        await expect(
            runLogRotationService({ config: badVersionConfig, isDryRun: true })
        ).rejects.toThrow("Config version must be 1");

        const missingPathsConfig = path.join(root, "missing-paths.json");
        writeFileSync(
            missingPathsConfig,
            JSON.stringify({ version: 1, groups: [{ name: "app" }] })
        );
        await expect(
            runLogRotationService({ config: missingPathsConfig, isDryRun: true })
        ).rejects.toThrow("Group app needs at least one path pattern");

        const conflictingCadenceConfig = path.join(root, "conflicting-cadence.json");
        writeFileSync(
            conflictingCadenceConfig,
            JSON.stringify({
                version: 1,
                groups: [{ daily: true, name: "app", paths: [logFile], weekly: true }],
            })
        );
        await expect(
            runLogRotationService({ config: conflictingCadenceConfig, isDryRun: true })
        ).rejects.toThrow("cannot set both daily and weekly");

        const invalidPolicyConfigs = [
            {
                config: {
                    version: 1,
                    approvedRoots: [],
                    groups: [{ name: "app", paths: [logFile] }],
                },
                message: "approvedRoots must include at least one entry",
                name: "empty-approved-roots.json",
            },
            {
                config: {
                    version: 1,
                    groups: [{ enabled: "yes", name: "app", paths: [logFile] }],
                },
                message: "Group app.enabled must be a boolean",
                name: "invalid-enabled.json",
            },
            {
                config: {
                    version: 1,
                    groups: [{ keep: 0, name: "app", paths: [logFile] }],
                },
                message: "Group app.keep must be a positive integer",
                name: "invalid-keep.json",
            },
            {
                config: {
                    version: 1,
                    groups: [
                        {
                            archiveOnly: true,
                            archiveRetentionScope: "global",
                            archivePaths: [path.join(root, "*.archive")],
                            name: "archives",
                        },
                    ],
                },
                message:
                    "Group archives archiveRetentionScope must be directory, basename, or parent",
                name: "invalid-archive-scope.json",
            },
            {
                config: {
                    version: 1,
                    groups: [{ archiveOnly: true, name: "archives" }],
                },
                message:
                    "Archive-only group archives needs at least one archivePaths pattern",
                name: "archive-only-missing-paths.json",
            },
        ];
        for (const invalid of invalidPolicyConfigs) {
            const filePath = path.join(root, invalid.name);
            writeFileSync(filePath, JSON.stringify(invalid.config));
            await expect(
                runLogRotationService({ config: filePath, isDryRun: true })
            ).rejects.toThrow(invalid.message);
        }

        const emptyLogFile = path.join(root, "empty.log");
        const dailyLogFile = path.join(root, "daily.log");
        writeFileSync(emptyLogFile, "");
        writeFileSync(dailyLogFile, "already rotated today\n");
        writeCacheSuccess({
            data: {
                version: 1,
                files: {
                    [dailyLogFile]: { lastRotatedAt: new Date().toISOString() },
                },
            },
            key: "log_rotation.state",
            metadata: {},
            source: "test",
            ttl: 1,
            ttlUnit: "hours",
        });
        const skipConfig = path.join(root, "skip-log-rotation.json");
        writeFileSync(
            skipConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: false,
                    strategy: "copytruncate",
                },
                groups: [
                    { name: "empty", paths: [emptyLogFile], skipEmpty: true },
                    { daily: true, maxSizeMb: 100, name: "daily", paths: [dailyLogFile] },
                ],
            })
        );
        const skipSummary = await runLogRotationService({
            config: skipConfig,
            isDryRun: true,
        });
        expect(skipSummary).toMatchObject({
            checkedFiles: 2,
            isOk: true,
            rotatedFiles: 0,
            skippedFiles: 2,
        });

        const liveLogFile = path.join(root, "live.log");
        writeFileSync(liveLogFile, "rotated bytes\n");
        const liveConfig = path.join(root, "live-log-rotation.json");
        writeFileSync(
            liveConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [{ name: "live", paths: [liveLogFile] }],
            })
        );

        const liveSummary = await runLogRotationService({
            config: liveConfig,
            group: "live",
            isDryRun: false,
        });
        expect(liveSummary).toMatchObject({
            checkedFiles: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(liveLogFile, "utf8")).toBe("");
        const archiveName = readdirSync(root).find((entry) =>
            entry.startsWith("live.log.202")
        );
        expect(archiveName).toBeDefined();
        const archivePath = path.join(root, archiveName ?? "");
        expect(existsSync(archivePath)).toBe(true);
        expect(readFileSync(archivePath, "utf8")).toBe("rotated bytes\n");

        const renameLogFile = path.join(root, "rename.log");
        writeFileSync(renameLogFile, "rename bytes\n");
        const renameConfig = path.join(root, "rename-log-rotation.json");
        writeFileSync(
            renameConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    keep: 1,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: true,
                    skipEmpty: false,
                    strategy: "rename",
                },
                groups: [{ name: "rename", paths: [renameLogFile] }],
            })
        );

        const renameSummary = await runLogRotationService({
            config: renameConfig,
            group: "rename",
            isDryRun: false,
        });
        const hasCompressionStream = "CompressionStream" in globalThis;
        expect(renameSummary).toMatchObject({
            compressedFiles: hasCompressionStream ? 1 : 0,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(renameLogFile, "utf8")).toBe("");
        const compressedRenameArchive = readdirSync(root).find((entry) =>
            entry.startsWith("rename.log.202")
        );
        expect(compressedRenameArchive).toBeDefined();
        if (hasCompressionStream) {
            expect(compressedRenameArchive?.endsWith(".gz")).toBe(true);
            const compressedRenameArchiveBytes = readFileSync(
                path.join(root, compressedRenameArchive ?? "")
            );
            expect(gunzipSync(compressedRenameArchiveBytes).toString("utf8")).toBe(
                "rename bytes\n"
            );
        } else {
            expect(compressedRenameArchive?.endsWith(".gz")).toBe(false);
            expect(
                readFileSync(path.join(root, compressedRenameArchive ?? ""), "utf8")
            ).toBe("rename bytes\n");
        }

        const archiveOnlyOld = path.join(root, "old.archive");
        const archiveOnlyNew = path.join(root, "new.archive");
        writeFileSync(archiveOnlyOld, "old archive\n");
        writeFileSync(archiveOnlyNew, "new archive\n");
        const oldDate = new Date(Date.now() - 60_000);
        const newDate = new Date();
        utimesSync(archiveOnlyOld, oldDate, oldDate);
        utimesSync(archiveOnlyNew, newDate, newDate);
        const archiveOnlyConfig = path.join(root, "archive-only-log-rotation.json");
        writeFileSync(
            archiveOnlyConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                groups: [
                    {
                        archiveOnly: true,
                        archivePaths: [path.join(root, "*.archive")],
                        keep: 1,
                        name: "archives",
                        shouldCompress: true,
                    },
                ],
            })
        );

        const archiveOnlySummary = await runLogRotationService({
            config: archiveOnlyConfig,
            isDryRun: true,
        });
        expect(archiveOnlySummary).toMatchObject({
            checkedFiles: 2,
            compressedFiles: 1,
            deletedArchives: 1,
            isDryRun: true,
            isOk: true,
        });
        expect(archiveOnlySummary.warnings).toEqual([]);
        expect(existsSync(archiveOnlyOld)).toBe(true);
        expect(existsSync(archiveOnlyNew)).toBe(true);

        const archiveOnlyLiveSummary = await runLogRotationService({
            config: archiveOnlyConfig,
            isDryRun: false,
        });
        expect(archiveOnlyLiveSummary).toMatchObject({
            checkedFiles: 2,
            compressedFiles: hasCompressionStream ? 1 : 0,
            deletedArchives: 1,
            isDryRun: false,
            isOk: true,
        });
        if (!hasCompressionStream) {
            const compressionWarning = expect.objectContaining({
                message: expect.stringContaining("Compression failed"),
            });
            expect(archiveOnlyLiveSummary.warnings).toEqual(
                expect.arrayContaining([compressionWarning])
            );
        }
        expect(existsSync(archiveOnlyOld)).toBe(false);
        if (hasCompressionStream) {
            expect(existsSync(archiveOnlyNew)).toBe(false);
            expect(
                gunzipSync(readFileSync(`${archiveOnlyNew}.gz`)).toString("utf8")
            ).toBe("new archive\n");
        } else {
            expect(existsSync(archiveOnlyNew)).toBe(true);
            expect(readFileSync(archiveOnlyNew, "utf8")).toBe("new archive\n");
        }
    });

    it("cached quota/system readers and notification checks", async () => {
        const { TASK_ASSIGNEE_IDS, TASK_ASSIGNEES } =
            await import("../src/constants/taskActors.ts");
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        const { fetchCachedQuotas, hasQuotaStatus } =
            await import("../src/lib/quotasCache.ts");
        const { fetchCachedSystemHost } = await import("../src/lib/systemCache.ts");
        const { runQuotaNotificationCheck } =
            await import("../src/services/quotaNotifications.ts");
        const {
            registerOpenClawNotificationScheduledJobs,
            runOpenClawNotificationCheck,
        } = await import("../src/services/openclawNotifications.ts");
        const { getScheduledJob, runScheduledJob } =
            await import("../src/services/scheduledJobs.ts");

        expect(TASK_ASSIGNEE_IDS).toContain(TASK_ASSIGNEES.mira.id);
        expect(hasQuotaStatus({ status: "not_configured" })).toBe(true);
        expect(hasQuotaStatus({ status: "fresh" })).toBe(false);
        await expect(fetchCachedQuotas()).rejects.toThrow("Quota cache entry");
        await expect(fetchCachedSystemHost()).rejects.toThrow("System host cache entry");

        const checkedAt = Date.now() - 1000;
        writeCacheSuccess({
            key: "quotas.summary",
            data: {
                checkedAt,
                cacheAgeMs: 0,
                openrouter: {
                    percentUsed: 91,
                    remaining: 4.25,
                    totalCredits: 100,
                    usage: 95.75,
                    usageMonthly: 95.75,
                },
                elevenlabs: {
                    percentUsed: 70,
                    remaining: 3000,
                    resetAt: undefined,
                    tier: "starter",
                    total: 10_000,
                    used: 7000,
                },
                synthetic: {
                    rollingFiveHourLimit: {
                        limited: false,
                        max: 100,
                        nextTickAt: undefined,
                        percentUsed: 96,
                        remaining: 4,
                    },
                    searchHourly: {
                        limit: 20,
                        percentUsed: 10,
                        remaining: 18,
                        renewsAt: undefined,
                        requests: 2,
                    },
                    subscription: {
                        limit: 100,
                        percentUsed: 50,
                        remaining: 50,
                        renewsAt: undefined,
                        requests: 50,
                    },
                    weeklyTokenLimit: {
                        nextRegenAt: undefined,
                        percentRemaining: 6,
                    },
                },
                openai: {
                    account: "codex",
                    fiveHourLeftPercent: 9,
                    fiveHourReset: undefined,
                    model: "gpt",
                    percentUsed: 91,
                    resetAt: undefined,
                    weeklyLeftPercent: 8,
                    weeklyReset: undefined,
                },
            },
            metadata: { source: "test" },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });

        const quotas = await fetchCachedQuotas();
        expect(quotas.cacheAgeMs).toBeGreaterThanOrEqual(0);
        expect(await runQuotaNotificationCheck()).toBe(true);
        const quotaNotifications = database
            .prepare(
                "SELECT title FROM notifications WHERE source = 'quota' ORDER BY title"
            )
            .all() as Array<{ title: string }>;
        expect(quotaNotifications.map((row) => row.title)).toEqual([
            "OpenAI / Codex usage high (80%)",
            "OpenAI / Codex usage high (90%)",
            "OpenRouter usage high (80%)",
            "OpenRouter usage high (90%)",
            "Synthetic.new usage high (80%)",
            "Synthetic.new usage high (90%)",
            "Synthetic.new usage high (95%)",
        ]);

        const systemHostPayload = JSON.parse(`{
            "checkedAt": "2026-06-25T10:00:00.000Z",
            "gateway": null,
            "version": {
                "checkedAt": ${checkedAt},
                "current": "1.0.0",
                "latest": "1.1.0",
                "updateAvailable": true
            }
        }`) as Record<string, unknown>;
        writeCacheSuccess({
            key: "system.host",
            data: systemHostPayload,
            metadata: { source: "test" },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });

        const systemHost = await fetchCachedSystemHost();
        expect(systemHost.data.gateway).toBeUndefined();
        expect(systemHost.meta).toEqual({ source: "test" });
        expect(await runOpenClawNotificationCheck()).toBe(true);
        const openClawNotification = database
            .prepare(
                "SELECT title, description FROM notifications WHERE source = 'openclaw' LIMIT 1"
            )
            .get() as { description: string; title: string } | undefined;
        expect(openClawNotification).toEqual({
            description: "Current 1.0.0 \u{2192} latest 1.1.0.",
            title: "OpenClaw update available",
        });

        writeCacheSuccess({
            key: "system.host",
            data: {
                checkedAt: "2026-06-25T11:00:00.000Z",
                gateway: undefined,
                version: {
                    checkedAt,
                    current: "1.1.0",
                    latest: "1.1.0",
                    updateAvailable: false,
                },
            },
            metadata: { source: "test" },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });
        expect(await runOpenClawNotificationCheck()).toBe(true);

        registerOpenClawNotificationScheduledJobs();
        expect(getScheduledJob("notifications.openclaw")).toMatchObject({
            actionKey: "notifications.openclaw",
            enabled: true,
            intervalSeconds: 3600,
        });
        const notificationRun = await runScheduledJob("notifications.openclaw");
        expect(notificationRun).toMatchObject({
            jobId: "notifications.openclaw",
            status: "success",
        });

        writeCacheSuccess({
            key: "system.host",
            data: {
                checkedAt: "2026-06-25T12:00:00.000Z",
                gateway: undefined,
            },
            metadata: { source: "test" },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            expect(await runOpenClawNotificationCheck()).toBe(false);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it("refreshes Moltbook cache entries through normalized API responses", async () => {
        rememberEnvironment("MOLTBOOK_API_KEY");
        process.env.MOLTBOOK_API_KEY = "test-key";
        const originalFetch = fetch;
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        });
        const requestedUrls: string[] = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (async (input: Parameters<typeof fetch>[0]) => {
                const url = String(input);
                requestedUrls.push(url);
                const body = url.endsWith("/home")
                    ? {
                          your_direct_messages: {
                              pending_request_count: "2",
                              unread_message_count: 3,
                          },
                          activity_on_your_posts: [{ id: "activity" }],
                          what_to_do_next: ["reply"],
                          latest_moltbook_announcement: {
                              author_name: "Moltbook",
                              created_at: "2026-06-25T10:00:00Z",
                              post_id: "post-1",
                              preview: "Hello",
                              title: "News",
                          },
                          posts_from_accounts_you_follow: [{ id: "followed" }],
                          explore: [{ id: "explore" }],
                      }
                    : url.includes("/feed?sort=hot")
                      ? {
                            feed_type: "hot",
                            has_more: true,
                            posts: [{ id: "hot-1" }],
                            tip: "hot tip",
                        }
                      : url.includes("/feed?sort=new")
                        ? {
                              feed_filter: "latest",
                              posts: [{ id: "new-1" }],
                          }
                        : url.includes("/agents/profile")
                          ? {
                                agent: { name: "mira_2026" },
                                recentComments: [{ id: "comment-1" }],
                                recentPosts: [{ id: "post-2" }],
                            }
                          : undefined;
                if (!body) {
                    return new Response("not found", { status: 404 });
                }
                return Response.json(body);
            }) as typeof fetch,
            writable: true,
        });

        const { refreshCacheProducer, refreshMoltbookCache } =
            await import("../src/services/cacheRefresh.ts");
        await expect(refreshMoltbookCache()).resolves.toEqual({
            refreshed: [
                "moltbook.home",
                "moltbook.feed.hot",
                "moltbook.feed.new",
                "moltbook.profile",
                "moltbook.my-content",
            ],
        });
        await expect(refreshCacheProducer("moltbook.feed.hot")).resolves.toEqual({
            refreshed: ["moltbook.feed.hot"],
        });
        expect(requestedUrls).toEqual(
            expect.arrayContaining([
                "https://www.moltbook.com/api/v1/home",
                "https://www.moltbook.com/api/v1/feed?sort=hot&limit=25",
                "https://www.moltbook.com/api/v1/feed?sort=new&limit=25",
                "https://www.moltbook.com/api/v1/agents/profile?name=mira_2026",
            ])
        );

        const rows = database
            .prepare(
                "SELECT key, data_json, source FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
            )
            .all() as Array<{ data_json: string; key: string; source: string }>;
        expect(rows.map((row) => row.key)).toEqual([
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.home",
            "moltbook.my-content",
            "moltbook.profile",
        ]);
        expect(rows.every((row) => row.source === "moltbook-api")).toBe(true);
        const home = JSON.parse(
            rows.find((row) => row.key === "moltbook.home")?.data_json ?? "{}"
        ) as Record<string, unknown>;
        expect(home).toMatchObject({
            activityOnYourPostsCount: 1,
            exploreCount: 1,
            pendingRequestCount: 2,
            unreadMessageCount: 3,
        });
        const profile = JSON.parse(
            rows.find((row) => row.key === "moltbook.profile")?.data_json ?? "{}"
        ) as Record<string, unknown>;
        expect(profile).toEqual({ agent: { name: "mira_2026" } });
    });

    it("refreshes backup and log-rotation cache producers through fake CLI output", async () => {
        rememberEnvironment("MIRA_DOCKER_BIN");
        const binRoot = createTemporaryRoot("mira-cache-cli-");
        const now = new Date().toISOString();
        const dockerBin = path.join(binRoot, "docker");
        writeExecutable(
            dockerBin,
            `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  cat <<'JSON'
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]}
]
JSON
elif [[ "$args" == "exec walg wal-g backup-list --detail --json" ]]; then
  cat <<'JSON'
[
  {"backup_name":"base_0001","finish_time":"${now}","start_time":"${now}","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
else
  echo "unexpected docker args: $*" >&2
  exit 2
fi
`
        );

        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        database
            .prepare(
                "DELETE FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status', 'log_rotation.state')"
            )
            .run();
        async function refreshWithFakeDocker(key: string) {
            let lastError: unknown;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    process.env.MIRA_DOCKER_BIN = dockerBin;
                    return await refreshCacheProducer(key);
                } catch (error) {
                    lastError = error;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }
            throw lastError;
        }

        await expect(refreshWithFakeDocker("backup.kopia.status")).resolves.toEqual({
            refreshed: ["backup.kopia.status"],
        });
        await expect(refreshWithFakeDocker("backup.walg.status")).resolves.toEqual({
            refreshed: ["backup.walg.status"],
        });
        await expect(refreshCacheProducer("log_rotation.state")).resolves.toEqual({
            refreshed: ["log_rotation.state"],
        });

        const rows = database
            .prepare(
                "SELECT key, data_json, status FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status', 'log_rotation.state') ORDER BY key"
            )
            .all() as Array<{ data_json: string; key: string; status: string }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["backup.kopia.status", "fresh"],
            ["backup.walg.status", "fresh"],
            ["log_rotation.state", "fresh"],
        ]);
        const kopia = JSON.parse(
            rows.find((row) => row.key === "backup.kopia.status")?.data_json ?? "{}"
        ) as { isOk?: boolean; latest?: unknown[]; stale?: unknown[] };
        expect(kopia).toMatchObject({
            isOk: true,
            latest: expect.arrayContaining([
                expect.objectContaining({ path: "/source/docker" }),
                expect.objectContaining({ path: "/source/openclaw" }),
                expect.objectContaining({ path: "/source/projects" }),
            ]),
            stale: [],
        });
        const walg = JSON.parse(
            rows.find((row) => row.key === "backup.walg.status")?.data_json ?? "{}"
        ) as { backupCount?: number; isOk?: boolean; latest?: { backupName?: string } };
        expect(walg).toMatchObject({
            backupCount: 1,
            isOk: true,
            latest: { backupName: "base_0001" },
        });
    });

    it("refreshes quota cache with isolated missing-provider state", async () => {
        for (const key of [
            "OPENROUTER_API_KEY",
            "ELEVENLABS_API_KEY",
            "SYNTHETIC_API_KEY",
            "CODEX_BIN",
            "QUOTAS_CODEX_HOME",
        ]) {
            rememberEnvironment(key);
            delete process.env[key];
        }
        const codexHome = createTemporaryRoot("mira-quota-codex-home-");
        process.env.CODEX_BIN = path.join(codexHome, "missing-codex");
        process.env.QUOTAS_CODEX_HOME = codexHome;

        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        await expect(refreshCacheProducer("quotas.summary")).resolves.toEqual({
            refreshed: ["quotas.summary"],
        });

        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'quotas.summary' LIMIT 1"
            )
            .get() as
            { data_json: string; metadata_json: string; status: string } | undefined;
        expect(row?.status).toBe("fresh");
        const data = JSON.parse(row?.data_json ?? "{}") as Record<
            string,
            Record<string, unknown>
        >;
        expect(data.openrouter).toEqual({ status: "not_configured" });
        expect(data.elevenlabs).toEqual({ status: "not_configured" });
        expect(data.synthetic).toEqual({ status: "not_configured" });
        expect(["not_configured", "error"]).toContain(String(data.openai?.status));
        const metadata = JSON.parse(row?.metadata_json ?? "{}") as {
            missing?: string[];
        };
        expect(metadata.missing).toEqual(
            expect.arrayContaining(["openrouter", "elevenlabs", "synthetic"])
        );
    });

    it("refreshes system cache through a fake OpenClaw binary", async () => {
        rememberEnvironment("OPENCLAW_BIN");
        const binRoot = createTemporaryRoot("mira-system-cache-bin-");
        const openclawBin = path.join(binRoot, "openclaw");
        writeExecutable(
            openclawBin,
            `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "status --json")
    cat <<'JSON'
{"runtimeVersion":"1.0.0","gateway":{"status":"ok"},"gatewayService":{"active":true},"nodeService":{"active":false},"heartbeat":{"ok":true},"tasks":{"queued":1},"taskAudit":{"stale":0}}
JSON
    ;;
  "update status --json")
    cat <<'JSON'
{"availability":{"latestVersion":"1.1.0"},"update":{"registry":{"latestVersion":"1.1.0"}}}
JSON
    ;;
  "doctor")
    printf '%s' "- WARNING: Gateway clients: informational"
    ;;
  "security audit --json")
    cat <<'JSON'
{"findings":[],"isOk":true}
JSON
    ;;
  *)
    echo "unexpected openclaw args: $*" >&2
    exit 2
    ;;
esac
`
        );
        process.env.OPENCLAW_BIN = openclawBin;

        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        await expect(refreshCacheProducer("system.host")).resolves.toEqual({
            refreshed: ["system.openclaw", "system.host"],
        });

        const rows = database
            .prepare(
                "SELECT key, data_json, status FROM cache_entries WHERE key IN ('system.openclaw', 'system.host') ORDER BY key"
            )
            .all() as Array<{ data_json: string; key: string; status: string }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["system.host", "fresh"],
            ["system.openclaw", "fresh"],
        ]);
        const openclaw = JSON.parse(
            rows.find((row) => row.key === "system.openclaw")?.data_json ?? "{}"
        ) as {
            doctorWarnings?: string[];
            security?: { isOk?: boolean };
            version?: { latest?: string; updateAvailable?: boolean };
        };
        expect(openclaw).toMatchObject({
            doctorWarnings: ["Gateway clients: informational"],
            security: { isOk: true },
            version: { latest: "1.1.0", updateAvailable: true },
        });
        const host = JSON.parse(
            rows.find((row) => row.key === "system.host")?.data_json ?? "{}"
        ) as {
            version?: { current?: string; latest?: string; updateAvailable?: boolean };
        };
        expect(host.version).toMatchObject({
            current: "1.0.0",
            latest: "1.1.0",
            updateAvailable: true,
        });
    });

    it("cache refresh scheduled job registration preserves disabled jobs", async () => {
        const {
            registerCacheRefreshScheduledJobs,
            seedMissingLocalCacheEntry,
            waitForLocalCacheSeed,
        } = await import("../src/services/cacheRefresh.ts");
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        const { runScheduledJob, upsertScheduledJob } =
            await import("../src/services/scheduledJobs.ts");
        const jobs = [
            ["cache.weather", "weather.spydeberg"],
            ["cache.quotas", "quotas.summary"],
            ["cache.system", "system.host"],
            ["cache.git", "git.workspace"],
            ["cache.moltbook", "moltbook"],
            ["cache.backup.kopia", "backup.kopia.status"],
            ["cache.backup.walg", "backup.walg.status"],
            ["cache.docker.summary", "docker.summary"],
            ["cache.database.summary", "database.summary"],
        ] as const;

        for (const [id, key] of jobs) {
            upsertScheduledJob({
                id,
                name: `Existing ${id}`,
                description: "Existing disabled cache refresh job.",
                enabled: false,
                scheduleType: "interval",
                intervalSeconds: 123,
                actionKey: "cache.refresh",
                actionPayload: { key },
            });
        }

        registerCacheRefreshScheduledJobs();

        const rows = database
            .prepare(
                "SELECT id, enabled, interval_seconds FROM scheduled_jobs WHERE id LIKE 'cache.%' ORDER BY id"
            )
            .all() as Array<{
            enabled: number;
            id: string;
            interval_seconds: number;
        }>;
        expect(rows).toHaveLength(jobs.length);
        expect(rows.every((row) => row.enabled === 0)).toBe(true);
        expect(rows.every((row) => row.interval_seconds === 123)).toBe(true);
        await expect(waitForLocalCacheSeed("weather.spydeberg")).resolves.toBeUndefined();

        const freshKey = `test.cache.fresh.${Bun.randomUUIDv7()}`;
        try {
            writeCacheSuccess({
                data: { isFresh: true },
                key: freshKey,
                metadata: { source: "coverage" },
                source: "unit",
                ttl: 10,
                ttlUnit: "minutes",
            });
            seedMissingLocalCacheEntry(freshKey);
            await expect(waitForLocalCacheSeed(freshKey)).resolves.toBeUndefined();
            expect(
                database
                    .prepare("SELECT status FROM cache_entries WHERE key = ?")
                    .get(freshKey)
            ).toEqual({ status: "fresh" });
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(freshKey);
        }

        upsertScheduledJob({
            id: "cache.invalid-payload",
            name: "Invalid cache refresh payload",
            description: "Coverage for cache.refresh payload validation.",
            enabled: false,
            scheduleType: "interval",
            intervalSeconds: 3600,
            actionKey: "cache.refresh",
            actionPayload: {},
        });
        await expect(runScheduledJob("cache.invalid-payload")).resolves.toMatchObject({
            jobId: "cache.invalid-payload",
            message:
                "Scheduled cache job cache.invalid-payload is missing actionPayload.key",
            status: "failed",
        });
    });

    it("registers hourly git cache and daily OpenClaw workspace sync jobs", async () => {
        const { registerCacheRefreshScheduledJobs } =
            await import("../src/services/cacheRefresh.ts");
        const { registerGitHygieneScheduledJobs } =
            await import("../src/services/gitHygiene.ts");

        registerCacheRefreshScheduledJobs();
        registerGitHygieneScheduledJobs();

        const rows = database
            .prepare(
                "SELECT id, schedule_type, interval_seconds, time_of_day, action_key FROM scheduled_jobs WHERE id IN ('cache.git', 'git.openclaw.workspace-sync') ORDER BY id"
            )
            .all() as Array<{
            action_key: string;
            id: string;
            interval_seconds: number;
            schedule_type: string;
            time_of_day: string | null;
        }>;
        expect(
            rows.map((row) => ({
                action_key: row.action_key,
                id: row.id,
                interval_seconds: row.interval_seconds,
                schedule_type: row.schedule_type,
            }))
        ).toEqual([
            {
                action_key: "cache.refresh",
                id: "cache.git",
                interval_seconds: 60 * 60,
                schedule_type: "interval",
            },
            {
                action_key: "git.openclaw.workspace-sync",
                id: "git.openclaw.workspace-sync",
                interval_seconds: 24 * 60 * 60,
                schedule_type: "daily",
            },
        ]);
        expect(rows.find((row) => row.id === "cache.git")?.time_of_day).toBeNull();
        expect(
            rows.find((row) => row.id === "git.openclaw.workspace-sync")?.time_of_day
        ).toBe("05:20");
    });
});
