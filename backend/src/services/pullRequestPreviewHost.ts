import { randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { getPersistedGatewayToken } from "../auth.ts";
import {
    prepareDevelopmentState,
    resolveDevelopmentStackConfig,
} from "../development/developmentStack.ts";
import { resolveDashboardProjectPaths } from "../lib/dashboardPaths.ts";
import { errorMessage } from "../lib/errors.ts";
import { runProcess } from "../lib/processes.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "./pullRequestPreviewPolicy.ts";

const PREVIEW_UNIT = "mira-dashboard-pr-preview.service";
const PREVIEW_GATEWAY_PROXY_UNIT = "mira-dashboard-pr-preview-gateway.service";
const PREVIEW_RECORD_FILE = "active-preview.json";
const PREVIEW_RECORD_FORMAT_VERSION = 1;
const PREVIEW_READY_TIMEOUT_MS = 90_000;
const PREVIEW_READY_POLL_MS = 500;
const MAX_COMMAND_BUFFER = 10 * 1024 * 1024;
const MAX_PREVIEW_RECORD_BYTES = 256 * 1024;
const COMMIT_PATTERN = /^[\da-f]{40}$/u;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_GATEWAY_PROXY_PORT = 18_790;
const DEFAULT_PREVIEW_BACKEND_PORT = 3101;
const DEFAULT_PREVIEW_FRONTEND_PORT = 5173;
const MANAGED_STATE_DIRECTORY_PATTERN = /^pr-([1-9]\d*)$/u;
const PREVIEW_REFERENCE = "refs/mira-dashboard/previews/active";
const PREVIEW_GATEWAY_PROXY_ENTRYPOINT = "pullRequestPreviewGatewayProxy.js";
const PREVIEW_GATEWAY_PROXY_READY_TIMEOUT_MS = 45_000;
const PREVIEW_GATEWAY_PROXY_READY_POLL_MS = 250;
const PREVIEW_START_RECONCILIATION_GRACE_MS =
    PREVIEW_GATEWAY_PROXY_READY_TIMEOUT_MS + 30_000;
const PREVIEW_STOP_RECONCILIATION_GRACE_MS = 60_000;
const MAX_GATEWAY_TOKEN_BYTES = 16 * 1024;
const SAFE_INSTALL_ENVIRONMENT_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "TZ",
] as const;

export type PullRequestPreviewLifecycle =
    "failed" | "running" | "starting" | "stopped" | "stopping";

export interface PullRequestPreviewStatus {
    backendPort?: number;
    commitSha?: string;
    controlsAvailable?: boolean;
    frontendPort?: number;
    message?: string;
    number?: number;
    startedAt?: string;
    status: PullRequestPreviewLifecycle;
    title?: string;
    updatedAt?: string;
    url?: string;
}

export interface PullRequestPreviewCandidate {
    authorLogin?: string;
    baseRefName: string;
    commitSha: string;
    number: number;
    title: string;
}

export interface PullRequestPreviewCleanupResult {
    message: string;
    number: number;
    status: "removed" | "skipped" | "warning";
}

export interface PullRequestPreviewConfig {
    allowedAuthors: ReadonlySet<string>;
    backendPort: number;
    bunExecutable: string;
    dashboardRoot: string;
    databaseTemplate?: string;
    frontendPort: number;
    gatewayProxyEntrypoint: string;
    gatewayProxyIdentityFile: string;
    gatewayProxyPort: number;
    gatewayProxyUnitName: string;
    gatewayTokenFile: string;
    gatewayUpstreamTokenFile: string;
    gatewayUrl: string;
    gitCommonDirectory: string;
    managedWorktreePath: string;
    openClawConfigSource?: string;
    previewRoot: string;
    projectRoot: string;
    recentAuthMinutes?: string;
    releaseSource?: string;
    sessionIdleMinutes?: string;
    sourceWebAuthnRpId?: string;
    stateFile: string;
    unitName: string;
    workspaceSource?: string;
}

interface PullRequestPreviewRecord {
    backendPort: number;
    commitSha: string;
    formatVersion: 1;
    frontendPort: number;
    message?: string;
    number: number;
    ownsTailscaleServe: boolean;
    startedAt?: string;
    status: PullRequestPreviewLifecycle;
    title: string;
    updatedAt: string;
    url: string;
    worktreePath: string;
}

interface SystemdUnitState {
    activeState?: string;
    result?: string;
    subState?: string;
}

interface TailscaleStatus {
    Self?: {
        DNSName?: string;
    };
}

interface TailscaleServeStatus {
    TCP?: Record<string, { HTTPS?: boolean }>;
    Web?: Record<
        string,
        {
            Handlers?: Record<string, { Proxy?: string }>;
        }
    >;
}

interface PreviewTailscaleRoute {
    enabled: boolean;
    url: string;
}

interface CommandOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    timeoutMs?: number;
}

