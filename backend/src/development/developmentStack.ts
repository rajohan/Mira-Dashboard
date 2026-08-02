import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    cpSync,
    existsSync,
    fchmodSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { formatOpenClawLogDate } from "../lib/logRoots.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { hasLineBreakOrNullByte } from "../lib/values.ts";
import {
    type DevelopmentWorkspaceState,
    prepareDevelopmentOpenClawSnapshot,
} from "./developmentOpenClaw.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";

export {
    type DevelopmentStackConfig,
    resolveDevelopmentStackConfig,
} from "./developmentStackConfig.ts";

const DEVELOPMENT_STATE_MARKER = ".mira-dashboard-development-state.json";
const RELEASE_SHA_PATTERN = /^[\da-f]{40}$/u;
const HOST_OPENCLAW_LOGS_ROOT = "/tmp/openclaw";
const SECRET_KEY_BYTES = 32;
const DEVELOPMENT_LOG_FIXTURE_INTERVAL_MS = 5000;
const logger = createStructuredLogger("development-stack");
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
export interface DevelopmentStateResult {
    database: "created-empty" | "reused" | "snapshot-created";
    releases: "copied" | "empty" | "reused";
    workspace: DevelopmentWorkspaceState;
}

function developmentLogsRoot(config: DevelopmentStackConfig): string {
    return path.join(config.stateRoot, "logs");
}

function developmentAppLogPath(config: DevelopmentStackConfig): string {
    return path.join(developmentLogsRoot(config), "dashboard.ndjson");
}

function syntheticDevelopmentOpenClawLogsRoot(config: DevelopmentStackConfig): string {
    return path.join(developmentLogsRoot(config), "openclaw");
}

function developmentOpenClawLogsRoot(config: DevelopmentStackConfig): string {
    return config.openClawLogMode === "host-read-only"
        ? HOST_OPENCLAW_LOGS_ROOT
        : syntheticDevelopmentOpenClawLogsRoot(config);
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
        syntheticDevelopmentOpenClawLogsRoot(config),
        `openclaw-${formatOpenClawLogDate(timestamp)}.log`
    );
}

function appendDevelopmentLogEntry(
    config: DevelopmentStackConfig,
    entry: DevelopmentLogFixtureEntry,
    timestamp = new Date()
): void {
    const logPath = developmentLogPath(config, timestamp);
    const line = `${JSON.stringify({
        0: entry.message,
        _meta: {
            date: timestamp.toISOString(),
            logLevelName: entry.level,
        },
    })}\n`;
    const descriptor = openSync(
        logPath,
        constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW,
        0o600
    );
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error("Development log must be a single-link regular file");
        }
        fchmodSync(descriptor, 0o600);
        if (
            stat.size >= MAX_DEVELOPMENT_LOG_BYTES ||
            stat.size + Buffer.byteLength(line, "utf8") > MAX_DEVELOPMENT_LOG_BYTES
        ) {
            return;
        }
        writeFileSync(descriptor, line, "utf8");
    } finally {
        closeSync(descriptor);
    }
}

function developmentLogFileSize(logPath: string): number | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(
            logPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error("Development log must be a single-link regular file");
        }
        return stat.size;
    } finally {
        closeSync(descriptor);
    }
}

function seedDevelopmentOpenClawLog(
    config: DevelopmentStackConfig,
    timestamp: Date
): void {
    const logPath = developmentLogPath(config, timestamp);
    const existingLogSize = developmentLogFileSize(logPath);
    if (existingLogSize !== undefined && existingLogSize >= 1024) return;
    for (let index = 0; index < 24; index += 1) {
        appendDevelopmentLogEntry(
            config,
            DEVELOPMENT_LOG_FIXTURES[index % DEVELOPMENT_LOG_FIXTURES.length]!,
            new Date(timestamp.getTime() - (24 - index) * 1000)
        );
    }
}

