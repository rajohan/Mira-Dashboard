import fsp from "node:fs/promises";
import path from "node:path";

import {
    type DashboardProjectPaths,
    resolveDashboardProjectPaths,
} from "../backend/src/lib/dashboardPaths.ts";
import { runProcess } from "../backend/src/lib/processes.ts";
import { parseSystemdProperties } from "../backend/src/lib/systemdProperties.ts";
import { runReleaseLifecycleCommand } from "../backend/src/releaseLifecycle.ts";
import { stageDashboardRelease } from "../backend/src/services/releases/deployment.ts";
import { readDashboardReleaseState } from "../backend/src/services/releases/managerOperations.ts";
import { MANAGED_DASHBOARD_UNIT_NAMES } from "../backend/src/services/releases/systemdPolicy.ts";

const FULL_COMMIT_PATTERN = /^[\da-f]{40}$/u;
const SYSTEMCTL_EXECUTABLE = "/usr/bin/systemctl";
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_SERVICE_STABILIZATION_MS = 30_000;
const SERVICE_POLL_INTERVAL_MS = 250;

interface ProductionBootstrapCommandResult {
    stderr: string;
    stdout: string;
}

export interface ProductionBootstrapCommandOptions {
    allowNonZeroExit?: boolean;
    cwd?: string;
    timeoutMs: number;
}

export type ProductionBootstrapCommandRunner = (
    command: string,
    arguments_: readonly string[],
    options: ProductionBootstrapCommandOptions
) => Promise<ProductionBootstrapCommandResult>;

interface ProductionBootstrapReleaseSlots {
    current?: string;
    previous?: string;
}

interface StagedProductionRelease {
    commitSha: string;
    path: string;
}

export interface ProductionBootstrapOptions {
    activateRelease?: (commitSha: string) => Promise<void>;
    commandRunner?: ProductionBootstrapCommandRunner;
    environment?: NodeJS.ProcessEnv;
    initializeDatabase?: () => Promise<void>;
    onProgress?: (message: string) => void;
    paths?: DashboardProjectPaths;
    readReleaseSlots?: () => Promise<ProductionBootstrapReleaseSlots>;
    serviceStabilizationMs?: number;
    stageRelease?: (commitSha: string) => Promise<StagedProductionRelease>;
}

export interface ProductionBootstrapResult {
    commitSha: string;
    databasePath: string;
    releasePath: string;
    services: Array<{
        activeState: string;
        enabled: true;
        name: string;
        subState: string;
    }>;
}

export async function runProductionBootstrapCommand(
    command: string,
    arguments_: readonly string[],
    options: ProductionBootstrapCommandOptions
): Promise<ProductionBootstrapCommandResult> {
    const result = await runProcess(command, arguments_, {
        cwd: options.cwd,
        maxBuffer: COMMAND_OUTPUT_LIMIT,
        timeoutMs: options.timeoutMs,
    });
    if (result.code !== 0 && options.allowNonZeroExit !== true) {
        const invocation = [command, ...arguments_].join(" ");
        throw new Error(
            `${invocation} failed with exit code ${
                result.code
            }: ${result.stderr.trim() || result.stdout.trim()}`
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

async function ensureRealDirectory(directoryPath: string, mode: number): Promise<void> {
    let existingParent = directoryPath;
    while (true) {
        try {
            const parentStat = await fsp.lstat(existingParent);
            if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
                throw new TypeError(
                    `Dashboard bootstrap parent must be a real directory: ${existingParent}`
                );
            }
            if ((await fsp.realpath(existingParent)) !== path.resolve(existingParent)) {
                throw new TypeError(
                    `Dashboard bootstrap parent must not traverse symlinks: ${existingParent}`
                );
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            const nextParent = path.dirname(existingParent);
            if (nextParent === existingParent) {
                throw new TypeError(
                    `Dashboard bootstrap path has no real parent: ${directoryPath}`,
                    { cause: error }
                );
            }
            existingParent = nextParent;
        }
    }
    await fsp.mkdir(directoryPath, { mode, recursive: true });
    const stat = await fsp.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError(
            `Dashboard bootstrap path must be a real directory: ${directoryPath}`
        );
    }
    if ((await fsp.realpath(directoryPath)) !== path.resolve(directoryPath)) {
        throw new TypeError(
            `Dashboard bootstrap path must not traverse symlinks: ${directoryPath}`
        );
    }
    await fsp.chmod(directoryPath, mode);
}

async function assertRealDirectory(directoryPath: string, label: string): Promise<void> {
    const stat = await fsp.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError(`${label} must be a real directory`);
    }
    if ((await fsp.realpath(directoryPath)) !== path.resolve(directoryPath)) {
        throw new TypeError(`${label} must not traverse symlinks`);
    }
}

export async function initializeProductionBootstrapDatabase(): Promise<void> {
    const { database } = await import("../backend/src/database/connection.ts");
    try {
        const quickCheck = database.query("PRAGMA quick_check").all() as Array<
            Record<string, unknown>
        >;
        if (
            quickCheck.length !== 1 ||
            Object.values(quickCheck[0] ?? {}).every(
                (value) => typeof value !== "string" || value.toLowerCase() !== "ok"
            )
        ) {
            throw new Error("Fresh Dashboard database failed SQLite quick_check");
        }
    } finally {
        database.close();
    }
}

function assertBootstrapEnvironment(environment: NodeJS.ProcessEnv): void {
    if (environment.NODE_ENV !== "production") {
        throw new Error("Dashboard production bootstrap requires NODE_ENV=production");
    }
    if (typeof process.getuid === "function" && process.getuid() === 0) {
        throw new Error(
            "Dashboard production bootstrap must run as the managed system user, not root"
        );
    }
}

function assertServiceStabilizationMs(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(
            "Dashboard bootstrap service stabilization window must be non-negative"
        );
    }
    return value;
}