function absoluteNonRootPath(name: string, value: string): string {
    if (!path.isAbsolute(value)) {
        throw new TypeError(`${name} must be an absolute non-root path`);
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must be an absolute non-root path`);
    }
    return resolved;
}

function configuredGatewayUrl(value: string | undefined): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    let url: URL;
    try {
        url = new URL(configured);
    } catch {
        throw new TypeError("OPENCLAW_GATEWAY_URL must be a valid URL");
    }
    if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
    ) {
        throw new TypeError(
            "OPENCLAW_GATEWAY_URL must be ws:// or wss:// without credentials or a fragment"
        );
    }
    return url.href;
}

function optionalEnvironmentValue(
    name: string,
    value: string | undefined
): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    if (/[\r\n\0]/u.test(configured)) {
        throw new TypeError(`${name} must be a single environment value`);
    }
    return configured;
}

function defaultGatewayProxyEntrypoint(): string {
    const runtimeEntrypoint = process.argv[1];
    if (runtimeEntrypoint && path.isAbsolute(runtimeEntrypoint)) {
        const builtEntrypoint = path.join(
            path.dirname(runtimeEntrypoint),
            PREVIEW_GATEWAY_PROXY_ENTRYPOINT
        );
        if (isRealRegularFile(builtEntrypoint)) {
            return builtEntrypoint;
        }
    }
    return path.resolve(import.meta.dirname, "..", "pullRequestPreviewGatewayProxy.ts");
}

/** Resolves the single-slot managed PR preview host contract. */
export function resolvePullRequestPreviewConfig(
    environment: Record<string, string | undefined> = process.env
): PullRequestPreviewConfig {
    const projectPaths = resolveDashboardProjectPaths(environment);
    const dashboardRoot = projectPaths.productionCheckoutRoot;
    const previewRoot = projectPaths.developmentPreviewStateRoot;
    const managedWorktreePath = projectPaths.developmentPreviewRoot;
    const openClawSourceRoot = absoluteNonRootPath(
        "OPENCLAW_HOME",
        environment.OPENCLAW_HOME?.trim() ||
            path.join(environment.HOME?.trim() || os.homedir(), ".openclaw")
    );
    const allowedAuthors = resolvePullRequestPreviewAllowedAuthors();
    return {
        allowedAuthors,
        backendPort: DEFAULT_PREVIEW_BACKEND_PORT,
        bunExecutable: absoluteNonRootPath("Bun executable", process.execPath),
        dashboardRoot,
        databaseTemplate: projectPaths.productionDatabasePath,
        frontendPort: DEFAULT_PREVIEW_FRONTEND_PORT,
        gatewayProxyEntrypoint: defaultGatewayProxyEntrypoint(),
        gatewayProxyIdentityFile: path.join(previewRoot, "gateway-proxy-identity.json"),
        gatewayProxyPort: DEFAULT_GATEWAY_PROXY_PORT,
        gatewayProxyUnitName: PREVIEW_GATEWAY_PROXY_UNIT,
        gatewayTokenFile: path.join(previewRoot, "gateway.token"),
        gatewayUpstreamTokenFile: path.join(previewRoot, "gateway-upstream.token"),
        gatewayUrl:
            configuredGatewayUrl(environment.OPENCLAW_GATEWAY_URL) || DEFAULT_GATEWAY_URL,
        gitCommonDirectory: path.join(dashboardRoot, ".git"),
        managedWorktreePath,
        openClawConfigSource: path.join(openClawSourceRoot, "openclaw.json"),
        previewRoot,
        projectRoot: projectPaths.projectRoot,
        recentAuthMinutes: optionalEnvironmentValue(
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            environment.MIRA_DASHBOARD_RECENT_AUTH_MINUTES
        ),
        releaseSource: projectPaths.productionReleasesRoot,
        sessionIdleMinutes: optionalEnvironmentValue(
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            environment.MIRA_DASHBOARD_SESSION_IDLE_MINUTES
        ),
        sourceWebAuthnRpId: optionalEnvironmentValue(
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID
        ),
        stateFile: path.join(previewRoot, PREVIEW_RECORD_FILE),
        unitName: PREVIEW_UNIT,
        workspaceSource: path.join(openClawSourceRoot, "workspace"),
    };
}

function isRealDirectory(directoryPath: string): boolean {
    try {
        const stat = lstatSync(directoryPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function isRealRegularFile(filePath: string): boolean {
    try {
        const stat = lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function ensurePrivateSingleLinkFile(filePath: string, label: string): void {
    if (!existsSync(filePath)) return;
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`${label} must be a single-link real regular file`);
    }
    chmodSync(filePath, 0o600);
}

function ensureRealDirectory(directoryPath: string): void {
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    if (!isRealDirectory(directoryPath)) {
        throw new Error(`Preview path must be a real directory: ${directoryPath}`);
    }
    chmodSync(directoryPath, 0o700);
}

function ensureRealDirectoryPreservingExistingMode(directoryPath: string): void {
    const didExist = existsSync(directoryPath);
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    if (!isRealDirectory(directoryPath)) {
        throw new Error(`Preview path must be a real directory: ${directoryPath}`);
    }
    if (!didExist) chmodSync(directoryPath, 0o700);
}

function materializeGatewayTokenFile(
    filePath: string,
    tokenValue: string | undefined,
    label: string
): void {
    const token = tokenValue?.trim();
    if (
        !token ||
        Buffer.byteLength(token) > MAX_GATEWAY_TOKEN_BYTES ||
        /[\r\n\0]/u.test(token)
    ) {
        throw new Error(`${label} must be a valid single-line token`);
    }
    const tokenDirectory = path.dirname(filePath);
    ensureRealDirectory(tokenDirectory);
    if (existsSync(filePath) && !isRealRegularFile(filePath)) {
        throw new Error(`${label} path must be a real regular file`);
    }
    const temporaryPath = path.join(
        tokenDirectory,
        `.gateway-token-${Bun.randomUUIDv7()}.tmp`
    );
    try {
        writeFileSync(temporaryPath, `${token}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporaryPath, filePath);
        chmodSync(filePath, 0o600);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

function materializeGatewayCredentials(
    config: PullRequestPreviewConfig,
    upstreamToken: string | undefined
): void {
    if (
        path.resolve(config.gatewayTokenFile) ===
        path.resolve(config.gatewayUpstreamTokenFile)
    ) {
        throw new Error("PR dev client and upstream Gateway token paths must differ");
    }
    materializeGatewayTokenFile(
        config.gatewayUpstreamTokenFile,
        upstreamToken,
        "Persisted Gateway token"
    );
    materializeGatewayTokenFile(
        config.gatewayTokenFile,
        randomBytes(32).toString("base64url"),
        "PR dev Gateway proxy token"
    );
}

function isPathStrictlyWithin(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function previewRecordFromJson(value: unknown): PullRequestPreviewRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Preview record must be an object");
    }
    const record = value as Partial<PullRequestPreviewRecord>;
    if (
        record.formatVersion !== PREVIEW_RECORD_FORMAT_VERSION ||
        typeof record.number !== "number" ||
        !Number.isSafeInteger(record.number) ||
        record.number <= 0 ||
        typeof record.commitSha !== "string" ||
        !COMMIT_PATTERN.test(record.commitSha) ||
        typeof record.title !== "string" ||
        typeof record.updatedAt !== "string" ||
        typeof record.url !== "string" ||
        typeof record.worktreePath !== "string" ||
        !["failed", "running", "starting", "stopped", "stopping"].includes(
            record.status || ""
        ) ||
        (record.ownsTailscaleServe !== undefined &&
            typeof record.ownsTailscaleServe !== "boolean") ||
        typeof record.frontendPort !== "number" ||
        typeof record.backendPort !== "number"
    ) {
        throw new TypeError("Preview record is invalid");
    }
    return {
        ...record,
        ownsTailscaleServe: record.ownsTailscaleServe === true,
    } as PullRequestPreviewRecord;
}

function readPreviewRecord(
    config: PullRequestPreviewConfig
): PullRequestPreviewRecord | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(
            config.stateFile,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Dashboard preview state must be a readable real regular file", {
            cause: error,
        });
    }

    let content: string;
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) {
            throw new Error(
                "Dashboard preview state must be a readable real regular file"
            );
        }
        if (stat.size > MAX_PREVIEW_RECORD_BYTES) {
            throw new Error("Dashboard preview state is too large");
        }
        const buffer = Buffer.allocUnsafe(MAX_PREVIEW_RECORD_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const chunkLength = readSync(
                descriptor,
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead
            );
            if (chunkLength === 0) break;
            bytesRead += chunkLength;
        }
        if (bytesRead > MAX_PREVIEW_RECORD_BYTES) {
            throw new Error("Dashboard preview state is too large");
        }
        content = buffer.toString("utf8", 0, bytesRead);
    } finally {
        closeSync(descriptor);
    }

    try {
        return previewRecordFromJson(JSON.parse(content) as unknown);
    } catch (error) {
        const quarantinePath = path.join(
            config.previewRoot,
            `active-preview.corrupt-${Date.now()}-${Bun.randomUUIDv7()}.json`
        );
        try {
            renameSync(config.stateFile, quarantinePath);
            chmodSync(quarantinePath, 0o600);
            console.error(
                `[PullRequestPreview] Quarantined invalid state at ${quarantinePath}: ${errorMessage(error, "invalid state")}`
            );
        } catch (quarantineError) {
            console.error(
                `[PullRequestPreview] Invalid state could not be quarantined: ${errorMessage(error, "invalid state")}. ${errorMessage(quarantineError, "quarantine failed")}`
            );
        }
        return undefined;
    }
}

