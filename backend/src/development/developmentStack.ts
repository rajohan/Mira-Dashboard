import { randomBytes } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { formatOpenClawLogDate } from "../lib/logRoots.ts";
import {
    type DevelopmentWorkspaceState,
    prepareDevelopmentOpenClawSnapshot,
} from "./developmentOpenClaw.ts";

const DEVELOPMENT_STATE_MARKER = ".mira-dashboard-development-state.json";
const DEVELOPMENT_SECRET_FILE = ".secret-encryption-key";
const RELEASE_SHA_PATTERN = /^[\da-f]{40}$/u;
const HOST_PATTERN = /^(?:localhost|[\da-f:.]+|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/iu;
const RP_ID_PATTERN =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u;
const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_BACKEND_PORT = 3101;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const SECRET_KEY_BYTES = 32;
const DEVELOPMENT_LOG_FIXTURE_INTERVAL_MS = 5000;
const MAX_DEVELOPMENT_LOG_BYTES = 2 * 1024 * 1024;
const ISOLATED_JOB_ACTION_KEYS = ["cache.refresh", "database.maintenance"] as const;
const INHERITED_ENVIRONMENT_KEYS = [
    "COLORTERM",
    "DBUS_SESSION_BUS_ADDRESS",
    "FORCE_COLOR",
    "LANG",
    "LC_ALL",
    "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
    "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
    "NO_COLOR",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_RUNTIME_DIR",
] as const;

export interface DevelopmentStackConfig {
    apiTarget: string;
    backendHost: string;
    backendPort: number;
    databasePath: string;
    databaseSource?: string;
    frontendHost: string;
    frontendPort: number;
    gatewayTokenFile?: string;
    gatewayUrl: string;
    openClawClientHome: string;
    openClawConfigSource?: string;
    openClawHome: string;
    publicOrigin: string;
    releaseRoot: string;
    releaseSource?: string;
    repositoryRoot: string;
    rpId: string;
    secretEncryptionKeyPath: string;
    sourceWebAuthnRpId?: string;
    stateOwner: string;
    stateRoot: string;
    workspaceSource?: string;
}

export interface DevelopmentStateResult {
    database: "created-empty" | "reused" | "snapshot-created";
    releases: "copied" | "empty" | "reused";
    workspace: DevelopmentWorkspaceState;
}

function developmentLogsRoot(config: DevelopmentStackConfig): string {
    return path.join(config.stateRoot, "logs");
}

interface DevelopmentLogFixtureEntry {
    level: "DEBUG" | "ERROR" | "FATAL" | "INFO" | "TRACE" | "WARN";
    message: string;
}

const DEVELOPMENT_LOG_FIXTURES = [
    {
        level: "TRACE",
        message: "[dashboard-dev] Synthetic trace entry for virtualized history testing.",
    },
    {
        level: "DEBUG",
        message: "[gateway] Synthetic debug entry: capability proxy poll completed.",
    },
    {
        level: "INFO",
        message:
            "[worker] Synthetic info entry: database.summary completed successfully.",
    },
    {
        level: "WARN",
        message:
            "[sandbox] Synthetic warning entry for level-filter testing; no incident.",
    },
    {
        level: "ERROR",
        message: "[logs] Synthetic error entry for search/export testing; no incident.",
    },
    {
        level: "FATAL",
        message:
            "[logs] Synthetic fatal entry for complete filter coverage; no incident.",
    },
] as const satisfies readonly DevelopmentLogFixtureEntry[];

function developmentLogPath(
    config: DevelopmentStackConfig,
    timestamp = new Date()
): string {
    return path.join(
        developmentLogsRoot(config),
        `openclaw-${formatOpenClawLogDate(timestamp)}.log`
    );
}

function appendDevelopmentLogEntry(
    config: DevelopmentStackConfig,
    entry: DevelopmentLogFixtureEntry,
    timestamp = new Date()
): void {
    const logPath = developmentLogPath(config, timestamp);
    if (existsSync(logPath) && statSync(logPath).size >= MAX_DEVELOPMENT_LOG_BYTES) {
        return;
    }
    appendFileSync(
        logPath,
        `${JSON.stringify({
            0: entry.message,
            _meta: {
                date: timestamp.toISOString(),
                logLevelName: entry.level,
            },
        })}\n`,
        { encoding: "utf8", mode: 0o600 }
    );
    chmodSync(logPath, 0o600);
}

function prepareDevelopmentLog(config: DevelopmentStackConfig): void {
    const logsRoot = developmentLogsRoot(config);
    mkdirSync(logsRoot, { mode: 0o700, recursive: true });
    chmodSync(logsRoot, 0o700);
    const timestamp = new Date();
    const logPath = developmentLogPath(config, timestamp);
    if (!existsSync(logPath) || statSync(logPath).size < 1024) {
        for (let index = 0; index < 24; index += 1) {
            appendDevelopmentLogEntry(
                config,
                DEVELOPMENT_LOG_FIXTURES[index % DEVELOPMENT_LOG_FIXTURES.length]!,
                new Date(timestamp.getTime() - (24 - index) * 1000)
            );
        }
    }
    appendDevelopmentLogEntry(config, {
        level: "INFO",
        message:
            "[dashboard-dev] Isolated Dashboard dev log started; host logs are not mounted.",
    });
}

interface DevelopmentStateMarker {
    formatVersion: 1;
    owner: string;
}

function configuredPort(
    name: string,
    value: string | undefined,
    fallback: number
): number {
    const rawValue = value?.trim();
    if (!rawValue) {
        return fallback;
    }
    if (!/^\d+$/u.test(rawValue)) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    const port = Number(rawValue);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    return port;
}

function configuredHost(
    name: string,
    value: string | undefined,
    fallback: string
): string {
    const host = value?.trim() || fallback;
    if (host.length > 253 || !HOST_PATTERN.test(host) || /[\s/\\\0]/u.test(host)) {
        throw new TypeError(`${name} must be a valid listen hostname or IP address`);
    }
    return host;
}

function configuredStateOwner(value: string | undefined, fallback: string): string {
    const owner = value?.trim() || fallback;
    if (!owner || owner.length > 512 || /[\r\n\0]/u.test(owner)) {
        throw new TypeError(
            "MIRA_DASHBOARD_DEV_STATE_OWNER must be a non-empty stable identifier"
        );
    }
    return owner;
}

function absoluteNonRootPath(
    name: string,
    value: string | undefined,
    fallback?: string
): string | undefined {
    const configured = value?.trim() || fallback;
    if (!configured) {
        return undefined;
    }
    if (!path.isAbsolute(configured)) {
        throw new TypeError(`${name} must be an absolute path`);
    }
    const resolved = path.resolve(configured);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must not be a filesystem root`);
    }
    return resolved;
}

function normalizedPublicOrigin(value: string | undefined, frontendPort: number): URL {
    let origin: URL;
    try {
        origin = new URL(value?.trim() || `http://localhost:${frontendPort}`);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN must be a valid URL");
    }
    const isLocalhost =
        origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
    const hasValidProtocol =
        origin.protocol === "https:" || (origin.protocol === "http:" && isLocalhost);
    if (
        !hasValidProtocol ||
        origin.username ||
        origin.password ||
        (origin.pathname !== "/" && origin.pathname !== "") ||
        origin.search ||
        origin.hash
    ) {
        throw new TypeError(
            "Development public origin must be HTTPS or local HTTP without credentials, path, query, or fragment"
        );
    }
    if (isIP(origin.hostname)) {
        throw new TypeError(
            "Development public origin must use localhost or a stable DNS hostname for WebAuthn"
        );
    }
    return origin;
}