function prepareDevelopmentLog(config: DevelopmentStackConfig): void {
    const logsRoot = developmentLogsRoot(config);
    ensurePrivateStateDirectory(config, logsRoot);
    if (config.openClawLogMode === "host-read-only") {
        if (!isRealDirectory(HOST_OPENCLAW_LOGS_ROOT)) {
            throw new Error(
                `OpenClaw host logs must be a real directory: ${HOST_OPENCLAW_LOGS_ROOT}`
            );
        }
        return;
    }
    ensurePrivateStateDirectory(config, syntheticDevelopmentOpenClawLogsRoot(config));
    const timestamp = new Date();
    seedDevelopmentOpenClawLog(config, timestamp);
    seedDevelopmentOpenClawLog(
        config,
        new Date(timestamp.getTime() - 24 * 60 * 60 * 1000)
    );
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

function ensurePrivateStateDirectory(
    config: DevelopmentStackConfig,
    directoryPath: string
): void {
    const stateRoot = path.resolve(config.stateRoot);
    const target = path.resolve(directoryPath);
    const relativePath = path.relative(stateRoot, target);
    if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(`Development directory must remain inside state: ${target}`);
    }
    if (!isRealDirectory(stateRoot)) {
        throw new Error("Development state root must be a real directory");
    }
    chmodSync(stateRoot, 0o700);

    const pathSegments = relativePath.split(path.sep).filter(Boolean);
    let current = stateRoot;
    for (const segment of pathSegments) {
        current = path.join(current, segment);
        if (!isPathPresentNoFollow(current)) {
            mkdirSync(current, { mode: 0o700 });
        }
        if (!isRealDirectory(current)) {
            throw new Error(
                `Development state path must be a real directory: ${current}`
            );
        }
        chmodSync(current, 0o700);
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
        runIfTableExists(
            database,
            "deployment_jobs",
            "DELETE FROM deployment_jobs WHERE status NOT IN ('isOk', 'failed')"
        );
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
            | Record<string, unknown>
            | undefined;
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
    if (!isRealDirectory(targetRoot) || !isRealDirectory(releaseDirectory)) {
        throw new Error("Development release target must use real directories");
    }
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

/**
 * Creates or reuses isolated, ignored development state.
 * @returns Created or reuses isolated, ignored development state.
 */
export function prepareDevelopmentState(
    config: DevelopmentStackConfig
): DevelopmentStateResult {
    assertOrCreateStateOwnership(config);
    ensurePrivateStateDirectory(config, config.openClawClientHome);
    ensurePrivateStateDirectory(config, config.openClawHome);
    ensurePrivateStateDirectory(config, config.releaseRoot);
    ensurePrivateStateDirectory(config, path.join(config.releaseRoot, "releases"));
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
        if (config.sourceWebAuthnRpId !== config.rpId) {
            scrubDevelopmentDatabase(config.databasePath, false);
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
    const currentRelease = releaseCommitForSlot(config.releaseRoot, "current");
    const previousRelease = releaseCommitForSlot(config.releaseRoot, "previous");
    if (currentRelease) {
        releases = "reused";
    } else if (previousRelease) {
        throw new Error("Development release previous slot requires a current slot");
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
        token = environment.OPENCLAW_GATEWAY_TOKEN?.trim();
    }
    if (!token || token.length > 16_384 || hasLineBreakOrNullByte(token)) {
        throw new Error(
            "Dashboard dev requires OPENCLAW_GATEWAY_TOKEN or MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE"
        );
    }
    return token;
}

/**
 * Produces the explicit, secret-minimized backend development environment.
 * @returns Development backend environment result.
 */
export function developmentBackendEnvironment(
    config: DevelopmentStackConfig
): Record<string, string> {
    const gatewayToken = developmentGatewayToken(config);
    return {
        ...inheritedChildEnvironment(),
        HOME: config.openClawHome,
        MIRA_DASHBOARD_ALLOWED_ORIGINS: config.publicOrigin,
        MIRA_DASHBOARD_APPLICATION_LOG_PATH: developmentAppLogPath(config),
        MIRA_DASHBOARD_DB_PATH: config.databasePath,
        MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE: `mira_dashboard_dev_${config.frontendPort}`,
        MIRA_DASHBOARD_DEV_SAFE_MODE: "1",
        MIRA_DASHBOARD_FRONTEND_PATH: path.join(config.repositoryRoot, "frontend"),
        MIRA_DASHBOARD_HOST: config.backendHost,
        MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE: path.join(
            config.stateRoot,
            "log-rotation.lock"
        ),
        MIRA_DASHBOARD_LOGS_ROOT: developmentOpenClawLogsRoot(config),
        MIRA_DASHBOARD_OPENCLAW_HOME: config.openClawClientHome,
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
        MIRA_DASHBOARD_DEV_HOT_RELOAD: config.hotReload ? "1" : "0",
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: config.publicOrigin,
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

/**
 * Starts frontend/backend children and keeps their lifecycle coupled.
 * @returns Promise resolving to the run development stack result.
 */
export async function runDevelopmentStack(
    config: DevelopmentStackConfig
): Promise<number> {
    const state = prepareDevelopmentState(config);
    prepareDevelopmentLog(config);
    const bun = Bun.which("bun") || process.execPath;
    const watchArguments = config.hotReload ? ["--watch"] : [];
    const backend = Bun.spawn([bun, ...watchArguments, "src/serverStart.ts"], {
        cwd: path.join(config.repositoryRoot, "backend"),
        env: developmentBackendEnvironment(config),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
    });
    const frontend = Bun.spawn(
        [bun, ...watchArguments, "scripts/developmentFrontend.ts"],
        {
            cwd: config.repositoryRoot,
            env: frontendEnvironment(config),
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
        }
    );
    let developmentLogFixtureIndex = 0;
    const developmentLogFixtureTimer =
        config.openClawLogMode === "host-read-only"
            ? undefined
            : setInterval(() => {
                  try {
                      const entry =
                          DEVELOPMENT_LOG_FIXTURES[
                              developmentLogFixtureIndex % DEVELOPMENT_LOG_FIXTURES.length
                          ]!;
                      developmentLogFixtureIndex += 1;
                      appendDevelopmentLogEntry(config, entry);
                  } catch (error) {
                      logger.error("development.log_fixture_append_failed", { error });
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

    logger.info("development.started", {
        backendHost: config.backendHost,
        backendPort: config.backendPort,
        frontendHost: config.frontendHost,
        frontendPort: config.frontendPort,
        gatewayUrl: config.gatewayUrl,
        hotReload: config.hotReload,
        logs: {
            application: "development-file",
            openClaw: config.openClawLogMode,
        },
        publicOrigin: config.publicOrigin,
        state: {
            database: state.database,
            releases: state.releases,
            root: config.stateRoot,
            workspace: state.workspace,
        },
        workerEnabled: true,
    });

    const childExits = [
        developmentChildExit(backend, "backend"),
        developmentChildExit(frontend, "frontend"),
    ];
    const exited = await Promise.race(childExits);
    if (developmentLogFixtureTimer) {
        clearInterval(developmentLogFixtureTimer);
    }
    stopChildren();
    await Promise.allSettled([backend.exited, frontend.exited]);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (isStopRequested) {
        return 0;
    }
    logger.error("development.process_exited", {
        exitCode: exited.code,
        process: exited.process,
    });
    return exited.code || 1;
}