function writePreviewRecord(
    config: PullRequestPreviewConfig,
    record: PullRequestPreviewRecord
): void {
    ensureRealDirectory(config.previewRoot);
    const temporaryPath = path.join(
        config.previewRoot,
        `.${PREVIEW_RECORD_FILE}.${Bun.randomUUIDv7()}.tmp`
    );
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(record, undefined, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporaryPath, config.stateFile);
        chmodSync(config.stateFile, 0o600);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

async function runCommand(
    executable: string,
    arguments_: string[],
    options: CommandOptions = {}
): Promise<{ stderr: string; stdout: string }> {
    const result = await runProcess(executable, arguments_, {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: MAX_COMMAND_BUFFER,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 120_000,
    });
    if (result.code !== 0) {
        throw new Error(
            `${path.basename(executable)} exited ${result.code}: ${
                result.stderr.trim() || result.stdout.trim()
            }`
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

async function runJsonCommand<T>(
    executable: string,
    arguments_: string[],
    options: CommandOptions = {}
): Promise<T> {
    const { stdout } = await runCommand(executable, arguments_, options);
    try {
        return JSON.parse(stdout) as T;
    } catch {
        throw new Error(`${path.basename(executable)} returned invalid JSON`);
    }
}

function safeInstallEnvironment(
    config: PullRequestPreviewConfig
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of SAFE_INSTALL_ENVIRONMENT_KEYS) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
    }
    const installerHome = path.join(config.previewRoot, "installer-home");
    const cacheDirectory = path.join(config.previewRoot, "bun-cache");
    ensureRealDirectory(installerHome);
    ensureRealDirectory(cacheDirectory);
    environment.BUN_INSTALL_CACHE_DIR = cacheDirectory;
    environment.HOME = installerHome;
    environment.MIRA_DASHBOARD_PROJECT_ROOT = config.projectRoot;
    return environment;
}

function githubCommandEnvironment(): Record<string, string | undefined> {
    const environment = { ...process.env };
    const githubToken =
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim();
    for (const key of Object.keys(environment)) {
        if (
            key === "MIRA_GITHUB_TOKEN" ||
            key === "RAJOHAN_GITHUB_TOKEN" ||
            key.startsWith("MIRA_GITHUB_TOKEN_") ||
            key.startsWith("RAJOHAN_GITHUB_TOKEN_")
        ) {
            delete environment[key];
        }
    }
    delete environment.GITHUB_TOKEN;
    if (githubToken) {
        environment.GH_TOKEN = githubToken;
    } else {
        delete environment.GH_TOKEN;
    }
    return environment;
}

function previewWorktreePath(config: PullRequestPreviewConfig): string {
    return config.managedWorktreePath;
}

async function unregisterMissingPreviewWorktree(
    config: PullRequestPreviewConfig,
    worktreePath: string,
    signal?: AbortSignal
): Promise<boolean> {
    const resolvedWorktreePath = path.resolve(worktreePath);
    const { stdout } = await runCommand(
        "git",
        ["-C", config.dashboardRoot, "worktree", "list", "--porcelain"],
        { signal, timeoutMs: 30_000 }
    );
    const isRegistered = stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("worktree "))
        .some(
            (line) =>
                path.resolve(line.slice("worktree ".length)) === resolvedWorktreePath
        );
    if (!isRegistered) return false;
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "worktree",
            "remove",
            "--force",
            "--force",
            resolvedWorktreePath,
        ],
        { signal, timeoutMs: 120_000 }
    );
    return true;
}

async function removePreviewWorktree(
    config: PullRequestPreviewConfig,
    worktreePath: string,
    signal?: AbortSignal
): Promise<boolean> {
    const resolvedWorktreePath = path.resolve(worktreePath);
    if (resolvedWorktreePath !== path.resolve(config.managedWorktreePath)) {
        throw new Error("Refusing to remove an unmanaged preview worktree");
    }
    if (!existsSync(resolvedWorktreePath)) {
        return unregisterMissingPreviewWorktree(config, resolvedWorktreePath, signal);
    }
    if (!isRealDirectory(resolvedWorktreePath)) {
        throw new Error("Preview worktree path must be a real directory");
    }
    const { stdout: registeredRoot } = await runCommand(
        "git",
        ["-C", resolvedWorktreePath, "rev-parse", "--show-toplevel"],
        { signal }
    );
    if (realpathSync(registeredRoot.trim()) !== realpathSync(resolvedWorktreePath)) {
        throw new Error("Preview path is not the expected registered worktree");
    }
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "worktree",
            "remove",
            "--force",
            resolvedWorktreePath,
        ],
        { signal, timeoutMs: 120_000 }
    );
    if (existsSync(resolvedWorktreePath)) {
        throw new Error("Git did not remove the managed preview worktree");
    }
    return true;
}

async function ensurePreviewWorktree(
    config: PullRequestPreviewConfig,
    number: number,
    commitSha: string,
    signal?: AbortSignal
): Promise<string> {
    ensureRealDirectoryPreservingExistingMode(path.dirname(config.managedWorktreePath));
    const worktreePath = previewWorktreePath(config);
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "fetch",
            "--force",
            "--no-tags",
            "origin",
            `pull/${number}/head:${PREVIEW_REFERENCE}`,
        ],
        {
            env: githubCommandEnvironment(),
            signal,
            timeoutMs: 180_000,
        }
    );
    const { stdout: fetchedCommit } = await runCommand(
        "git",
        ["-C", config.dashboardRoot, "rev-parse", PREVIEW_REFERENCE],
        { env: githubCommandEnvironment(), signal }
    );
    if (fetchedCommit.trim() !== commitSha) {
        throw new Error("Fetched pull request commit changed during preview startup");
    }
    if (existsSync(worktreePath)) {
        if (!isRealDirectory(worktreePath)) {
            throw new Error("Preview worktree path must be a real directory");
        }
        const { stdout: registeredRoot } = await runCommand(
            "git",
            ["-C", worktreePath, "rev-parse", "--show-toplevel"],
            { signal }
        );
        if (realpathSync(registeredRoot.trim()) !== realpathSync(worktreePath)) {
            throw new Error("Preview path is not the expected registered worktree");
        }
        const { stdout: status } = await runCommand(
            "git",
            ["-C", worktreePath, "status", "--porcelain", "--untracked-files=no"],
            { signal }
        );
        if (status.trim()) {
            throw Object.assign(
                new Error("Managed preview worktree has tracked local changes"),
                { statusCode: 409 }
            );
        }
        await runCommand("git", ["-C", worktreePath, "checkout", "--detach", commitSha], {
            signal,
        });
    } else {
        await unregisterMissingPreviewWorktree(config, worktreePath, signal);
        await runCommand(
            "git",
            [
                "-C",
                config.dashboardRoot,
                "worktree",
                "add",
                "--detach",
                worktreePath,
                commitSha,
            ],
            { signal, timeoutMs: 180_000 }
        );
    }
    const { stdout: checkedOutCommit } = await runCommand(
        "git",
        ["-C", worktreePath, "rev-parse", "HEAD"],
        { signal }
    );
    if (checkedOutCommit.trim() !== commitSha) {
        throw new Error("Preview worktree commit verification failed");
    }
    return worktreePath;
}