function normalizedGatewayUrl(value: string | undefined): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    let gatewayUrl: URL;
    try {
        gatewayUrl = new URL(configured);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_GATEWAY_URL must be a valid URL");
    }
    if (
        !["ws:", "wss:"].includes(gatewayUrl.protocol) ||
        gatewayUrl.username ||
        gatewayUrl.password ||
        gatewayUrl.hash
    ) {
        throw new TypeError(
            "MIRA_DASHBOARD_DEV_GATEWAY_URL must be a ws:// or wss:// URL without credentials or a fragment"
        );
    }
    return gatewayUrl.href;
}

function normalizedOptionalRpId(
    name: string,
    value: string | undefined
): string | undefined {
    const rpId = value?.trim().toLowerCase();
    if (!rpId) return undefined;
    if (rpId.length > 253 || !RP_ID_PATTERN.test(rpId) || isIP(rpId)) {
        throw new TypeError(`${name} must be a stable DNS relying-party id`);
    }
    return rpId;
}

/** Resolves one isolated frontend/backend development stack. */
export function resolveDevelopmentStackConfig(
    environment: Record<string, string | undefined>,
    root: string
): DevelopmentStackConfig {
    const resolvedRepoRoot = path.resolve(root);
    const frontendPort = configuredPort(
        "MIRA_DASHBOARD_DEV_FRONTEND_PORT",
        environment.MIRA_DASHBOARD_DEV_FRONTEND_PORT,
        DEFAULT_FRONTEND_PORT
    );
    const backendPort = configuredPort(
        "MIRA_DASHBOARD_DEV_BACKEND_PORT",
        environment.MIRA_DASHBOARD_DEV_BACKEND_PORT,
        DEFAULT_BACKEND_PORT
    );
    if (frontendPort === backendPort) {
        throw new TypeError("Frontend and backend development ports must be distinct");
    }
    const hostHome = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_HOST_HOME",
        environment.MIRA_DASHBOARD_DEV_HOST_HOME,
        environment.HOME?.trim() || os.homedir()
    );
    if (!hostHome) {
        throw new Error("Could not resolve the host home for development snapshots");
    }
    const stateRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        environment.MIRA_DASHBOARD_DEV_STATE_ROOT,
        path.join(hostHome, "projects", "mira-dashboard-dev-state", "local")
    );
    if (!stateRoot) {
        throw new Error("Development state root could not be resolved");
    }
    const publicOrigin = normalizedPublicOrigin(
        environment.MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN,
        frontendPort
    );
    const gatewayTokenFile = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
        environment.MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE
    );
    const gatewayUrl = normalizedGatewayUrl(environment.MIRA_DASHBOARD_DEV_GATEWAY_URL);
    const openClawSourceRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_OPENCLAW_SOURCE_ROOT",
        environment.MIRA_DASHBOARD_DEV_OPENCLAW_SOURCE_ROOT,
        path.join(hostHome, ".openclaw")
    );

    return {
        apiTarget: `http://127.0.0.1:${backendPort}`,
        backendHost: configuredHost(
            "MIRA_DASHBOARD_DEV_BACKEND_HOST",
            environment.MIRA_DASHBOARD_DEV_BACKEND_HOST,
            "127.0.0.1"
        ),
        backendPort,
        databasePath: path.join(stateRoot, "mira-dashboard.db"),
        databaseSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_DB_SOURCE",
            environment.MIRA_DASHBOARD_DEV_DB_SOURCE,
            path.join(hostHome, "projects", "mira-dashboard-state", "mira-dashboard.db")
        ),
        frontendHost: configuredHost(
            "MIRA_DASHBOARD_DEV_FRONTEND_HOST",
            environment.MIRA_DASHBOARD_DEV_FRONTEND_HOST,
            "127.0.0.1"
        ),
        frontendPort,
        gatewayTokenFile,
        gatewayUrl: gatewayUrl || DEFAULT_GATEWAY_URL,
        openClawClientHome: path.join(stateRoot, "openclaw-client"),
        openClawConfigSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE",
            environment.MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE,
            openClawSourceRoot
                ? path.join(openClawSourceRoot, "openclaw.json")
                : undefined
        ),
        openClawHome: path.join(stateRoot, "openclaw-home"),
        publicOrigin: publicOrigin.origin,
        releaseRoot: path.join(stateRoot, "releases-root"),
        releaseSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_RELEASES_SOURCE",
            environment.MIRA_DASHBOARD_DEV_RELEASES_SOURCE,
            path.join(hostHome, "projects", "mira-dashboard-releases")
        ),
        repositoryRoot: resolvedRepoRoot,
        rpId: publicOrigin.hostname.toLowerCase(),
        secretEncryptionKeyPath: path.join(stateRoot, DEVELOPMENT_SECRET_FILE),
        sourceWebAuthnRpId: normalizedOptionalRpId(
            "MIRA_DASHBOARD_DEV_SOURCE_WEBAUTHN_RP_ID",
            environment.MIRA_DASHBOARD_DEV_SOURCE_WEBAUTHN_RP_ID ||
                environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID
        ),
        stateOwner: configuredStateOwner(
            environment.MIRA_DASHBOARD_DEV_STATE_OWNER,
            "local-dashboard-dev"
        ),
        stateRoot,
        workspaceSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE",
            environment.MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE,
            openClawSourceRoot ? path.join(openClawSourceRoot, "workspace") : undefined
        ),
    };
}