async function resolveCheckoutCommit(
    sourceRoot: string,
    commandRunner: ProductionBootstrapCommandRunner
): Promise<string> {
    const repositoryRoot = await commandRunner("git", ["rev-parse", "--show-toplevel"], {
        cwd: sourceRoot,
        timeoutMs: 30_000,
    });
    if (path.resolve(repositoryRoot.stdout.trim()) !== sourceRoot) {
        throw new Error("Dashboard bootstrap checkout is not the repository root");
    }
    const status = await commandRunner(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd: sourceRoot, timeoutMs: 30_000 }
    );
    if (status.stdout.trim()) {
        throw new Error("Dashboard bootstrap requires a clean production checkout");
    }
    const identity = await commandRunner(
        "git",
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { cwd: sourceRoot, timeoutMs: 30_000 }
    );
    const commitSha = identity.stdout.trim();
    if (!FULL_COMMIT_PATTERN.test(commitSha)) {
        throw new Error("Dashboard bootstrap could not resolve a full lowercase Git SHA");
    }
    return commitSha;
}

async function verifyEnabledServices(
    commandRunner: ProductionBootstrapCommandRunner
): Promise<ProductionBootstrapResult["services"]> {
    const services: ProductionBootstrapResult["services"] = [];
    for (const name of MANAGED_DASHBOARD_UNIT_NAMES) {
        const enabled = await commandRunner(
            SYSTEMCTL_EXECUTABLE,
            ["--user", "is-enabled", name],
            { allowNonZeroExit: true, timeoutMs: 30_000 }
        );
        if (enabled.stdout.trim() !== "enabled") {
            throw new Error(`${name} was not persistently enabled`);
        }
        const state = await commandRunner(
            SYSTEMCTL_EXECUTABLE,
            [
                "--user",
                "show",
                name,
                "--property=ActiveState",
                "--property=Result",
                "--property=SubState",
                "--no-pager",
            ],
            { timeoutMs: 30_000 }
        );
        const properties = parseSystemdProperties(state.stdout);
        const activeState = properties.get("ActiveState") ?? "";
        const result = properties.get("Result") ?? "";
        const subState = properties.get("SubState") ?? "";
        if (
            activeState !== "active" ||
            subState !== "running" ||
            (result !== "" && result !== "success")
        ) {
            throw new Error(
                `${name} did not remain active after bootstrap (${activeState}/${subState}/${result})`
            );
        }
        services.push({
            activeState,
            enabled: true,
            name,
            subState,
        });
    }
    return services;
}

async function waitForEnabledServices(
    commandRunner: ProductionBootstrapCommandRunner,
    stabilizationMs: number
): Promise<ProductionBootstrapResult["services"]> {
    const deadline = Date.now() + stabilizationMs;
    while (true) {
        try {
            return await verifyEnabledServices(commandRunner);
        } catch (error) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw error;
            }
            await Bun.sleep(Math.min(SERVICE_POLL_INTERVAL_MS, remainingMs));
        }
    }
}