async function installPreviewDependencies(
    config: PullRequestPreviewConfig,
    worktreePath: string,
    signal?: AbortSignal
): Promise<void> {
    const environment = safeInstallEnvironment(config);
    for (const cwd of [worktreePath, path.join(worktreePath, "backend")]) {
        await runCommand(
            config.bunExecutable,
            ["install", "--frozen-lockfile", "--ignore-scripts"],
            {
                cwd,
                env: environment,
                signal,
                timeoutMs: 5 * 60 * 1000,
            }
        );
    }
}

function tailscaleDnsName(status: TailscaleStatus): string {
    const dnsName = status.Self?.DNSName?.trim().replace(/\.$/u, "");
    if (!dnsName || !/^[a-z0-9.-]+$/iu.test(dnsName)) {
        throw new Error("Tailscale did not report a stable MagicDNS hostname");
    }
    return dnsName.toLowerCase();
}

async function inspectTailscaleServe(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<PreviewTailscaleRoute> {
    const [status, serveStatus] = await Promise.all([
        runJsonCommand<TailscaleStatus>("tailscale", ["status", "--json"], {
            signal,
        }),
        runJsonCommand<TailscaleServeStatus>("tailscale", ["serve", "status", "--json"], {
            signal,
        }),
    ]);
    const dnsName = tailscaleDnsName(status);
    const port = config.frontendPort;
    const proxyTarget = `http://127.0.0.1:${port}`;
    const web = serveStatus.Web?.[`${dnsName}:${port}`];
    const configuredProxy = web?.Handlers?.["/"]?.Proxy;
    const hasHttpsListener = serveStatus.TCP?.[String(port)]?.HTTPS === true;
    if (
        (configuredProxy || hasHttpsListener) &&
        (!hasHttpsListener || configuredProxy !== proxyTarget)
    ) {
        throw Object.assign(
            new Error(`Tailscale Serve port ${port} is configured for another target`),
            { statusCode: 409 }
        );
    }
    return {
        enabled: hasHttpsListener,
        url: `https://${dnsName}:${port}`,
    };
}

async function enableTailscaleServe(
    config: PullRequestPreviewConfig,
    expectedUrl: string,
    onOwnershipChange: (isOwned: boolean) => void,
    signal?: AbortSignal
): Promise<void> {
    const current = await inspectTailscaleServe(config, signal);
    if (current.url !== expectedUrl) {
        throw new Error("Tailscale MagicDNS hostname changed during preview startup");
    }
    if (current.enabled) {
        throw Object.assign(
            new Error(
                `Tailscale Serve port ${config.frontendPort} became active during preview startup`
            ),
            { statusCode: 409 }
        );
    }
    await runCommand(
        "sudo",
        [
            "-n",
            "tailscale",
            "serve",
            "--bg",
            `--https=${config.frontendPort}`,
            `http://127.0.0.1:${config.frontendPort}`,
        ],
        { signal }
    );
    onOwnershipChange(true);
    try {
        const enabled = await inspectTailscaleServe(config, signal);
        if (!enabled.enabled || enabled.url !== expectedUrl) {
            throw new Error("Tailscale Serve did not expose the ready preview service");
        }
    } catch (error) {
        try {
            await disableOwnedTailscaleServe(config, true);
            onOwnershipChange(false);
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Tailscale Serve activation failed and its route could not be removed",
                { cause: cleanupError }
            );
        }
        throw error;
    }
}

async function disableOwnedTailscaleServe(
    config: PullRequestPreviewConfig,
    isOwned: boolean
): Promise<void> {
    if (!isOwned) return;
    const [status, serveStatus] = await Promise.all([
        runJsonCommand<TailscaleStatus>("tailscale", ["status", "--json"]),
        runJsonCommand<TailscaleServeStatus>("tailscale", ["serve", "status", "--json"]),
    ]);
    const dnsName = tailscaleDnsName(status);
    const port = config.frontendPort;
    const proxyTarget = `http://127.0.0.1:${port}`;
    const web = serveStatus.Web?.[`${dnsName}:${port}`];
    const configuredProxy = web?.Handlers?.["/"]?.Proxy;
    const hasHttpsListener = serveStatus.TCP?.[String(port)]?.HTTPS === true;
    if (!configuredProxy && !hasHttpsListener) return;
    if (!hasHttpsListener || configuredProxy !== proxyTarget) {
        throw Object.assign(
            new Error(
                `Refusing to remove Tailscale Serve port ${port} because it is configured for another target`
            ),
            { statusCode: 409 }
        );
    }
    await runCommand("sudo", ["-n", "tailscale", "serve", `--https=${port}`, "off"]);
}

function removeMaterializedGatewayTokenFile(filePath: string, label: string): void {
    if (!existsSync(filePath)) return;
    if (!isRealRegularFile(filePath)) {
        throw new Error(`${label} path must be a real regular file`);
    }
    rmSync(filePath, { force: true });
}

function removeMaterializedGatewayCredentials(config: PullRequestPreviewConfig): void {
    const errors: Error[] = [];
    for (const [filePath, label] of [
        [config.gatewayTokenFile, "PR dev Gateway proxy token"],
        [config.gatewayUpstreamTokenFile, "PR dev upstream Gateway token"],
    ] as const) {
        try {
            removeMaterializedGatewayTokenFile(filePath, label);
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "PR dev Gateway credential cleanup failed");
    }
}

function managedStateRoot(config: PullRequestPreviewConfig, number: number): string {
    const stateRoot = path.join(config.previewRoot, "states", `pr-${number}`);
    if (!isPathStrictlyWithin(stateRoot, config.previewRoot)) {
        throw new Error("Preview state escaped the configured preview root");
    }
    return stateRoot;
}