function isRealRegularFile(filePath: string): boolean {
    try {
        const stat = lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function isRealDirectory(directoryPath: string): boolean {
    try {
        const stat = lstatSync(directoryPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function isPathPresentNoFollow(filePath: string): boolean {
    try {
        lstatSync(filePath);
        return true;
    } catch {
        return false;
    }
}

function hasTable(database: Database, tableName: string): boolean {
    return Boolean(
        database
            .query(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
            )
            .get(tableName)
    );
}

function runIfTableExists(
    database: Database,
    tableName: string,
    statement: string
): void {
    if (hasTable(database, tableName)) {
        database.run(statement);
    }
}

function scrubDevelopmentDatabase(
    databasePath: string,
    shouldPreserveWebAuthnCredentials: boolean
): void {
    const database = new Database(databasePath);
    try {
        database.run("PRAGMA foreign_keys = ON");
        database.run("PRAGMA busy_timeout = 5000");
        database.run("BEGIN IMMEDIATE");
        runIfTableExists(
            database,
            "auth_webauthn_challenges",
            "DELETE FROM auth_webauthn_challenges"
        );
        runIfTableExists(database, "auth_sessions", "DELETE FROM auth_sessions");
        runIfTableExists(
            database,
            "auth_pending_logins",
            "DELETE FROM auth_pending_logins"
        );
        runIfTableExists(database, "user_totp_factors", "DELETE FROM user_totp_factors");
        runIfTableExists(
            database,
            "user_recovery_codes",
            "DELETE FROM user_recovery_codes"
        );
        if (!shouldPreserveWebAuthnCredentials) {
            runIfTableExists(
                database,
                "user_webauthn_credentials",
                "DELETE FROM user_webauthn_credentials"
            );
        }
        if (
            hasTable(database, "users") &&
            hasTable(database, "user_webauthn_credentials")
        ) {
            database.run(
                `UPDATE users
                 SET mfa_enabled_at = NULL
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM user_webauthn_credentials credential
                     WHERE credential.user_id = users.id
                 )`
            );
        }
        if (hasTable(database, "app_config")) {
            database.run("DELETE FROM app_config WHERE key = 'gateway_token'");
        }
        runIfTableExists(database, "deployment_lock", "DELETE FROM deployment_lock");
        runIfTableExists(database, "deployment_jobs", "DELETE FROM deployment_jobs");
        runIfTableExists(database, "job_executions", "DELETE FROM job_executions");
        runIfTableExists(
            database,
            "scheduled_job_runs",
            "DELETE FROM scheduled_job_runs"
        );
        runIfTableExists(database, "job_workers", "DELETE FROM job_workers");
        if (hasTable(database, "scheduled_jobs")) {
            const placeholders = ISOLATED_JOB_ACTION_KEYS.map(() => "?").join(", ");
            database
                .prepare(
                    `UPDATE scheduled_jobs
                     SET enabled = 0, next_run_at = NULL
                     WHERE action_key NOT IN (${placeholders})`
                )
                .run(...ISOLATED_JOB_ACTION_KEYS);
        }
        runIfTableExists(
            database,
            "chat_runtime_snapshot_events",
            "DELETE FROM chat_runtime_snapshot_events"
        );
        runIfTableExists(
            database,
            "chat_runtime_snapshots",
            "DELETE FROM chat_runtime_snapshots"
        );
        database.run("COMMIT");
        const quickCheck = database.query("PRAGMA quick_check").get() as
            Record<string, unknown> | undefined;
        if (
            !quickCheck ||
            Object.values(quickCheck).every(
                (value) => !(typeof value === "string" && value.toLowerCase() === "ok")
            )
        ) {
            throw new Error("Development database snapshot failed SQLite quick_check");
        }
    } catch (error) {
        if (database.inTransaction) {
            database.run("ROLLBACK");
        }
        throw error;
    } finally {
        database.close();
    }
}

function createDevelopmentDatabaseSnapshot(
    sourcePath: string,
    targetPath: string,
    shouldPreserveWebAuthnCredentials: boolean
): void {
    if (!isRealRegularFile(sourcePath)) {
        throw new Error(
            `MIRA_DASHBOARD_DEV_DB_SOURCE must be a real regular file: ${sourcePath}`
        );
    }
    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
        throw new Error("Development database source and target must be distinct");
    }
    const stagingPath = `${targetPath}.partial-${Bun.randomUUIDv7()}`;
    try {
        const source = new Database(sourcePath, { readonly: true });
        try {
            source.run("PRAGMA busy_timeout = 5000");
            source.prepare("VACUUM INTO ?").run(stagingPath);
        } finally {
            source.close();
        }
        chmodSync(stagingPath, 0o600);
        scrubDevelopmentDatabase(stagingPath, shouldPreserveWebAuthnCredentials);
        renameSync(stagingPath, targetPath);
    } catch (error) {
        rmSync(stagingPath, { force: true });
        throw error;
    }
}

function releaseCommitForSlot(
    sourceRoot: string,
    slot: "current" | "previous"
): string | undefined {
    const linkPath = path.join(sourceRoot, slot);
    if (!isPathPresentNoFollow(linkPath)) {
        return undefined;
    }
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
        throw new Error(`Development release source ${slot} must be a symlink`);
    }
    const target = readlinkSync(linkPath);
    const expectedPrefix = "releases/";
    if (!target.startsWith(expectedPrefix)) {
        throw new Error(`Development release source ${slot} target is invalid`);
    }
    const commitSha = target.slice(expectedPrefix.length);
    if (
        target !== path.posix.join("releases", commitSha) ||
        !RELEASE_SHA_PATTERN.test(commitSha)
    ) {
        throw new Error(`Development release source ${slot} target is invalid`);
    }
    const realSourceRoot = realpathSync(sourceRoot);
    const releasePath = path.join(realSourceRoot, "releases", commitSha);
    if (!isRealDirectory(releasePath) || realpathSync(releasePath) !== releasePath) {
        throw new Error(`Development release ${commitSha} must be a real directory`);
    }
    return commitSha;
}

function didCopyDevelopmentReleases(sourceRoot: string, targetRoot: string): boolean {
    if (!isRealDirectory(sourceRoot)) {
        throw new Error(
            `MIRA_DASHBOARD_DEV_RELEASES_SOURCE must be a real directory: ${sourceRoot}`
        );
    }
    const currentCommit = releaseCommitForSlot(sourceRoot, "current");
    if (!currentCommit) {
        return false;
    }
    const previousCommit = releaseCommitForSlot(sourceRoot, "previous");
    const releaseDirectory = path.join(targetRoot, "releases");
    mkdirSync(releaseDirectory, { mode: 0o700, recursive: true });
    const copiedPaths: string[] = [];
    const commits = new Set(
        [currentCommit, previousCommit].filter((value): value is string => Boolean(value))
    );
    try {
        for (const commitSha of commits) {
            const sourcePath = path.join(sourceRoot, "releases", commitSha);
            const targetPath = path.join(releaseDirectory, commitSha);
            cpSync(sourcePath, targetPath, {
                errorOnExist: true,
                force: false,
                preserveTimestamps: true,
                recursive: true,
            });
            copiedPaths.push(targetPath);
        }
        symlinkSync(
            path.posix.join("releases", currentCommit),
            path.join(targetRoot, "current")
        );
        if (previousCommit) {
            symlinkSync(
                path.posix.join("releases", previousCommit),
                path.join(targetRoot, "previous")
            );
        }
    } catch (error) {
        rmSync(path.join(targetRoot, "current"), { force: true });
        rmSync(path.join(targetRoot, "previous"), { force: true });
        for (const copiedPath of copiedPaths) {
            rmSync(copiedPath, { force: true, recursive: true });
        }
        throw error;
    }
    return true;
}

function markerPath(config: DevelopmentStackConfig): string {
    return path.join(config.stateRoot, DEVELOPMENT_STATE_MARKER);
}

function expectedStateMarker(config: DevelopmentStackConfig): DevelopmentStateMarker {
    return {
        formatVersion: 1,
        owner: config.stateOwner,
    };
}

function readDevelopmentStateMarker(
    config: DevelopmentStackConfig
): DevelopmentStateMarker {
    let marker: Partial<DevelopmentStateMarker>;
    try {
        marker = JSON.parse(
            readFileSync(markerPath(config), "utf8")
        ) as Partial<DevelopmentStateMarker>;
    } catch {
        throw new Error(`Development state marker is invalid: ${markerPath(config)}`);
    }
    if (marker.formatVersion !== 1 || marker.owner !== config.stateOwner) {
        throw new Error(
            `Development state belongs to another checkout: ${config.stateRoot}`
        );
    }
    return marker as DevelopmentStateMarker;
}

function assertOrCreateStateOwnership(config: DevelopmentStackConfig): void {
    if (!existsSync(config.stateRoot)) {
        mkdirSync(config.stateRoot, { mode: 0o700, recursive: true });
    } else if (!isRealDirectory(config.stateRoot)) {
        throw new Error("Development state root must be a real directory");
    }
    chmodSync(config.stateRoot, 0o700);
    const configuredMarkerPath = markerPath(config);
    if (isRealRegularFile(configuredMarkerPath)) {
        readDevelopmentStateMarker(config);
        return;
    }
    if (isPathPresentNoFollow(configuredMarkerPath)) {
        throw new Error("Development state marker must be a real regular file");
    }
    if (readdirSync(config.stateRoot).length > 0) {
        throw new Error(
            `Refusing to claim non-empty unmarked development state: ${config.stateRoot}`
        );
    }
    writeFileSync(
        configuredMarkerPath,
        `${JSON.stringify(expectedStateMarker(config), undefined, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
    );
}

function developmentSecretEncryptionKey(config: DevelopmentStackConfig): string {
    if (!isPathPresentNoFollow(config.secretEncryptionKeyPath)) {
        writeFileSync(
            config.secretEncryptionKeyPath,
            `${randomBytes(SECRET_KEY_BYTES).toString("base64")}\n`,
            { encoding: "utf8", mode: 0o600 }
        );
    }
    if (!isRealRegularFile(config.secretEncryptionKeyPath)) {
        throw new Error("Development encryption key must be a real regular file");
    }
    chmodSync(config.secretEncryptionKeyPath, 0o600);
    const encodedKey = readFileSync(config.secretEncryptionKeyPath, "utf8").trim();
    let decodedKey: Buffer;
    try {
        decodedKey = Buffer.from(encodedKey, "base64");
    } catch {
        throw new Error("Development encryption key is not valid base64");
    }
    if (
        decodedKey.byteLength !== SECRET_KEY_BYTES ||
        decodedKey.toString("base64") !== encodedKey
    ) {
        throw new Error(
            `Development encryption key must encode ${SECRET_KEY_BYTES} bytes`
        );
    }
    return encodedKey;
}

/** Creates or reuses isolated, ignored development state. */
export function prepareDevelopmentState(
    config: DevelopmentStackConfig
): DevelopmentStateResult {
    assertOrCreateStateOwnership(config);
    mkdirSync(config.openClawClientHome, { mode: 0o700, recursive: true });
    mkdirSync(config.openClawHome, { mode: 0o700, recursive: true });
    mkdirSync(path.join(config.releaseRoot, "releases"), {
        mode: 0o700,
        recursive: true,
    });
    developmentSecretEncryptionKey(config);
    const workspace = prepareDevelopmentOpenClawSnapshot({
        configSource: config.openClawConfigSource,
        openClawHome: config.openClawHome,
        workspaceSource: config.workspaceSource,
    });

    let database: DevelopmentStateResult["database"];
    if (isPathPresentNoFollow(config.databasePath)) {
        if (!isRealRegularFile(config.databasePath)) {
            throw new Error("Development database must be a real regular file");
        }
        database = "reused";
    } else if (config.databaseSource) {
        createDevelopmentDatabaseSnapshot(
            config.databaseSource,
            config.databasePath,
            config.sourceWebAuthnRpId === config.rpId
        );
        database = "snapshot-created";
    } else {
        database = "created-empty";
    }

    let releases: DevelopmentStateResult["releases"];
    if (isPathPresentNoFollow(path.join(config.releaseRoot, "current"))) {
        releases = "reused";
    } else if (config.releaseSource) {
        releases = didCopyDevelopmentReleases(config.releaseSource, config.releaseRoot)
            ? "copied"
            : "empty";
    } else {
        releases = "empty";
    }
    return { database, releases, workspace };
}

/** Deletes only state carrying the exact development marker for this checkout. */
export function resetDevelopmentState(config: DevelopmentStackConfig): void {
    const configuredMarkerPath = markerPath(config);
    if (!isRealRegularFile(configuredMarkerPath)) {
        throw new Error(
            `Refusing to reset unmarked development state: ${config.stateRoot}`
        );
    }
    readDevelopmentStateMarker(config);
    rmSync(config.stateRoot, { force: true, recursive: true });
}

function inheritedChildEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of INHERITED_ENVIRONMENT_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

function developmentGatewayToken(
    config: DevelopmentStackConfig,
    environment: Record<string, string | undefined> = process.env
): string {
    let token: string | undefined;
    if (config.gatewayTokenFile) {
        if (!isRealRegularFile(config.gatewayTokenFile)) {
            throw new Error(
                `MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE must be a real regular file: ${config.gatewayTokenFile}`
            );
        }
        token = readFileSync(config.gatewayTokenFile, "utf8").trim();
    } else {
        token =
            environment.OPENCLAW_GATEWAY_TOKEN?.trim() ||
            environment.OPENCLAW_TOKEN?.trim();
    }
    if (!token || token.length > 16_384 || /[\r\n\0]/u.test(token)) {
        throw new Error(
            "Dashboard dev requires OPENCLAW_GATEWAY_TOKEN or MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE"
        );
    }
    return token;
}

/** Produces the explicit, secret-minimized backend development environment. */
export function developmentBackendEnvironment(
    config: DevelopmentStackConfig
): Record<string, string> {
    const gatewayToken = developmentGatewayToken(config);
    return {
        ...inheritedChildEnvironment(),
        BUN_BINARY: process.execPath,
        HOME: config.openClawHome,
        MIRA_DASHBOARD_ALLOWED_ORIGINS: config.publicOrigin,
        MIRA_DASHBOARD_COOKIE_NAMESPACE: `mira_dashboard_dev_${config.frontendPort}`,
        MIRA_DASHBOARD_DB_PATH: config.databasePath,
        MIRA_DASHBOARD_DEV_SAFE_MODE: "1",
        MIRA_DASHBOARD_DISABLE_SCHEDULER: "0",
        MIRA_DASHBOARD_EXECUTION_ROLE: "combined",
        MIRA_DASHBOARD_FRONTEND_PATH: config.repositoryRoot,
        MIRA_DASHBOARD_HOST: config.backendHost,
        MIRA_DASHBOARD_JOB_PROFILE: "isolated",
        MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE: path.join(
            config.stateRoot,
            "log-rotation.lock"
        ),
        MIRA_DASHBOARD_LOGS_ROOT: developmentLogsRoot(config),
        MIRA_DASHBOARD_METRICS_DISK_PATH: config.repositoryRoot,
        MIRA_DASHBOARD_OPENCLAW_HOME: config.openClawClientHome,
        MIRA_DASHBOARD_RELEASE_ROOT: config.repositoryRoot,
        MIRA_DASHBOARD_RELEASES_ROOT: config.releaseRoot,
        MIRA_DASHBOARD_ROOT: config.repositoryRoot,
        MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY: developmentSecretEncryptionKey(config),
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS: config.publicOrigin,
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: config.rpId,
        MIRA_DASHBOARD_WORKTREE_ROOT: path.dirname(config.repositoryRoot),
        NODE_ENV: "development",
        OPENCLAW_HOME: config.openClawHome,
        PORT: String(config.backendPort),
        OPENCLAW_GATEWAY_URL: config.gatewayUrl,
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    };
}

function frontendEnvironment(config: DevelopmentStackConfig): Record<string, string> {
    return {
        ...inheritedChildEnvironment(),
        DASHBOARD_API_TARGET: config.apiTarget,
        HOST: config.frontendHost,
        MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE: `mira_dashboard_dev_${config.frontendPort}`,
        PORT: String(config.frontendPort),
    };
}

type DevelopmentChild = ReturnType<typeof Bun.spawn>;

async function developmentChildExit(
    child: DevelopmentChild,
    processName: "backend" | "frontend"
): Promise<{ code: number; process: "backend" | "frontend" }> {
    return { code: await child.exited, process: processName };
}

function stopChild(child: DevelopmentChild): void {
    if (child.exitCode === null) {
        child.kill("SIGTERM");
    }
}

/** Starts watched frontend/backend children and keeps their lifecycle coupled. */
export async function runDevelopmentStack(
    config: DevelopmentStackConfig
): Promise<number> {
    const state = prepareDevelopmentState(config);
    prepareDevelopmentLog(config);
    const bun = Bun.which("bun") || process.execPath;
    const backend = Bun.spawn([bun, "--watch", "src/serverStart.ts"], {
        cwd: path.join(config.repositoryRoot, "backend"),
        env: developmentBackendEnvironment(config),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
    });
    const frontend = Bun.spawn([bun, "--watch", "scripts/developmentFrontend.ts"], {
        cwd: config.repositoryRoot,
        env: frontendEnvironment(config),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
    });
    let developmentLogFixtureIndex = 0;
    const developmentLogFixtureTimer = setInterval(() => {
        try {
            const entry =
                DEVELOPMENT_LOG_FIXTURES[
                    developmentLogFixtureIndex % DEVELOPMENT_LOG_FIXTURES.length
                ]!;
            developmentLogFixtureIndex += 1;
            appendDevelopmentLogEntry(config, entry);
        } catch (error) {
            console.error("[DevelopmentLogs] Failed to append fixture entry:", error);
        }
    }, DEVELOPMENT_LOG_FIXTURE_INTERVAL_MS);
    let isStopRequested = false;
    let isChildrenStopping = false;
    const stopChildren = () => {
        if (isChildrenStopping) return;
        isChildrenStopping = true;
        stopChild(frontend);
        stopChild(backend);
    };
    const handleSignal = () => {
        isStopRequested = true;
        stopChildren();
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);

    console.log(
        [
            `Mira Dashboard development stack: ${config.publicOrigin}`,
            `Frontend HMR: ${config.frontendHost}:${config.frontendPort}`,
            `Backend HMR: ${config.backendHost}:${config.backendPort}`,
            `State: ${config.stateRoot} (database ${state.database}, workspace ${state.workspace}, releases ${state.releases})`,
            `Gateway: ${config.gatewayUrl}`,
            "Isolated scheduler/worker enabled.",
            "Host-control and backup jobs are disabled.",
        ].join("\n")
    );

    const childExits = [
        developmentChildExit(backend, "backend"),
        developmentChildExit(frontend, "frontend"),
    ];
    const exited = await Promise.race(childExits);
    clearInterval(developmentLogFixtureTimer);
    stopChildren();
    await Promise.allSettled([backend.exited, frontend.exited]);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (isStopRequested) {
        return 0;
    }
    console.error(`Development ${exited.process} exited with code ${exited.code}`);
    return exited.code || 1;
}
