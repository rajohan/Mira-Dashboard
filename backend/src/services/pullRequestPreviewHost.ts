import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { getPersistedGatewayToken } from "../auth.ts";
import {
    prepareDevelopmentState,
    resolveDevelopmentStackConfig,
} from "../development/developmentStack.ts";
import { errorMessage } from "../lib/errors.ts";
import { runProcess } from "../lib/processes.ts";
import {
    isPullRequestPreviewAuthorAllowed,
    resolvePullRequestPreviewAllowedAuthors,
} from "./pullRequestPreviewPolicy.ts";

const PREVIEW_UNIT = "mira-dashboard-pr-preview.service";
const PREVIEW_RECORD_FILE = "active-preview.json";
const PREVIEW_RECORD_FORMAT_VERSION = 1;
const PREVIEW_READY_TIMEOUT_MS = 90_000;
const PREVIEW_READY_POLL_MS = 500;
const MAX_COMMAND_BUFFER = 10 * 1024 * 1024;
const MAX_PREVIEW_RECORD_BYTES = 256 * 1024;
const COMMIT_PATTERN = /^[\da-f]{40}$/u;
const UNIT_NAME_PATTERN = /^[A-Za-z0-9_.@-]+\.service$/u;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
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

export interface PullRequestPreviewConfig {
    allowedAuthors: ReadonlySet<string>;
    backendPort: number;
    bunExecutable: string;
    dashboardRoot: string;
    databaseTemplate?: string;
    frontendPort: number;
    gatewayTokenFile: string;
    gatewayUrl: string;
    gitCommonDirectory: string;
    openClawConfigSource?: string;
    previewRoot: string;
    recentAuthMinutes?: string;
    releaseSource?: string;
    sessionIdleMinutes?: string;
    sourceWebAuthnRpId?: string;
    stateFile: string;
    unitName: string;
    workspaceSource?: string;
    worktreeRoot: string;
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

function optionalAbsoluteNonRootPath(
    name: string,
    value: string | undefined
): string | undefined {
    const configured = value?.trim();
    return configured ? absoluteNonRootPath(name, configured) : undefined;
}

function configuredPort(
    name: string,
    value: string | undefined,
    fallback: number
): number {
    const normalized = value?.trim();
    if (!normalized) return fallback;
    if (!/^\d+$/u.test(normalized)) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    const port = Number(normalized);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    return port;
}

function configuredGatewayUrl(value: string | undefined): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    let url: URL;
    try {
        url = new URL(configured);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_PREVIEW_GATEWAY_URL must be a valid URL");
    }
    if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
    ) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_URL must be ws:// or wss:// without credentials or a fragment"
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

function resolveExecutable(value: string | undefined, fallback: string): string {
    const configured = value?.trim() || Bun.which(fallback);
    if (!configured || !path.isAbsolute(configured)) {
        throw new TypeError(`${fallback} executable must resolve to an absolute path`);
    }
    return path.resolve(configured);
}

function gitCommonDirectory(
    dashboardRoot: string,
    configured: string | undefined
): string {
    const explicit = optionalAbsoluteNonRootPath(
        "MIRA_DASHBOARD_PREVIEW_GIT_COMMON_DIR",
        configured
    );
    return explicit || path.join(dashboardRoot, ".git");
}