/** Lists isolated PR state directories without following directory symlinks. */
export function listManagedPullRequestPreviewStateNumbers(
    config: PullRequestPreviewConfig = resolvePullRequestPreviewConfig()
): number[] {
    const statesRoot = path.join(config.previewRoot, "states");
    if (!existsSync(statesRoot)) return [];
    if (!isRealDirectory(config.previewRoot) || !isRealDirectory(statesRoot)) {
        throw new Error("PR dev state roots must be real directories");
    }
    const resolvedPreviewRoot = realpathSync(config.previewRoot);
    const resolvedStatesRoot = realpathSync(statesRoot);
    if (!isPathStrictlyWithin(resolvedStatesRoot, resolvedPreviewRoot)) {
        throw new Error("PR dev states escaped the configured preview root");
    }
    const numbers: number[] = [];
    const stateEntries = readdirSync(statesRoot, { withFileTypes: true });
    for (const entry of stateEntries) {
        const match = MANAGED_STATE_DIRECTORY_PATTERN.exec(entry.name);
        if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const number = Number(match[1]);
        if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647) {
            continue;
        }
        const stateRoot = path.join(statesRoot, entry.name);
        if (
            !isRealDirectory(stateRoot) ||
            !isPathStrictlyWithin(realpathSync(stateRoot), resolvedStatesRoot)
        ) {
            throw new Error("PR dev state directory escaped the managed states root");
        }
        numbers.push(number);
    }
    return numbers.toSorted((left, right) => left - right);
}

function didRemoveManagedPreviewState(
    config: PullRequestPreviewConfig,
    number: number
): boolean {
    const stateRoot = managedStateRoot(config, number);
    if (!existsSync(stateRoot)) return false;
    const statesRoot = path.dirname(stateRoot);
    if (
        !isRealDirectory(config.previewRoot) ||
        !isRealDirectory(statesRoot) ||
        !isRealDirectory(stateRoot) ||
        !isPathStrictlyWithin(
            realpathSync(statesRoot),
            realpathSync(config.previewRoot)
        ) ||
        !isPathStrictlyWithin(realpathSync(stateRoot), realpathSync(statesRoot))
    ) {
        throw new Error("PR dev state path must be a real directory");
    }
    rmSync(stateRoot, { force: true, recursive: true });
    return true;
}

function didRemovePreviewRecord(config: PullRequestPreviewConfig): boolean {
    if (!existsSync(config.stateFile)) return false;
    if (!isRealRegularFile(config.stateFile)) {
        throw new Error("PR dev record path must be a real regular file");
    }
    rmSync(config.stateFile, { force: true });
    return true;
}

function previewGatewayProxyUrl(config: PullRequestPreviewConfig): string {
    return `ws://127.0.0.1:${config.gatewayProxyPort}/gateway`;
}

async function preparePreviewState(
    config: PullRequestPreviewConfig,
    number: number,
    publicOrigin: string
): Promise<string> {
    const stateRoot = managedStateRoot(config, number);
    const environment = {
        ...safeInstallEnvironment(config),
        MIRA_DASHBOARD_DEV_BACKEND_PORT: String(config.backendPort),
        MIRA_DASHBOARD_DEV_FRONTEND_PORT: String(config.frontendPort),
        MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: config.gatewayTokenFile,
        MIRA_DASHBOARD_DEV_GATEWAY_URL: previewGatewayProxyUrl(config),
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: publicOrigin,
        MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
        ...(config.sourceWebAuthnRpId && {
            MIRA_DASHBOARD_WEBAUTHN_RP_ID: config.sourceWebAuthnRpId,
        }),
        ...(config.openClawConfigSource && {
            MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE: config.openClawConfigSource,
        }),
        ...(config.recentAuthMinutes && {
            MIRA_DASHBOARD_RECENT_AUTH_MINUTES: config.recentAuthMinutes,
        }),
        ...(config.databaseTemplate && {
            MIRA_DASHBOARD_DEV_DB_SOURCE: config.databaseTemplate,
        }),
        ...(config.releaseSource && {
            MIRA_DASHBOARD_DEV_RELEASES_SOURCE: config.releaseSource,
        }),
        ...(config.sessionIdleMinutes && {
            MIRA_DASHBOARD_SESSION_IDLE_MINUTES: config.sessionIdleMinutes,
        }),
        ...(config.workspaceSource && {
            MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE: config.workspaceSource,
        }),
    };
    const developmentConfig = resolveDevelopmentStackConfig(
        environment,
        config.dashboardRoot
    );
    prepareDevelopmentState(developmentConfig);
    return stateRoot;
}

function sandboxDirectories(...targets: string[]): string[] {
    const directories = new Set<string>();
    for (const target of targets) {
        let current = path.dirname(target);
        const ancestors: string[] = [];
        while (current !== path.parse(current).root) {
            ancestors.push(current);
            current = path.dirname(current);
        }
        for (const ancestor of ancestors.toReversed()) directories.add(ancestor);
    }
    return [...directories];
}

/** Builds the filesystem-isolated process used by the transient preview unit. */
export function buildPullRequestPreviewSandboxCommand(input: {
    config: PullRequestPreviewConfig;
    publicOrigin: string;
    stateRoot: string;
    worktreePath: string;
}): string[] {
    const { config, publicOrigin, stateRoot, worktreePath } = input;
    const arguments_ = [
        "bwrap",
        "--unshare-all",
        "--share-net",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind",
        config.bunExecutable,
        "/bun",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/etc",
        "--ro-bind",
        "/etc/resolv.conf",
        "/etc/resolv.conf",
        "--dir",
        "/home",
        "--dir",
        "/home/dev",
        "--dir",
        "/run",
        "--dir",
        "/run/mira-dashboard-preview",
    ];
    for (const directory of sandboxDirectories(
        worktreePath,
        config.dashboardRoot,
        stateRoot
    )) {
        arguments_.push("--dir", directory);
    }
    const sandboxGatewayTokenFile = "/run/mira-dashboard-preview/gateway.token";
    arguments_.push(
        "--ro-bind",
        worktreePath,
        worktreePath,
        "--dir",
        config.dashboardRoot,
        "--ro-bind",
        config.gitCommonDirectory,
        config.gitCommonDirectory,
        "--bind",
        stateRoot,
        stateRoot,
        "--ro-bind",
        config.gatewayTokenFile,
        sandboxGatewayTokenFile,
        "--clearenv",
        "--setenv",
        "HOME",
        "/home/dev",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "MIRA_DASHBOARD_PROJECT_ROOT",
        config.projectRoot,
        "--setenv",
        "MIRA_DASHBOARD_DEV_BACKEND_PORT",
        String(config.backendPort),
        "--setenv",
        "MIRA_DASHBOARD_DEV_FRONTEND_PORT",
        String(config.frontendPort),
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
        sandboxGatewayTokenFile,
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_URL",
        previewGatewayProxyUrl(config),
        "--setenv",
        "MIRA_DASHBOARD_DEV_HOT_RELOAD",
        "0",
        "--setenv",
        "MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN",
        publicOrigin,
        "--setenv",
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        stateRoot
    );
    if (config.recentAuthMinutes) {
        arguments_.push(
            "--setenv",
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            config.recentAuthMinutes
        );
    }
    if (config.sourceWebAuthnRpId) {
        arguments_.push(
            "--setenv",
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            config.sourceWebAuthnRpId
        );
    }
    if (config.sessionIdleMinutes) {
        arguments_.push(
            "--setenv",
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            config.sessionIdleMinutes
        );
    }
    arguments_.push(
        "--chdir",
        worktreePath,
        "--",
        "/bun",
        path.join(worktreePath, "scripts", "developmentStack.ts")
    );
    return arguments_;
}

