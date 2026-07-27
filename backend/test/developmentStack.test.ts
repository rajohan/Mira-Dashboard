import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { describe, expect, it, jest } from "bun:test";

import { prepareDevelopmentOpenClawSnapshot } from "../src/development/developmentOpenClaw.ts";
import {
    developmentBackendEnvironment,
    prepareDevelopmentState,
    resetDevelopmentState,
    resolveDevelopmentStackConfig,
    runDevelopmentStack,
} from "../src/development/developmentStack.ts";

const CURRENT_COMMIT = "a".repeat(40);
const PREVIOUS_COMMIT = "b".repeat(40);
const SQL_NULL = JSON.parse("null") as null;
const RUNNING_PROCESS_EXIT_CODE = JSON.parse("null") as null;

function temporaryRoot(label: string): string {
    return mkdtempSync(path.join(tmpdir(), label));
}

function controllableDevelopmentChild() {
    const { promise, resolve } = Promise.withResolvers<number>();
    let exitCode: number | null = RUNNING_PROCESS_EXIT_CODE;
    const kill = jest.fn(() => {
        if (exitCode !== RUNNING_PROCESS_EXIT_CODE) return;
        exitCode = 0;
        resolve(0);
    });
    return {
        child: {
            exited: promise,
            get exitCode() {
                return exitCode;
            },
            kill,
        } as unknown as ReturnType<typeof Bun.spawn>,
        complete(code: number) {
            exitCode = code;
            resolve(code);
        },
        kill,
    };
}