/**
 * Initializes and activates the first managed Dashboard release on a blank
 * production host. Re-running the same checkout is safe; using this command to
 * replace an existing different release is rejected.
 * @param options Test and one-shot dependency overrides.
 * @returns Activated release and service state.
 */
export async function bootstrapProductionDashboard(
    options: ProductionBootstrapOptions = {}
): Promise<ProductionBootstrapResult> {
    const environment = options.environment ?? process.env;
    assertBootstrapEnvironment(environment);
    const paths = options.paths ?? resolveDashboardProjectPaths(environment);
    const commandRunner = options.commandRunner ?? runProductionBootstrapCommand;
    const onProgress = options.onProgress;
    const stabilizationMs = assertServiceStabilizationMs(
        options.serviceStabilizationMs ?? DEFAULT_SERVICE_STABILIZATION_MS
    );

    await assertRealDirectory(paths.projectRoot, "Dashboard project root");
    await assertRealDirectory(paths.productionCheckoutRoot, "Production checkout");
    onProgress?.("Preparing managed production directories");
    for (const [directoryPath, mode] of [
        [paths.productionRoot, 0o755],
        [paths.developmentRoot, 0o755],
        [paths.developmentWorktreeRoot, 0o755],
        [paths.productionReleasesRoot, 0o755],
        [path.dirname(paths.productionBunRuntimeRoot), 0o755],
        [paths.productionBunRuntimeRoot, 0o755],
        [paths.productionStateRoot, 0o700],
        [paths.productionOpenClawHome, 0o700],
    ] as const) {
        await ensureRealDirectory(directoryPath, mode);
    }

    onProgress?.("Verifying clean production checkout");
    const commitSha = await resolveCheckoutCommit(
        paths.productionCheckoutRoot,
        commandRunner
    );
    const readReleaseSlots =
        options.readReleaseSlots ??
        (async () => {
            const state = await readDashboardReleaseState(paths.productionReleasesRoot);
            return {
                current: state.current?.commitSha,
                previous: state.previous?.commitSha,
            };
        });
    const slots = await readReleaseSlots();
    if (slots.previous && !slots.current) {
        throw new Error(
            "Dashboard bootstrap found an invalid previous release without current"
        );
    }
    if (slots.current && slots.current !== commitSha) {
        throw new Error(
            `Dashboard bootstrap refuses to replace existing release ${slots.current}; use the normal deployment path`
        );
    }

    onProgress?.("Initializing and verifying production SQLite");
    await (options.initializeDatabase ?? initializeProductionBootstrapDatabase)();

    onProgress?.("Staging the initial managed release");
    const stageRelease =
        options.stageRelease ??
        ((candidateCommit: string) =>
            stageDashboardRelease(candidateCommit, {
                onProgress,
                releasesRoot: paths.productionReleasesRoot,
                sourceRoot: paths.productionCheckoutRoot,
                worktreeRoot: paths.developmentWorktreeRoot,
            }));
    const release = await stageRelease(commitSha);
    if (release.commitSha !== commitSha) {
        throw new Error("Dashboard bootstrap staged an unexpected release");
    }

    onProgress?.("Activating release and reconciling managed systemd units");
    const activateRelease =
        options.activateRelease ??
        (async (candidateCommit: string) => {
            await runReleaseLifecycleCommand(
                ["activate", candidateCommit],
                paths.productionReleasesRoot
            );
        });
    await activateRelease(commitSha);

    onProgress?.("Enabling and restarting Dashboard services");
    await commandRunner(
        SYSTEMCTL_EXECUTABLE,
        ["--user", "enable", ...MANAGED_DASHBOARD_UNIT_NAMES],
        { timeoutMs: 90_000 }
    );
    await commandRunner(
        SYSTEMCTL_EXECUTABLE,
        ["--user", "restart", ...MANAGED_DASHBOARD_UNIT_NAMES],
        { timeoutMs: 90_000 }
    );
    const services = await waitForEnabledServices(commandRunner, stabilizationMs);
    onProgress?.("Dashboard production bootstrap completed");
    return {
        commitSha,
        databasePath: paths.productionDatabasePath,
        releasePath: release.path,
        services,
    };
}

if (import.meta.main) {
    try {
        if (Bun.argv.length > 2) {
            throw new TypeError("Usage: productionBootstrap.ts");
        }
        const result = await bootstrapProductionDashboard({
            onProgress: (message) => {
                process.stdout.write(`[bootstrap] ${message}\n`);
            },
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : "Dashboard production bootstrap failed"}\n`
        );
        process.exitCode = 1;
    }
}