async function startPreviewUnit(
    config: PullRequestPreviewConfig,
    sandboxCommand: string[],
    signal?: AbortSignal
): Promise<void> {
    await runCommand(
        "systemd-run",
        [
            "--user",
            `--unit=${config.unitName}`,
            "--collect",
            "--quiet",
            "--property=CPUWeight=30",
            "--property=IOWeight=30",
            "--property=MemoryHigh=2G",
            "--property=MemoryMax=3G",
            "--property=TasksMax=256",
            "--property=KillMode=control-group",
            // This host uses setuid bubblewrap because unprivileged user
            // namespaces are disabled. NoNewPrivileges would block bwrap
            // before it creates the sandbox; bwrap drops all child capabilities.
            "--property=RuntimeMaxSec=4h",
            "--property=TimeoutStopSec=20s",
            "--",
            ...sandboxCommand,
        ],
        {
            env: process.env,
            signal,
            timeoutMs: 30_000,
        }
    );
}

async function startPreviewGatewayProxyUnit(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<void> {
    if (!isRealRegularFile(config.gatewayProxyEntrypoint)) {
        throw new Error(
            `Trusted PR dev Gateway proxy entrypoint is unavailable: ${config.gatewayProxyEntrypoint}`
        );
    }
    ensureRealDirectory(path.dirname(config.gatewayProxyIdentityFile));
    ensurePrivateSingleLinkFile(
        config.gatewayProxyIdentityFile,
        "PR dev Gateway proxy identity"
    );
    await runCommand(
        "systemd-run",
        [
            "--user",
            `--unit=${config.gatewayProxyUnitName}`,
            "--collect",
            "--quiet",
            "--property=CPUWeight=20",
            "--property=IOWeight=20",
            "--property=MemoryHigh=256M",
            "--property=MemoryMax=512M",
            "--property=TasksMax=64",
            "--property=KillMode=control-group",
            "--property=NoNewPrivileges=yes",
            "--property=RuntimeMaxSec=4h",
            "--property=TimeoutStopSec=10s",
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_CLIENT_TOKEN_FILE=${config.gatewayTokenFile}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_IDENTITY_FILE=${config.gatewayProxyIdentityFile}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT=${config.gatewayProxyPort}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_TOKEN_FILE=${config.gatewayUpstreamTokenFile}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL=${config.gatewayUrl}`,
            "--setenv=NODE_ENV=production",
            "--",
            config.bunExecutable,
            config.gatewayProxyEntrypoint,
        ],
        {
            env: process.env,
            signal,
            timeoutMs: 30_000,
        }
    );
}

/** Parses the bounded systemctl property format used for preview status. */
export function parsePreviewUnitState(output: string): SystemdUnitState {
    const properties = new Map<string, string>();
    for (const line of output.split("\n")) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        properties.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return {
        activeState: properties.get("ActiveState") || undefined,
        result: properties.get("Result") || undefined,
        subState: properties.get("SubState") || undefined,
    };
}

async function systemdUnitState(unitName: string): Promise<SystemdUnitState | undefined> {
    const result = await runProcess(
        "systemctl",
        [
            "--user",
            "show",
            unitName,
            "--property=ActiveState",
            "--property=SubState",
            "--property=Result",
            "--no-pager",
        ],
        {
            env: process.env,
            maxBuffer: 64 * 1024,
            timeoutMs: 10_000,
        }
    );
    return result.code === 0 ? parsePreviewUnitState(result.stdout) : undefined;
}

async function previewUnitState(
    config: PullRequestPreviewConfig
): Promise<SystemdUnitState | undefined> {
    return systemdUnitState(config.unitName);
}

function lifecycleFromUnit(
    state: SystemdUnitState | undefined,
    fallback: PullRequestPreviewLifecycle
): PullRequestPreviewLifecycle {
    if (fallback === "failed") {
        return "failed";
    }
    switch (state?.activeState) {
        case "active": {
            return fallback === "starting" ? "starting" : "running";
        }
        case "activating": {
            return "starting";
        }
        case "deactivating": {
            return "stopping";
        }
        case "failed": {
            return "failed";
        }
        case "inactive": {
            return state.result && state.result !== "success" ? "failed" : "stopped";
        }
        default: {
            return fallback === "running" || fallback === "starting"
                ? "failed"
                : fallback;
        }
    }
}

function publicPreviewStatus(
    record: PullRequestPreviewRecord,
    unitState?: SystemdUnitState
): PullRequestPreviewStatus {
    const status = lifecycleFromUnit(unitState, record.status);
    const unitMessage =
        status === "failed" && unitState?.result && unitState.result !== "success"
            ? `Preview service result: ${unitState.result}`
            : undefined;
    return {
        backendPort: record.backendPort,
        commitSha: record.commitSha,
        frontendPort: record.frontendPort,
        message: unitMessage || record.message,
        number: record.number,
        startedAt: record.startedAt,
        status,
        title: record.title,
        updatedAt: record.updatedAt,
        url: record.url,
    };
}

/** Reads the active preview and reconciles resources left by a stopped unit. */
export async function getPullRequestPreviewStatus(
    config = resolvePullRequestPreviewConfig()
): Promise<PullRequestPreviewStatus> {
    const record = readPreviewRecord(config);
    if (!record) return { status: "stopped" };
    const unitState = await previewUnitState(config);
    const isManagedLifecycle =
        record.status === "running" || record.status === "starting";
    const proxyUnitState = isManagedLifecycle
        ? await systemdUnitState(config.gatewayProxyUnitName)
        : undefined;
    const isUnitTerminal =
        !unitState || ["failed", "inactive"].includes(unitState.activeState || "");
    const isProxyUnitTerminal =
        !proxyUnitState ||
        ["failed", "inactive"].includes(proxyUnitState.activeState || "");
    const recordUpdatedAt = Date.parse(record.updatedAt);
    const currentTimestamp = Date.now();
    const recordAgeMs =
        Number.isFinite(recordUpdatedAt) && recordUpdatedAt <= currentTimestamp
            ? currentTimestamp - recordUpdatedAt
            : Infinity;
    const isRecentStartup =
        record.status === "starting" &&
        recordAgeMs < PREVIEW_START_RECONCILIATION_GRACE_MS;
    const isStaleStopping =
        record.status === "stopping" &&
        recordAgeMs >= PREVIEW_STOP_RECONCILIATION_GRACE_MS;
    if (
        isStaleStopping ||
        (isManagedLifecycle &&
            !isRecentStartup &&
            (isUnitTerminal || isProxyUnitTerminal))
    ) {
        const cleanup = await cleanupPreviewResources(config, record.ownsTailscaleServe);
        const reconciledUnitState =
            !unitState || isStaleStopping
                ? {
                      activeState: "inactive",
                      result: "success",
                      subState: "dead",
                  }
                : unitState;
        const reconciledMessage =
            cleanup.errors.length > 0
                ? `Preview stopped outside the managed workflow. Cleanup: ${cleanup.errors.join(". ")}`
                : isStaleStopping
                  ? undefined
                  : record.message;
        const reconciledRecord: PullRequestPreviewRecord = {
            ...record,
            message: reconciledMessage,
            ownsTailscaleServe: cleanup.ownsTailscaleServe,
            status:
                cleanup.errors.length > 0
                    ? "failed"
                    : isStaleStopping
                      ? "stopped"
                      : lifecycleFromUnit(reconciledUnitState, record.status),
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, reconciledRecord);
        return publicPreviewStatus(
            reconciledRecord,
            cleanup.errors.length > 0 ? undefined : reconciledUnitState
        );
    }
    return publicPreviewStatus(record, unitState);
}

async function stopSystemdUnit(unitName: string): Promise<void> {
    const state = await systemdUnitState(unitName);
    if (!state || ["inactive", "failed"].includes(state.activeState || "")) {
        return;
    }
    await runCommand("systemctl", ["--user", "stop", unitName], {
        env: process.env,
        timeoutMs: 30_000,
    });
}

async function stopPreviewUnit(config: PullRequestPreviewConfig): Promise<void> {
    await stopSystemdUnit(config.unitName);
}

async function stopPreviewGatewayProxyUnit(
    config: PullRequestPreviewConfig
): Promise<void> {
    await stopSystemdUnit(config.gatewayProxyUnitName);
}

async function cleanupPreviewResources(
    config: PullRequestPreviewConfig,
    isTailscaleServeOwned: boolean
): Promise<{ errors: string[]; ownsTailscaleServe: boolean }> {
    const errors: string[] = [];
    for (const [cleanup, fallback] of [
        [() => stopPreviewUnit(config), "preview service stop failed"],
        [() => stopPreviewGatewayProxyUnit(config), "Gateway proxy stop failed"],
    ] as const) {
        try {
            await cleanup();
        } catch (error) {
            errors.push(errorMessage(error, fallback));
        }
    }
    try {
        removeMaterializedGatewayCredentials(config);
    } catch (error) {
        errors.push(errorMessage(error, "Gateway credential cleanup failed"));
    }
    let isTailscaleServeStillOwned = isTailscaleServeOwned;
    try {
        await disableOwnedTailscaleServe(config, isTailscaleServeOwned);
        isTailscaleServeStillOwned = false;
    } catch (error) {
        errors.push(errorMessage(error, "Serve cleanup failed"));
    }
    return { errors, ownsTailscaleServe: isTailscaleServeStillOwned };
}

async function waitForPreviewGatewayProxyReady(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<void> {
    const deadline = Date.now() + PREVIEW_GATEWAY_PROXY_READY_TIMEOUT_MS;
    const healthUrl = `http://127.0.0.1:${config.gatewayProxyPort}/health`;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new DOMException("Preview Gateway proxy startup aborted", "AbortError");
        }
        const state = await systemdUnitState(config.gatewayProxyUnitName);
        if (!state || ["failed", "inactive"].includes(state.activeState || "")) {
            throw new Error(
                `Preview Gateway proxy stopped during startup (${state?.result || state?.activeState || "unit missing"})`
            );
        }
        try {
            const response = await fetch(healthUrl, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok && state.activeState === "active") return;
        } catch {
            // The proxy is still connecting to the production Gateway.
        }
        await Bun.sleep(PREVIEW_GATEWAY_PROXY_READY_POLL_MS);
    }
    throw Object.assign(new Error("Timed out waiting for the PR dev Gateway proxy"), {
        statusCode: 504,
    });
}

async function waitForPreviewReady(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<void> {
    const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
    const healthUrl = `http://127.0.0.1:${config.frontendPort}/api/health/ready`;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new DOMException("Preview startup aborted", "AbortError");
        }
        const state = await previewUnitState(config);
        if (state && ["failed", "inactive"].includes(state.activeState || "")) {
            throw new Error(
                `Preview service stopped during startup (${state.result || state.activeState})`
            );
        }
        try {
            const response = await fetch(healthUrl, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok && state?.activeState === "active") return;
        } catch {
            // The managed frontend/backend pair is still starting.
        }
        await Bun.sleep(PREVIEW_READY_POLL_MS);
    }
    throw Object.assign(new Error("Timed out waiting for PR preview readiness"), {
        statusCode: 504,
    });
}