function createSnapshotSource(databasePath: string): void {
    const database = new Database(databasePath);
    database.run(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            mfa_enabled_at TEXT
        );
        CREATE TABLE user_webauthn_credentials (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL
        );
        CREATE TABLE user_totp_factors (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            encrypted_secret TEXT NOT NULL
        );
        CREATE TABLE user_recovery_codes (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL
        );
        CREATE TABLE auth_webauthn_challenges (id TEXT PRIMARY KEY);
        CREATE TABLE auth_sessions (id TEXT PRIMARY KEY);
        CREATE TABLE auth_pending_logins (id TEXT PRIMARY KEY);
        CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE deployment_lock (id INTEGER PRIMARY KEY);
        CREATE TABLE deployment_jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            commit_sha TEXT,
            commit_title TEXT,
            note TEXT,
            stdout TEXT,
            stderr TEXT
        );
        CREATE TABLE scheduled_jobs (
            id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL,
            action_key TEXT NOT NULL,
            next_run_at TEXT
        );
        CREATE TABLE scheduled_job_runs (id INTEGER PRIMARY KEY);
        CREATE TABLE job_executions (id TEXT PRIMARY KEY);
        CREATE TABLE job_workers (id TEXT PRIMARY KEY);
        CREATE TABLE chat_runtime_snapshots (gateway_scope TEXT PRIMARY KEY);
        CREATE TABLE chat_runtime_snapshot_events (gateway_scope TEXT PRIMARY KEY);
    `);
    database.run(
        "INSERT INTO users (id, username, mfa_enabled_at) VALUES (1, 'key-user', 'now'), (2, 'totp-user', 'now')"
    );
    database.run(
        "INSERT INTO user_webauthn_credentials (id, user_id) VALUES ('credential', 1)"
    );
    database.run(
        "INSERT INTO user_totp_factors (id, user_id, encrypted_secret) VALUES ('totp', 2, 'production-secret')"
    );
    database.run("INSERT INTO user_recovery_codes (id, user_id) VALUES ('recovery', 2)");
    for (const [tableName, id] of [
        ["auth_webauthn_challenges", "challenge"],
        ["auth_sessions", "session"],
        ["auth_pending_logins", "pending"],
        ["job_executions", "execution"],
        ["job_workers", "worker"],
        ["chat_runtime_snapshots", "scope"],
        ["chat_runtime_snapshot_events", "scope"],
    ] as const) {
        database.run(`INSERT INTO ${tableName} VALUES (?)`, [id]);
    }
    database.run(
        "INSERT INTO app_config (key, value) VALUES ('gateway_token', 'encrypted'), ('theme', 'dark')"
    );
    database.run(`
        INSERT INTO deployment_jobs (
            id,
            status,
            started_at,
            updated_at,
            commit_sha,
            commit_title,
            note,
            stdout,
            stderr
        )
        VALUES
            (
                'deployment',
                'isOk',
                '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:01:00.000Z',
                'abc123',
                'Historical release',
                'Ready',
                NULL,
                NULL
            ),
            (
                'deployment-active',
                'building',
                '2026-01-02T00:00:00.000Z',
                '2026-01-02T00:00:30.000Z',
                'def456',
                'Active release',
                'Building',
                NULL,
                NULL
            )
    `);
    database.run("INSERT INTO deployment_lock (id) VALUES (1)");
    database.run(`
        INSERT INTO scheduled_jobs (id, enabled, action_key, next_run_at)
        VALUES
            ('cache', 1, 'cache.refresh', '2026-01-01T00:00:00.000Z'),
            ('database', 0, 'database.maintenance', NULL),
            ('backup', 1, 'backup.run', '2026-01-01T00:00:00.000Z')
    `);
    database.run("INSERT INTO scheduled_job_runs (id) VALUES (1)");
    database.close();
}

function createReleaseSource(root: string): string {
    const releaseRoot = path.join(root, "release-source");
    for (const commit of [CURRENT_COMMIT, PREVIOUS_COMMIT]) {
        const releasePath = path.join(releaseRoot, "releases", commit);
        mkdirSync(releasePath, { recursive: true });
        writeFileSync(path.join(releasePath, "release-manifest.json"), commit);
    }
    symlinkSync(
        path.posix.join("releases", CURRENT_COMMIT),
        path.join(releaseRoot, "current")
    );
    symlinkSync(
        path.posix.join("releases", PREVIOUS_COMMIT),
        path.join(releaseRoot, "previous")
    );
    return releaseRoot;
}

describe("development stack", () => {
    it("resolves one prod-like development mode defensively", () => {
        const root = temporaryRoot("mira-development-config-");
        try {
            const development = resolveDevelopmentStackConfig({ HOME: root }, root);
            expect(development).toMatchObject({
                backendHost: "127.0.0.1",
                backendPort: 3101,
                databaseSource: path.join(
                    root,
                    "projects",
                    "mira-dashboard",
                    "production",
                    "state",
                    "mira-dashboard.db"
                ),
                frontendHost: "127.0.0.1",
                frontendPort: 5173,
                gatewayUrl: "ws://127.0.0.1:18789",
                hotReload: true,
                publicOrigin: "http://localhost:5173",
                releaseSource: path.join(
                    root,
                    "projects",
                    "mira-dashboard",
                    "production",
                    "releases"
                ),
                rpId: "localhost",
                stateRoot: path.join(
                    root,
                    "projects",
                    "mira-dashboard",
                    "development",
                    "state",
                    "local"
                ),
            });

            const tokenFile = path.join(root, "gateway.token");
            const custom = resolveDevelopmentStackConfig(
                {
                    HOME: root,
                    MIRA_DASHBOARD_DEV_BACKEND_PORT: "4101",
                    MIRA_DASHBOARD_DEV_FRONTEND_PORT: "4173",
                    MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: tokenFile,
                    MIRA_DASHBOARD_DEV_GATEWAY_URL: "wss://gateway.example/ws",
                    MIRA_DASHBOARD_DEV_HOT_RELOAD: "0",
                    MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://dashboard.example:4173",
                    MIRA_DASHBOARD_DEV_STATE_ROOT: path.join(root, "state"),
                },
                root
            );
            expect(custom).toMatchObject({
                backendPort: 4101,
                frontendPort: 4173,
                gatewayTokenFile: tokenFile,
                gatewayUrl: "wss://gateway.example/ws",
                hotReload: false,
                rpId: "dashboard.example",
            });

            for (const environment of [
                {
                    HOME: root,
                    MIRA_DASHBOARD_DEV_BACKEND_PORT: "5173",
                    MIRA_DASHBOARD_DEV_FRONTEND_PORT: "5173",
                },
                {
                    HOME: root,
                    // eslint-disable-next-line unicorn/prefer-https -- Verifies that remote plain HTTP is rejected.
                    MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "http://dashboard.example",
                },
                {
                    HOME: root,
                    MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://127.0.0.1:5173",
                },
                {
                    HOME: root,
                    MIRA_DASHBOARD_DEV_GATEWAY_URL: "https://gateway.example",
                },
                {
                    HOME: root,
                    MIRA_DASHBOARD_DEV_HOT_RELOAD: "true",
                },
            ]) {
                expect(() => resolveDevelopmentStackConfig(environment, root)).toThrow();
            }
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("creates a scrubbed snapshot, copied release slots, and secret-minimized env", () => {
        const root = temporaryRoot("mira-development-state-");
        const sourceDatabase = path.join(root, "source.db");
        const stateRoot = path.join(root, "state");
        const releaseSource = createReleaseSource(root);
        createSnapshotSource(sourceDatabase);
        const gatewayTokenFile = path.join(root, "gateway.token");
        writeFileSync(gatewayTokenFile, "development-gateway-token\n", {
            mode: 0o600,
        });
        const workspaceSource = path.join(root, "workspace-source");
        mkdirSync(path.join(workspaceSource, "credentials"), { recursive: true });
        writeFileSync(path.join(workspaceSource, "README.md"), "development snapshot");
        writeFileSync(path.join(workspaceSource, ".env"), "SECRET=value");
        writeFileSync(path.join(workspaceSource, ".env.example"), "SAFE=example");
        writeFileSync(path.join(workspaceSource, ".netrc"), "machine example.test");
        writeFileSync(path.join(workspaceSource, ".npmrc"), "//registry/:_authToken=x");
        writeFileSync(path.join(workspaceSource, "client.pem"), "private key");
        writeFileSync(
            path.join(workspaceSource, "service-account.json"),
            '{"private_key":"secret"}'
        );
        writeFileSync(
            path.join(workspaceSource, "credentials", "service.token"),
            "secret"
        );
        const openClawConfigSource = path.join(root, "openclaw.json");
        writeFileSync(
            openClawConfigSource,
            JSON.stringify({
                agents: {
                    defaults: {
                        apiKeys: ["must-not-copy"],
                        authToken2: "must-not-copy",
                        gatewayToken: "must-not-copy",
                        model: { primary: "codex" },
                        passwords: ["must-not-copy"],
                        tokens: ["must-not-copy"],
                        workspace: "/production/workspace",
                    },
                    list: [{ default: true, id: "main" }],
                },
                gateway: { auth: { token: "must-not-copy" } },
            })
        );
        const config = resolveDevelopmentStackConfig(
            {
                HOME: root,
                MIRA_DASHBOARD_DEV_DB_SOURCE: sourceDatabase,
                MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: gatewayTokenFile,
                MIRA_DASHBOARD_DEV_GATEWAY_URL: "ws://127.0.0.1:18789",
                MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE: openClawConfigSource,
                MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://dashboard.example:5173",
                MIRA_DASHBOARD_DEV_RELEASES_SOURCE: releaseSource,
                MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
                MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE: workspaceSource,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example",
            },
            root
        );
        const originalGitHubToken = process.env.MIRA_GITHUB_TOKEN;
        process.env.MIRA_GITHUB_TOKEN = "must-not-leak";
        try {
            expect(prepareDevelopmentState(config)).toEqual({
                database: "snapshot-created",
                releases: "copied",
                workspace: "copied",
            });
            const snapshot = new Database(config.databasePath, { readonly: true });
            expect(
                JSON.stringify(
                    snapshot
                        .query("SELECT id, mfa_enabled_at FROM users ORDER BY id")
                        .all()
                )
            ).toBe('[{"id":1,"mfa_enabled_at":"now"},{"id":2,"mfa_enabled_at":null}]');
            expect(
                snapshot
                    .query("SELECT COUNT(*) AS count FROM user_webauthn_credentials")
                    .get()
            ).toEqual({ count: 1 });
            for (const tableName of [
                "auth_webauthn_challenges",
                "auth_sessions",
                "auth_pending_logins",
                "user_totp_factors",
                "user_recovery_codes",
                "deployment_lock",
                "job_executions",
                "scheduled_job_runs",
                "job_workers",
                "chat_runtime_snapshots",
                "chat_runtime_snapshot_events",
            ]) {
                expect(
                    snapshot.query(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
                ).toEqual({ count: 0 });
            }
            expect(
                snapshot
                    .query(
                        `SELECT id, status, commit_title
                         FROM deployment_jobs
                         ORDER BY id`
                    )
                    .all()
            ).toEqual([
                {
                    commit_title: "Historical release",
                    id: "deployment",
                    status: "isOk",
                },
            ]);
            expect(
                snapshot.query("SELECT key, value FROM app_config ORDER BY key").all()
            ).toEqual([{ key: "theme", value: "dark" }]);
            expect(
                snapshot
                    .query(
                        `SELECT id, enabled, action_key, next_run_at
                         FROM scheduled_jobs
                         ORDER BY id`
                    )
                    .all()
            ).toEqual([
                {
                    action_key: "backup.run",
                    enabled: 0,
                    id: "backup",
                    next_run_at: SQL_NULL,
                },
                {
                    action_key: "cache.refresh",
                    enabled: 1,
                    id: "cache",
                    next_run_at: "2026-01-01T00:00:00.000Z",
                },
                {
                    action_key: "database.maintenance",
                    enabled: 0,
                    id: "database",
                    next_run_at: SQL_NULL,
                },
            ]);
            snapshot.close();

            expect(readlinkSync(path.join(config.releaseRoot, "current"))).toBe(
                path.posix.join("releases", CURRENT_COMMIT)
            );
            expect(readlinkSync(path.join(config.releaseRoot, "previous"))).toBe(
                path.posix.join("releases", PREVIOUS_COMMIT)
            );
            expect(
                Buffer.from(
                    readFileSync(config.secretEncryptionKeyPath, "utf8").trim(),
                    "base64"
                )
            ).toHaveLength(32);
            const developmentWorkspace = path.join(config.openClawHome, "workspace");
            expect(
                readFileSync(path.join(developmentWorkspace, "README.md"), "utf8")
            ).toBe("development snapshot");
            expect(
                readFileSync(path.join(developmentWorkspace, ".env.example"), "utf8")
            ).toBe("SAFE=example");
            expect(existsSync(path.join(developmentWorkspace, ".env"))).toBe(false);
            expect(existsSync(path.join(developmentWorkspace, "credentials"))).toBe(
                false
            );
            for (const sensitiveFile of [
                ".netrc",
                ".npmrc",
                "client.pem",
                "service-account.json",
            ]) {
                expect(existsSync(path.join(developmentWorkspace, sensitiveFile))).toBe(
                    false
                );
            }
            const openClawConfigText = readFileSync(
                path.join(config.openClawHome, "openclaw.json"),
                "utf8"
            );
            expect(JSON.parse(openClawConfigText)).toEqual({
                agents: {
                    defaults: {
                        model: { primary: "codex" },
                        workspace: developmentWorkspace,
                    },
                    list: [{ default: true, id: "main" }],
                },
            });

            const environment = developmentBackendEnvironment(config);
            expect(environment).toMatchObject({
                BUN_BINARY: process.execPath,
                MIRA_DASHBOARD_COOKIE_NAMESPACE: "mira_dashboard_dev_5173",
                MIRA_DASHBOARD_DB_PATH: config.databasePath,
                MIRA_DASHBOARD_DEV_SAFE_MODE: "1",
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "0",
                MIRA_DASHBOARD_EXECUTION_ROLE: "combined",
                MIRA_DASHBOARD_FRONTEND_PATH: root,
                MIRA_DASHBOARD_JOB_PROFILE: "isolated",
                MIRA_DASHBOARD_LOGS_ROOT: path.join(stateRoot, "logs"),
                MIRA_DASHBOARD_METRICS_DISK_PATH: root,
                OPENCLAW_GATEWAY_TOKEN: "development-gateway-token",
                OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
            });
            expect(environment).not.toHaveProperty("MIRA_GITHUB_TOKEN");
            expect(environment).not.toHaveProperty(
                "MIRA_DASHBOARD_AUTOMATION_CREDENTIALS"
            );
            const legacySnapshot = new Database(config.databasePath);
            legacySnapshot.run("DELETE FROM deployment_jobs");
            legacySnapshot.close();
            expect(prepareDevelopmentState(config)).toEqual({
                database: "reused",
                releases: "reused",
                workspace: "reused",
            });
            const backfilledSnapshot = new Database(config.databasePath, {
                readonly: true,
            });
            expect(
                backfilledSnapshot
                    .query("SELECT id, status FROM deployment_jobs ORDER BY id")
                    .all()
            ).toEqual([{ id: "deployment", status: "isOk" }]);
            backfilledSnapshot.close();

            resetDevelopmentState(config);
            expect(existsSync(stateRoot)).toBe(false);
        } finally {
            if (originalGitHubToken === undefined) {
                delete process.env.MIRA_GITHUB_TOKEN;
            } else {
                process.env.MIRA_GITHUB_TOKEN = originalGitHubToken;
            }
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("re-scrubs copied MFA when a reused database moves to another RP", () => {
        const root = temporaryRoot("mira-development-rp-snapshot-");
        const sourceDatabase = path.join(root, "production.db");
        const stateRoot = path.join(root, "state");
        createSnapshotSource(sourceDatabase);
        mkdirSync(path.join(root, ".openclaw", "workspace"), { recursive: true });
        mkdirSync(
            path.join(root, "projects", "mira-dashboard", "production", "releases"),
            { recursive: true }
        );
        writeFileSync(path.join(root, ".openclaw", "openclaw.json"), "{}");
        const remoteConfig = resolveDevelopmentStackConfig(
            {
                HOME: root,
                MIRA_DASHBOARD_DEV_DB_SOURCE: sourceDatabase,
                MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://dashboard.example:5173",
                MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example",
            },
            root
        );
        const localConfig = resolveDevelopmentStackConfig(
            {
                HOME: root,
                MIRA_DASHBOARD_DEV_DB_SOURCE: sourceDatabase,
                MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "http://localhost:5173",
                MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example",
            },
            root
        );

        try {
            expect(prepareDevelopmentState(remoteConfig).database).toBe(
                "snapshot-created"
            );
            const remoteSnapshot = new Database(remoteConfig.databasePath, {
                readonly: true,
            });
            try {
                expect(
                    remoteSnapshot
                        .query("SELECT id, mfa_enabled_at FROM users ORDER BY id")
                        .all()
                ).toEqual([
                    { id: 1, mfa_enabled_at: "now" },
                    { id: 2, mfa_enabled_at: SQL_NULL },
                ]);
                expect(
                    remoteSnapshot
                        .query("SELECT COUNT(*) AS count FROM user_webauthn_credentials")
                        .get()
                ).toEqual({ count: 1 });
            } finally {
                remoteSnapshot.close();
            }

            expect(prepareDevelopmentState(localConfig).database).toBe("reused");
            const localSnapshot = new Database(localConfig.databasePath, {
                readonly: true,
            });
            try {
                expect(
                    localSnapshot
                        .query("SELECT id, mfa_enabled_at FROM users ORDER BY id")
                        .all()
                ).toEqual([
                    { id: 1, mfa_enabled_at: SQL_NULL },
                    { id: 2, mfa_enabled_at: SQL_NULL },
                ]);
                expect(
                    localSnapshot
                        .query("SELECT COUNT(*) AS count FROM user_webauthn_credentials")
                        .get()
                ).toEqual({ count: 0 });
            } finally {
                localSnapshot.close();
            }
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("rejects symlinked state directories before host-side writes", () => {
        const root = temporaryRoot("mira-development-state-symlink-");
        const sourceDatabase = path.join(root, "production.db");
        const releaseSource = path.join(root, "release-source");
        const stateRoot = path.join(root, "state");
        const outsideRoot = path.join(root, "outside");
        createSnapshotSource(sourceDatabase);
        mkdirSync(path.join(root, ".openclaw", "workspace"), { recursive: true });
        mkdirSync(releaseSource);
        mkdirSync(outsideRoot);
        writeFileSync(path.join(root, ".openclaw", "openclaw.json"), "{}");
        const config = resolveDevelopmentStackConfig(
            {
                HOME: root,
                MIRA_DASHBOARD_DEV_DB_SOURCE: sourceDatabase,
                MIRA_DASHBOARD_DEV_RELEASES_SOURCE: releaseSource,
                MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
            },
            root
        );

        try {
            expect(prepareDevelopmentState(config).releases).toBe("empty");
            rmSync(config.releaseRoot, { recursive: true });
            symlinkSync(outsideRoot, config.releaseRoot);

            expect(() => prepareDevelopmentState(config)).toThrow(
                "Development state path must be a real directory"
            );
            expect(readdirSync(outsideRoot)).toEqual([]);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("reads bounded OpenClaw config through one no-follow descriptor", () => {
        const root = temporaryRoot("mira-development-openclaw-config-");
        const configSource = path.join(root, "openclaw.json");
        const linkedConfigSource = path.join(root, "linked-openclaw.json");
        writeFileSync(configSource, JSON.stringify({ agents: {} }));
        symlinkSync(configSource, linkedConfigSource);

        try {
            expect(() =>
                prepareDevelopmentOpenClawSnapshot({
                    configSource: linkedConfigSource,
                    openClawHome: path.join(root, "linked-state"),
                })
            ).toThrow(
                "MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE must be a real regular file"
            );

            writeFileSync(configSource, " ".repeat(2 * 1024 * 1024 + 1));
            expect(() =>
                prepareDevelopmentOpenClawSnapshot({
                    configSource,
                    openClawHome: path.join(root, "oversized-state"),
                })
            ).toThrow("Development OpenClaw config source is too large");
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("refuses to claim or reset state without the exact checkout marker", () => {
        const root = temporaryRoot("mira-development-marker-");
        const stateRoot = path.join(root, "state");
        mkdirSync(stateRoot);
        writeFileSync(path.join(stateRoot, "unrelated.txt"), "keep");
        const config = resolveDevelopmentStackConfig(
            {
                HOME: root,
                MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
            },
            root
        );
        try {
            expect(() => prepareDevelopmentState(config)).toThrow(
                "Refusing to claim non-empty unmarked development state"
            );
            expect(() => resetDevelopmentState(config)).toThrow(
                "Refusing to reset unmarked development state"
            );
            expect(readFileSync(path.join(stateRoot, "unrelated.txt"), "utf8")).toBe(
                "keep"
            );
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("couples frontend and backend child lifecycles without watchers when disabled", async () => {
        const root = temporaryRoot("mira-development-processes-");
        const gatewayTokenFile = path.join(root, "gateway.token");
        writeFileSync(gatewayTokenFile, "development-gateway-token\n", {
            mode: 0o600,
        });
        mkdirSync(path.join(root, ".openclaw", "workspace"), {
            recursive: true,
        });
        writeFileSync(path.join(root, ".openclaw", "openclaw.json"), "{}");
        const databaseSource = path.join(
            root,
            "projects",
            "mira-dashboard",
            "production",
            "state",
            "mira-dashboard.db"
        );
        mkdirSync(path.dirname(databaseSource), { recursive: true });
        new Database(databaseSource).close();
        mkdirSync(
            path.join(root, "projects", "mira-dashboard", "production", "releases"),
            { recursive: true }
        );
        const config = resolveDevelopmentStackConfig(
            {
                HOME: root,
                MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: gatewayTokenFile,
                MIRA_DASHBOARD_DEV_HOT_RELOAD: "0",
                MIRA_DASHBOARD_DEV_STATE_ROOT: path.join(root, "state"),
            },
            root
        );
        const backend = controllableDevelopmentChild();
        const frontend = controllableDevelopmentChild();
        const spawnSpy = jest
            .spyOn(Bun, "spawn")
            .mockImplementationOnce(() => backend.child)
            .mockImplementationOnce(() => frontend.child);
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            const running = runDevelopmentStack(config);
            await Bun.sleep(0);
            backend.complete(7);
            await expect(running).resolves.toBe(7);
            expect(spawnSpy).toHaveBeenCalledTimes(2);
            expect(spawnSpy.mock.calls[0]?.[0]).toEqual([
                expect.any(String),
                "src/serverStart.ts",
            ]);
            expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({
                cwd: path.join(root, "backend"),
                env: expect.objectContaining({
                    MIRA_DASHBOARD_DEV_SAFE_MODE: "1",
                    MIRA_DASHBOARD_JOB_PROFILE: "isolated",
                }),
            });
            expect(spawnSpy.mock.calls[1]?.[0]).toEqual([
                expect.any(String),
                "scripts/developmentFrontend.ts",
            ]);
            expect(spawnSpy.mock.calls[1]?.[1]).toMatchObject({
                cwd: root,
                env: expect.objectContaining({
                    DASHBOARD_API_TARGET: "http://127.0.0.1:3101",
                    MIRA_DASHBOARD_DEV_HOT_RELOAD: "0",
                    MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "http://localhost:5173",
                    PORT: "5173",
                }),
            });
            expect(frontend.kill).toHaveBeenCalledWith("SIGTERM");
            expect(backend.kill).not.toHaveBeenCalled();
            const logFiles = readdirSync(path.join(config.stateRoot, "logs"));
            expect(logFiles).toHaveLength(1);
            expect(
                readFileSync(path.join(config.stateRoot, "logs", logFiles[0]!), "utf8")
                    .trim()
                    .split("\n")
            ).toHaveLength(25);
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Isolated scheduler/worker enabled.")
            );
            expect(errorSpy).toHaveBeenCalledWith(
                "Development backend exited with code 7"
            );
        } finally {
            spawnSpy.mockRestore();
            logSpy.mockRestore();
            errorSpy.mockRestore();
            rmSync(root, { force: true, recursive: true });
        }
    });
});