/** Resolves the single-slot managed PR preview host contract. */
export function resolvePullRequestPreviewConfig(
    environment: Record<string, string | undefined> = process.env
): PullRequestPreviewConfig {
    const dashboardRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_ROOT",
        environment.MIRA_DASHBOARD_ROOT?.trim() || "/home/ubuntu/projects/mira-dashboard"
    );
    const worktreeRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_WORKTREE_ROOT",
        environment.MIRA_DASHBOARD_WORKTREE_ROOT?.trim() ||
            "/home/ubuntu/projects/mira-dashboard-worktrees"
    );
    const previewRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_PREVIEW_ROOT",
        environment.MIRA_DASHBOARD_PREVIEW_ROOT?.trim() ||
            "/home/ubuntu/projects/mira-dashboard-preview-state/managed"
    );
    const frontendPort = configuredPort(
        "MIRA_DASHBOARD_PREVIEW_FRONTEND_PORT",
        environment.MIRA_DASHBOARD_PREVIEW_FRONTEND_PORT,
        5173
    );
    const backendPort = configuredPort(
        "MIRA_DASHBOARD_PREVIEW_BACKEND_PORT",
        environment.MIRA_DASHBOARD_PREVIEW_BACKEND_PORT,
        3101
    );
    if (frontendPort === backendPort) {
        throw new TypeError("Dashboard preview frontend and backend ports must differ");
    }
    const unitName = environment.MIRA_DASHBOARD_PREVIEW_UNIT?.trim() || PREVIEW_UNIT;
    if (!UNIT_NAME_PATTERN.test(unitName)) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_UNIT must be a valid .service unit name"
        );
    }
    const allowedAuthors = resolvePullRequestPreviewAllowedAuthors(
        environment.MIRA_DASHBOARD_PREVIEW_ALLOWED_AUTHORS
    );
    const openClawSourceRoot = optionalAbsoluteNonRootPath(
        "MIRA_DASHBOARD_PREVIEW_OPENCLAW_SOURCE_ROOT",
        environment.MIRA_DASHBOARD_PREVIEW_OPENCLAW_SOURCE_ROOT?.trim() ||
            "/home/ubuntu/.openclaw"
    );
    return {
        allowedAuthors,
        backendPort,
        bunExecutable: resolveExecutable(environment.BUN_BINARY, "bun"),
        dashboardRoot,
        databaseTemplate: optionalAbsoluteNonRootPath(
            "MIRA_DASHBOARD_PREVIEW_DB_TEMPLATE",
            environment.MIRA_DASHBOARD_PREVIEW_DB_TEMPLATE?.trim() ||
                "/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db"
        ),
        frontendPort,
        gatewayTokenFile:
            optionalAbsoluteNonRootPath(
                "MIRA_DASHBOARD_PREVIEW_GATEWAY_TOKEN_FILE",
                environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_TOKEN_FILE
            ) || path.join(previewRoot, "gateway.token"),
        gatewayUrl:
            configuredGatewayUrl(environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_URL) ||
            DEFAULT_GATEWAY_URL,
        gitCommonDirectory: gitCommonDirectory(
            dashboardRoot,
            environment.MIRA_DASHBOARD_PREVIEW_GIT_COMMON_DIR
        ),
        openClawConfigSource: openClawSourceRoot
            ? path.join(openClawSourceRoot, "openclaw.json")
            : undefined,
        previewRoot,
        recentAuthMinutes: optionalEnvironmentValue(
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            environment.MIRA_DASHBOARD_RECENT_AUTH_MINUTES
        ),
        releaseSource: optionalAbsoluteNonRootPath(
            "MIRA_DASHBOARD_PREVIEW_RELEASES_SOURCE",
            environment.MIRA_DASHBOARD_PREVIEW_RELEASES_SOURCE?.trim() ||
                "/home/ubuntu/projects/mira-dashboard-releases"
        ),
        sessionIdleMinutes: optionalEnvironmentValue(
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            environment.MIRA_DASHBOARD_SESSION_IDLE_MINUTES
        ),
        sourceWebAuthnRpId: optionalEnvironmentValue(
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID
        ),
        stateFile: path.join(previewRoot, PREVIEW_RECORD_FILE),
        unitName,
        workspaceSource: openClawSourceRoot
            ? path.join(openClawSourceRoot, "workspace")
            : undefined,
        worktreeRoot,
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

function ensureRealDirectory(directoryPath: string): void {
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    if (!isRealDirectory(directoryPath)) {
        throw new Error(`Preview path must be a real directory: ${directoryPath}`);
    }
    chmodSync(directoryPath, 0o700);
}

function materializeGatewayToken(
    config: PullRequestPreviewConfig,
    tokenValue: string | undefined
): void {
    const token = tokenValue?.trim();
    if (
        !token ||
        Buffer.byteLength(token) > MAX_GATEWAY_TOKEN_BYTES ||
        /[\r\n\0]/u.test(token)
    ) {
        throw new Error("A valid persisted Gateway token is required for PR dev");
    }
    const tokenDirectory = path.dirname(config.gatewayTokenFile);
    ensureRealDirectory(tokenDirectory);
    if (
        existsSync(config.gatewayTokenFile) &&
        !isRealRegularFile(config.gatewayTokenFile)
    ) {
        throw new Error("PR dev Gateway token path must be a real regular file");
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
        renameSync(temporaryPath, config.gatewayTokenFile);
        chmodSync(config.gatewayTokenFile, 0o600);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
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
    if (!existsSync(config.stateFile)) return undefined;
    if (!isRealRegularFile(config.stateFile)) {
        throw new Error("Dashboard preview state must be a real regular file");
    }
    if (lstatSync(config.stateFile).size > MAX_PREVIEW_RECORD_BYTES) {
        throw new Error("Dashboard preview state is too large");
    }
    const content = readFileSync(config.stateFile, "utf8");
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

function previewWorktreePath(config: PullRequestPreviewConfig, number: number): string {
    return path.join(config.worktreeRoot, `preview-pr-${number}`);
}

async function ensurePreviewWorktree(
    config: PullRequestPreviewConfig,
    number: number,
    commitSha: string,
    signal?: AbortSignal
): Promise<string> {
    ensureRealDirectory(config.worktreeRoot);
    const worktreePath = previewWorktreePath(config, number);
    if (!isPathStrictlyWithin(worktreePath, config.worktreeRoot)) {
        throw new Error("Preview worktree escaped the configured worktree root");
    }
    const previewReference = `refs/mira-dashboard/previews/pr-${number}`;
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "fetch",
            "--force",
            "--no-tags",
            "origin",
            `pull/${number}/head:${previewReference}`,
        ],
        {
            env: githubCommandEnvironment(),
            signal,
            timeoutMs: 180_000,
        }
    );
    const { stdout: fetchedCommit } = await runCommand(
        "git",
        ["-C", config.dashboardRoot, "rev-parse", previewReference],
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

function removeMaterializedGatewayToken(config: PullRequestPreviewConfig): void {
    if (!existsSync(config.gatewayTokenFile)) return;
    if (!isRealRegularFile(config.gatewayTokenFile)) {
        throw new Error("PR dev Gateway token path must be a real regular file");
    }
    rmSync(config.gatewayTokenFile, { force: true });
}

function managedStateRoot(config: PullRequestPreviewConfig, number: number): string {
    const stateRoot = path.join(config.previewRoot, "states", `pr-${number}`);
    if (!isPathStrictlyWithin(stateRoot, config.previewRoot)) {
        throw new Error("Preview state escaped the configured preview root");
    }
    return stateRoot;
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
        MIRA_DASHBOARD_DEV_GATEWAY_URL: config.gatewayUrl,
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: publicOrigin,
        MIRA_DASHBOARD_DEV_STATE_OWNER: `managed-pr-${number}`,
        MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
        ...(config.sourceWebAuthnRpId && {
            MIRA_DASHBOARD_DEV_SOURCE_WEBAUTHN_RP_ID: config.sourceWebAuthnRpId,
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
    number: number;
    publicOrigin: string;
    stateRoot: string;
    worktreePath: string;
}): string[] {
    const { config, number, publicOrigin, stateRoot, worktreePath } = input;
    const arguments_ = [
        "bwrap",
        "--unshare-all",
        "--share-net",
        "--die-with-parent",
        "--new-session",
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
        "MIRA_DASHBOARD_DEV_BACKEND_HOST",
        "127.0.0.1",
        "--setenv",
        "MIRA_DASHBOARD_DEV_BACKEND_PORT",
        String(config.backendPort),
        "--setenv",
        "MIRA_DASHBOARD_DEV_FRONTEND_HOST",
        "127.0.0.1",
        "--setenv",
        "MIRA_DASHBOARD_DEV_FRONTEND_PORT",
        String(config.frontendPort),
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
        sandboxGatewayTokenFile,
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_URL",
        config.gatewayUrl,
        "--setenv",
        "MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN",
        publicOrigin,
        "--setenv",
        "MIRA_DASHBOARD_DEV_STATE_OWNER",
        `managed-pr-${number}`,
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
            "--property=NoNewPrivileges=yes",
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

async function previewUnitState(
    config: PullRequestPreviewConfig
): Promise<SystemdUnitState | undefined> {
    const result = await runProcess(
        "systemctl",
        [
            "--user",
            "show",
            config.unitName,
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

function lifecycleFromUnit(
    state: SystemdUnitState | undefined,
    fallback: PullRequestPreviewLifecycle
): PullRequestPreviewLifecycle {
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
    if (
        unitState &&
        record.status === "running" &&
        ["failed", "inactive"].includes(unitState.activeState || "")
    ) {
        const cleanupErrors: string[] = [];
        let isTailscaleServeOwned = record.ownsTailscaleServe;
        try {
            removeMaterializedGatewayToken(config);
        } catch (error) {
            cleanupErrors.push(errorMessage(error, "token cleanup failed"));
        }
        try {
            await disableOwnedTailscaleServe(config, isTailscaleServeOwned);
            isTailscaleServeOwned = false;
        } catch (error) {
            cleanupErrors.push(errorMessage(error, "Serve cleanup failed"));
        }
        const reconciledRecord: PullRequestPreviewRecord = {
            ...record,
            ...(cleanupErrors.length > 0 && {
                message: `Preview stopped outside the managed workflow. Cleanup: ${cleanupErrors.join(". ")}`,
            }),
            ownsTailscaleServe: isTailscaleServeOwned,
            status:
                cleanupErrors.length > 0
                    ? "failed"
                    : lifecycleFromUnit(unitState, record.status),
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, reconciledRecord);
        return publicPreviewStatus(
            reconciledRecord,
            cleanupErrors.length > 0 ? undefined : unitState
        );
    }
    return publicPreviewStatus(record, unitState);
}

async function stopUnit(config: PullRequestPreviewConfig): Promise<void> {
    const state = await previewUnitState(config);
    if (!state || ["inactive", "failed"].includes(state.activeState || "")) {
        return;
    }
    await runCommand("systemctl", ["--user", "stop", config.unitName], {
        env: process.env,
        timeoutMs: 30_000,
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
            // The watched frontend/backend pair is still starting.
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
    const worktreePath = previewWorktreePath(config, number);
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
    writePreviewRecord(config, startingRecord);
    try {
        await stopUnit(config);
        const preparedWorktree = await ensurePreviewWorktree(
            config,
            number,
            pullRequest.commitSha,
            signal
        );
        await installPreviewDependencies(config, preparedWorktree, signal);
        const stateRoot = await preparePreviewState(config, number, publicOrigin);
        materializeGatewayToken(
            config,
            (options.readGatewayToken || getPersistedGatewayToken)()
        );
        const sandboxCommand = buildPullRequestPreviewSandboxCommand({
            config,
            number,
            publicOrigin,
            stateRoot,
            worktreePath: preparedWorktree,
        });
        options.protectFromCancellation?.();
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
        const cleanupErrors: string[] = [];
        try {
            await stopUnit(config);
        } catch (cleanupError) {
            cleanupErrors.push(errorMessage(cleanupError, "service stop failed"));
        }
        try {
            removeMaterializedGatewayToken(config);
        } catch (cleanupError) {
            cleanupErrors.push(errorMessage(cleanupError, "token cleanup failed"));
        }
        let didCleanupRoute = false;
        try {
            await disableOwnedTailscaleServe(config, isTailscaleServeOwned);
            didCleanupRoute = true;
        } catch (cleanupError) {
            cleanupErrors.push(errorMessage(cleanupError, "Serve cleanup failed"));
        }
        const startupMessage = errorMessage(error, "PR preview startup failed");
        const failedRecord: PullRequestPreviewRecord = {
            ...startingRecord,
            message:
                cleanupErrors.length > 0
                    ? `${startupMessage}. Cleanup: ${cleanupErrors.join(". ")}`
                    : startupMessage,
            ownsTailscaleServe: isTailscaleServeOwned && !didCleanupRoute,
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
    await stopUnit(config);
    removeMaterializedGatewayToken(config);
    await disableOwnedTailscaleServe(config, record.ownsTailscaleServe);
    const stoppedRecord: PullRequestPreviewRecord = {
        ...record,
        ownsTailscaleServe: false,
        status: "stopped",
        updatedAt: new Date().toISOString(),
    };
    writePreviewRecord(config, stoppedRecord);
    return publicPreviewStatus(stoppedRecord);
}