function validatePreviewPullRequest(
    pullRequest: PullRequestPreviewCandidate,
    config: PullRequestPreviewConfig
): PullRequestPreviewCandidate {
    if (
        !Number.isSafeInteger(pullRequest.number) ||
        pullRequest.number <= 0 ||
        pullRequest.number > 2_147_483_647
    ) {
        throw new TypeError("Preview pull request number is invalid");
    }
    if (pullRequest.baseRefName !== "main") {
        throw Object.assign(
            new Error("Only main-targeted pull requests can be previewed"),
            { statusCode: 409 }
        );
    }
    if (
        !isPullRequestPreviewAuthorAllowed(pullRequest.authorLogin, config.allowedAuthors)
    ) {
        throw Object.assign(
            new Error("Pull request author is not allowed to run host previews"),
            { statusCode: 403 }
        );
    }
    if (!COMMIT_PATTERN.test(pullRequest.commitSha)) {
        throw new Error("Pull request does not expose a valid head commit");
    }
    if (
        !pullRequest.title.trim() ||
        pullRequest.title.length > 1024 ||
        /[\r\n\0]/u.test(pullRequest.title)
    ) {
        throw new TypeError("Pull request title is invalid");
    }
    return pullRequest;
}

/** Starts or updates the single managed preview slot for one validated PR. */
export async function startPullRequestPreview(
    candidate: PullRequestPreviewCandidate,
    options: {
        config?: PullRequestPreviewConfig;
        protectFromCancellation?: () => void;
        readGatewayToken?: () => string | undefined;
        signal?: AbortSignal;
    } = {}
): Promise<PullRequestPreviewStatus> {
    const config = options.config ?? resolvePullRequestPreviewConfig();
    const signal = options.signal;
    const pullRequest = validatePreviewPullRequest(candidate, config);
    const { number } = pullRequest;
    ensureRealDirectory(config.previewRoot);
    const current = await getPullRequestPreviewStatus(config);
    if (
        ["running", "starting", "stopping"].includes(current.status) &&
        current.number !== number
    ) {
        throw Object.assign(
            new Error(
                `PR #${current.number} already owns the preview slot; stop it first`
            ),
            { statusCode: 409 }
        );
    }
    const existingRecord = readPreviewRecord(config);
    const timestamp = new Date().toISOString();
    const tailscaleRoute = await inspectTailscaleServe(config, signal);
    if (tailscaleRoute.enabled && existingRecord?.ownsTailscaleServe !== true) {
        throw Object.assign(
            new Error(
                `Tailscale Serve port ${config.frontendPort} is active outside the managed preview`
            ),
            { statusCode: 409 }
        );
    }
    if (
        current.status === "running" &&
        current.number === number &&
        current.commitSha === pullRequest.commitSha &&
        existingRecord?.status === "running" &&
        existingRecord.ownsTailscaleServe &&
        tailscaleRoute.enabled
    ) {
        return current;
    }
    let isTailscaleServeOwned =
        existingRecord?.ownsTailscaleServe === true && tailscaleRoute.enabled;
    if (isTailscaleServeOwned) {
        await disableOwnedTailscaleServe(config, true);
        isTailscaleServeOwned = false;
    }
    const publicOrigin = tailscaleRoute.url;
    const worktreePath = previewWorktreePath(config);
    const startingRecord: PullRequestPreviewRecord = {
        backendPort: config.backendPort,
        commitSha: pullRequest.commitSha,
        formatVersion: PREVIEW_RECORD_FORMAT_VERSION,
        frontendPort: config.frontendPort,
        number,
        ownsTailscaleServe: false,
        status: "starting",
        title: pullRequest.title,
        updatedAt: timestamp,
        url: publicOrigin,
        worktreePath,
    };
    try {
        const staleResourceCleanup = await cleanupPreviewResources(config, false);
        if (staleResourceCleanup.errors.length > 0) {
            throw new Error(
                `Could not clean stale PR dev resources: ${staleResourceCleanup.errors.join(". ")}`
            );
        }
        const preparedWorktree = await ensurePreviewWorktree(
            config,
            number,
            pullRequest.commitSha,
            signal
        );
        await installPreviewDependencies(config, preparedWorktree, signal);
        const stateRoot = await preparePreviewState(config, number, publicOrigin);
        writePreviewRecord(config, startingRecord);
        materializeGatewayCredentials(
            config,
            (options.readGatewayToken || getPersistedGatewayToken)()
        );
        const sandboxCommand = buildPullRequestPreviewSandboxCommand({
            config,
            publicOrigin,
            stateRoot,
            worktreePath: preparedWorktree,
        });
        options.protectFromCancellation?.();
        await startPreviewGatewayProxyUnit(config, signal);
        await waitForPreviewGatewayProxyReady(config, signal);
        removeMaterializedGatewayTokenFile(
            config.gatewayUpstreamTokenFile,
            "PR dev upstream Gateway token"
        );
        await startPreviewUnit(config, sandboxCommand, signal);
        await waitForPreviewReady(config, signal);
        await enableTailscaleServe(
            config,
            publicOrigin,
            (isOwned) => {
                isTailscaleServeOwned = isOwned;
                writePreviewRecord(config, {
                    ...startingRecord,
                    ownsTailscaleServe: isOwned,
                    updatedAt: new Date().toISOString(),
                });
            },
            signal
        );
        const startedAt = new Date().toISOString();
        const runningRecord: PullRequestPreviewRecord = {
            ...startingRecord,
            ownsTailscaleServe: isTailscaleServeOwned,
            startedAt,
            status: "running",
            updatedAt: startedAt,
        };
        writePreviewRecord(config, runningRecord);
        return publicPreviewStatus(runningRecord, await previewUnitState(config));
    } catch (error) {
        const cleanup = await cleanupPreviewResources(config, isTailscaleServeOwned);
        const startupMessage = errorMessage(error, "PR preview startup failed");
        const failedRecord: PullRequestPreviewRecord = {
            ...startingRecord,
            message:
                cleanup.errors.length > 0
                    ? `${startupMessage}. Cleanup: ${cleanup.errors.join(". ")}`
                    : startupMessage,
            ownsTailscaleServe: cleanup.ownsTailscaleServe,
            status: "failed",
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, failedRecord);
        throw error;
    }
}

/** Stops the managed preview slot, optionally enforcing its owning PR number. */
export async function stopPullRequestPreview(
    number: number | undefined,
    options: {
        config?: PullRequestPreviewConfig;
        protectFromCancellation?: () => void;
    } = {}
): Promise<PullRequestPreviewStatus> {
    const config = options.config ?? resolvePullRequestPreviewConfig();
    const record = readPreviewRecord(config);
    if (!record) return { status: "stopped" };
    if (number !== undefined && record.number !== number) {
        throw Object.assign(
            new Error(`PR #${number} does not own the active preview slot`),
            { statusCode: 409 }
        );
    }
    options.protectFromCancellation?.();
    writePreviewRecord(config, {
        ...record,
        status: "stopping",
        updatedAt: new Date().toISOString(),
    });
    const cleanup = await cleanupPreviewResources(config, record.ownsTailscaleServe);
    if (cleanup.errors.length > 0) {
        const failedRecord: PullRequestPreviewRecord = {
            ...record,
            message: `PR dev stop cleanup failed: ${cleanup.errors.join(". ")}`,
            ownsTailscaleServe: cleanup.ownsTailscaleServe,
            status: "failed",
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, failedRecord);
        throw Object.assign(
            new AggregateError(
                cleanup.errors.map((message) => new Error(message)),
                failedRecord.message
            ),
            { statusCode: 500 }
        );
    }
    const stoppedRecord: PullRequestPreviewRecord = {
        ...record,
        message: undefined,
        ownsTailscaleServe: false,
        status: "stopped",
        updatedAt: new Date().toISOString(),
    };
    writePreviewRecord(config, stoppedRecord);
    return publicPreviewStatus(stoppedRecord);
}

/** Removes the shared checkout and isolated state after its owning PR closes. */
export async function cleanupClosedPullRequestPreview(
    number: number,
    options: { config?: PullRequestPreviewConfig } = {}
): Promise<PullRequestPreviewCleanupResult> {
    let didRemove = false;
    try {
        const config = options.config ?? resolvePullRequestPreviewConfig();
        const record = readPreviewRecord(config);
        const hasManagedSlotOwnership = record?.number === number;
        if (hasManagedSlotOwnership) {
            await stopPullRequestPreview(number, { config });
            didRemove =
                (await removePreviewWorktree(config, previewWorktreePath(config))) ||
                didRemove;
            await runCommand("git", [
                "-C",
                config.dashboardRoot,
                "update-ref",
                "-d",
                PREVIEW_REFERENCE,
            ]);
            didRemove = didRemovePreviewRecord(config) || didRemove;
        }
        didRemove = didRemoveManagedPreviewState(config, number) || didRemove;
        return {
            message: didRemove
                ? `Removed managed PR dev data for #${number}`
                : `No managed PR dev data found for #${number}`,
            number,
            status: didRemove ? "removed" : "skipped",
        };
    } catch (error) {
        return {
            message: `PR dev cleanup warning for #${number}: ${errorMessage(error, "cleanup failed")}`,
            number,
            status: "warning",
        };
    }
}
