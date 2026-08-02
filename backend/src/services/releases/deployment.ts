import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { writeCliError, writeCliOutput } from "../../lib/cliOutput.ts";
import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { runProcess } from "../../lib/processes.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";
import { parseSystemdProperties } from "../../lib/systemdProperties.ts";
import type {
    DashboardReleaseRetentionResult,
    ManagedDashboardRelease,
} from "./managerModel.ts";
import {
    pruneDashboardReleases,
    publishVerifiedDashboardRelease,
} from "./managerOperations.ts";
import { loadManagedRelease, resolveDashboardReleasesRoot } from "./releaseLayout.ts";
import {
    bunExecutableRuntimeIdentity,
    installManagedBunRuntime,
    requireManagedBunRuntime,
    resolveDashboardReleaseBuildBunExecutable,
    resolveManagedBunRuntimeRoot,
} from "./runtime.ts";
import {
    MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT,
    MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT,
    MANAGED_DASHBOARD_UNIT_POLICY_ENVIRONMENT,
    MANAGED_DASHBOARD_UNITS,
    type ManagedDashboardUnitName,
} from "./systemdPolicy.ts";

const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const MAX_PROCESS_OUTPUT_BYTES = 20 * 1024 * 1024;
export {
    MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT,
    MANAGED_DASHBOARD_UNITS,
} from "./systemdPolicy.ts";

export interface DashboardReleaseCommandResult {
    stderr: string;
    stdout: string;
}

export type DashboardReleaseCommandRunner = (
    command: string,
    arguments_: readonly string[],
    options: {
        cwd: string;
        environment: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        timeoutMs: number;
    }
) => Promise<DashboardReleaseCommandResult>;

export interface StageDashboardReleaseOptions {
    bunExecutable?: string;
    cacheBunRuntime?: (sourceExecutable: string, version: string) => Promise<string>;
    commandRunner?: DashboardReleaseCommandRunner;
    onProgress?: (message: string) => void;
    releasesRoot?: string;
    resolveBunRuntime?: (version: string) => string;
    resolveBunRuntimeIdentity?: (executablePath: string) => string | undefined;
    signal?: AbortSignal;
    sourceRoot?: string;
    worktreeRoot?: string;
}

export interface ManagedDashboardUnitContract {
    databasePath: string;
    logRotationLockFile: string;
    openClawHome: string;
    previewRoot: string;
    previewWorktreePath: string;
    projectRoot: string;
    releaseRoot: string;
    releasesRoot: string;
    runtimeLauncher: string;
    sourceRoot: string;
    worktreeRoot: string;
}

const MANAGED_RELEASE_BUILD_ENVIRONMENT = [
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "TZ",
] as const;

function managedReleaseEnvironment(
    contract: ManagedDashboardUnitContract,
    bunExecutable: string
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of MANAGED_RELEASE_BUILD_ENVIRONMENT) {
        if (process.env[key] !== undefined) {
            environment[key] = process.env[key];
        }
    }
    if (path.isAbsolute(bunExecutable)) {
        const bunBinDirectory = path.dirname(bunExecutable);
        environment.PATH = [bunBinDirectory, environment.PATH]
            .filter(Boolean)
            .join(path.delimiter);
    }
    return {
        ...environment,
        MIRA_DASHBOARD_PROJECT_ROOT: contract.projectRoot,
        NODE_ENV: "production",
    };
}

function assertFullCommitSha(commitSha: string): string {
    if (!RELEASE_COMMIT_SHA_PATTERN.test(commitSha)) {
        throw new TypeError("Release staging requires a full lowercase Git SHA");
    }
    return commitSha;
}

function hasExactEnvironmentAssignment(
    serializedEnvironment: string,
    assignment: string
): boolean {
    const escaped = assignment.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    return new RegExp(String.raw`(?:^|[\s"])${escaped}(?=$|[\s"])`, "u").test(
        serializedEnvironment
    );
}

function hasExactSerializedToken(serializedValue: string, token: string): boolean {
    const escaped = token.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    return new RegExp(String.raw`(?:^|[\s";])${escaped}(?=$|[\s";])`, "u").test(
        serializedValue
    );
}

async function pathExists(candidatePath: string): Promise<boolean> {
    try {
        await fsp.lstat(candidatePath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function cleanupReleaseWorktree(
    commandRunner: DashboardReleaseCommandRunner,
    sourceRoot: string,
    worktreePath: string,
    environment: NodeJS.ProcessEnv,
    isWorktreeCreated: boolean
): Promise<void> {
    if (!isWorktreeCreated && !(await pathExists(worktreePath))) {
        return;
    }
    let removeError: unknown;
    try {
        await commandRunner("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: sourceRoot,
            environment,
            timeoutMs: 120_000,
        });
        return;
    } catch (error) {
        removeError = error;
    }
    try {
        await fsp.rm(worktreePath, { force: true, recursive: true });
        await commandRunner("git", ["worktree", "prune"], {
            cwd: sourceRoot,
            environment,
            timeoutMs: 30_000,
        });
    } catch (fallbackError) {
        const removalFailure = new AggregateError(
            [removeError, fallbackError],
            "Failed to remove release build worktree",
            { cause: removeError }
        );
        throw removalFailure;
    }
}

async function assertRealDirectory(directoryPath: string, label: string): Promise<void> {
    const stat = await fsp.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError(`${label} must be a real directory`);
    }
    if ((await fsp.realpath(directoryPath)) !== directoryPath) {
        throw new TypeError(`${label} must not traverse symlinks`);
    }
}

async function defaultCommandRunner(
    command: string,
    arguments_: readonly string[],
    options: {
        cwd: string;
        environment: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        timeoutMs: number;
    }
): Promise<DashboardReleaseCommandResult> {
    const result = await runProcess(command, arguments_, {
        cwd: options.cwd,
        env: options.environment,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    });
    if (result.code !== 0) {
        throw new Error(
            `${command} ${arguments_.join(" ")} failed with exit code ${
                result.code
            }: ${result.stderr.trim() || result.stdout.trim()}`
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

export function managedDashboardUnitContract(
    releasesRoot = resolveDashboardReleasesRoot()
): ManagedDashboardUnitContract {
    const projectPaths = resolveDashboardProjectPaths();
    const root = resolveAbsoluteNonRootPath(releasesRoot, "Dashboard releases root");
    return {
        databasePath: resolveAbsoluteNonRootPath(
            projectPaths.productionDatabasePath,
            "Dashboard database path"
        ),
        logRotationLockFile: resolveAbsoluteNonRootPath(
            projectPaths.productionLogRotationLockFile,
            "Dashboard log rotation lock file"
        ),
        openClawHome: resolveAbsoluteNonRootPath(
            projectPaths.productionOpenClawHome,
            "Dashboard OpenClaw home"
        ),
        previewRoot: resolveAbsoluteNonRootPath(
            projectPaths.developmentPreviewStateRoot,
            "Dashboard preview state root"
        ),
        previewWorktreePath: resolveAbsoluteNonRootPath(
            projectPaths.developmentPreviewRoot,
            "Dashboard preview worktree path"
        ),
        projectRoot: projectPaths.projectRoot,
        releaseRoot: path.join(root, "current"),
        releasesRoot: root,
        runtimeLauncher: path.join(
            root,
            "current",
            MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT
        ),
        sourceRoot: resolveAbsoluteNonRootPath(
            projectPaths.productionCheckoutRoot,
            "Dashboard source root"
        ),
        worktreeRoot: resolveAbsoluteNonRootPath(
            projectPaths.developmentWorktreeRoot,
            "Dashboard worktree root"
        ),
    };
}

export function assertManagedDashboardUnitProperties(
    unit: ManagedDashboardUnitName,
    properties: string,
    contract = managedDashboardUnitContract()
): void {
    const expectedEnvironment = [
        ...MANAGED_DASHBOARD_UNIT_POLICY_ENVIRONMENT[unit],
        `MIRA_DASHBOARD_PROJECT_ROOT=${contract.projectRoot}`,
    ];
    const expectedWorkingDirectory = `${contract.releaseRoot}/backend`;
    const actual = parseSystemdProperties(properties);
    if (actual.get("WorkingDirectory") !== expectedWorkingDirectory) {
        throw new Error(
            `${unit} must run from managed current/backend before Dashboard deployment`
        );
    }
    const execStart = actual.get("ExecStart") ?? "";
    if (!hasExactSerializedToken(execStart, contract.runtimeLauncher)) {
        throw new Error(`${unit} must use the managed Bun runtime launcher`);
    }
    if (!hasExactSerializedToken(execStart, MANAGED_DASHBOARD_UNITS[unit])) {
        throw new Error(`${unit} has an unexpected managed release entrypoint`);
    }
    const preservedEnvironment = `--preserve-env=${MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT.join(
        ","
    )}`;
    if (!hasExactSerializedToken(execStart, preservedEnvironment)) {
        throw new Error(
            `${unit} must preserve managed release environment through Doppler`
        );
    }
    const environment = actual.get("Environment") ?? "";
    const missingEnvironment = expectedEnvironment.filter(
        (entry) => !hasExactEnvironmentAssignment(environment, entry)
    );
    if (missingEnvironment.length > 0) {
        throw new Error(
            `${unit} is missing stable managed release environment: ${missingEnvironment
                .map((entry) => entry.slice(0, entry.indexOf("=")))
                .join(", ")}`
        );
    }
}

export async function stageDashboardRelease(
    commitSha: string,
    options: StageDashboardReleaseOptions = {}
): Promise<ManagedDashboardRelease> {
    const expectedCommit = assertFullCommitSha(commitSha);
    const bunExecutable =
        options.bunExecutable ?? resolveDashboardReleaseBuildBunExecutable();
    const bunRuntimeIdentity = (
        options.resolveBunRuntimeIdentity ?? bunExecutableRuntimeIdentity
    )(bunExecutable);
    if (!bunRuntimeIdentity) {
        throw new Error("Dashboard release build Bun identity is unavailable");
    }
    const releasesRoot = resolveAbsoluteNonRootPath(
        options.releasesRoot ?? resolveDashboardReleasesRoot(),
        "Dashboard releases root"
    );
    const commandRunner = options.commandRunner ?? defaultCommandRunner;
    const cacheBunRuntime = options.cacheBunRuntime ?? installManagedBunRuntime;
    const resolveBunRuntime = options.resolveBunRuntime ?? requireManagedBunRuntime;
    const projectPaths = resolveDashboardProjectPaths();
    const contract = managedDashboardUnitContract(releasesRoot);
    let existingRelease: ManagedDashboardRelease | undefined;
    try {
        existingRelease = await loadManagedRelease(releasesRoot, expectedCommit);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    if (existingRelease) {
        let releaseBunExecutable: string;
        try {
            releaseBunExecutable = resolveBunRuntime(existingRelease.manifest.bunVersion);
        } catch {
            await cacheBunRuntime(bunExecutable, existingRelease.manifest.bunVersion);
            releaseBunExecutable = resolveBunRuntime(existingRelease.manifest.bunVersion);
        }
        options.onProgress?.("Preflighting existing immutable release");
        await commandRunner(releaseBunExecutable, ["dist/databasePreflight.js"], {
            cwd: path.join(existingRelease.path, "backend"),
            environment: managedReleaseEnvironment(contract, releaseBunExecutable),
            signal: options.signal,
            timeoutMs: 120_000,
        });
        return existingRelease;
    }

    const sourceRoot = resolveAbsoluteNonRootPath(
        options.sourceRoot ?? projectPaths.productionCheckoutRoot,
        "Dashboard source root"
    );
    const worktreeRoot = resolveAbsoluteNonRootPath(
        options.worktreeRoot ?? projectPaths.developmentWorktreeRoot,
        "Dashboard worktree root"
    );
    await assertRealDirectory(sourceRoot, "Dashboard source root");
    await assertRealDirectory(worktreeRoot, "Dashboard worktree root");
    const worktreePath = path.join(
        worktreeRoot,
        `release-${expectedCommit.slice(0, 12)}-${randomUUID()}`
    );
    const environment = managedReleaseEnvironment(contract, bunExecutable);
    let isWorktreeCreated = false;
    let stagedRelease: ManagedDashboardRelease | undefined;
    let stagingError: Error | undefined;
    try {
        options.onProgress?.("Creating isolated release worktree");
        await commandRunner(
            "git",
            ["worktree", "add", "--detach", worktreePath, expectedCommit],
            {
                cwd: sourceRoot,
                environment,
                signal: options.signal,
                timeoutMs: 120_000,
            }
        );
        isWorktreeCreated = true;
        const identity = await commandRunner("git", ["rev-parse", "HEAD"], {
            cwd: worktreePath,
            environment,
            signal: options.signal,
            timeoutMs: 30_000,
        });
        if (identity.stdout.trim() !== expectedCommit) {
            throw new Error("Release worktree resolved an unexpected commit");
        }

        options.onProgress?.("Installing release dependencies");
        await commandRunner(bunExecutable, ["install", "--frozen-lockfile"], {
            cwd: worktreePath,
            environment,
            signal: options.signal,
            timeoutMs: 180_000,
        });
        options.onProgress?.("Building and preflighting release");
        await commandRunner(bunExecutable, ["run", "deploy:prepare"], {
            cwd: worktreePath,
            environment,
            signal: options.signal,
            timeoutMs: 12 * 60 * 1000,
        });
        options.onProgress?.("Caching release Bun runtime");
        options.onProgress?.("Publishing verified immutable release");
        stagedRelease = await publishVerifiedDashboardRelease(
            worktreePath,
            expectedCommit,
            contract.releasesRoot,
            {
                prepareManifest: async (manifest) => {
                    if (manifest.bunVersion !== bunRuntimeIdentity) {
                        throw new Error(
                            `Built release requires Bun ${manifest.bunVersion}, expected ${bunRuntimeIdentity}`
                        );
                    }
                    await cacheBunRuntime(bunExecutable, manifest.bunVersion);
                },
            }
        );
    } catch (error) {
        stagingError =
            error instanceof Error
                ? error
                : new Error("Release staging failed", { cause: error });
    }
    let cleanupError: Error | undefined;
    try {
        await cleanupReleaseWorktree(
            commandRunner,
            sourceRoot,
            worktreePath,
            environment,
            isWorktreeCreated
        );
    } catch (error) {
        cleanupError =
            error instanceof Error
                ? error
                : new Error("Release worktree cleanup failed", { cause: error });
    }
    if (stagingError !== undefined) {
        if (cleanupError !== undefined) {
            throw new AggregateError(
                [stagingError, cleanupError],
                "Release staging and worktree cleanup both failed",
                { cause: stagingError }
            );
        }
        throw stagingError;
    }
    if (cleanupError !== undefined) {
        throw cleanupError;
    }
    if (!stagedRelease) {
        throw new Error("Release staging completed without a published release");
    }
    return stagedRelease;
}

export async function prunePublishedDashboardReleases(
    retainCount = 3,
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseRetentionResult> {
    const productionReleasesRoot = resolveDashboardProjectPaths().productionReleasesRoot;
    const runtimeRoot =
        path.resolve(releasesRoot) === path.resolve(productionReleasesRoot)
            ? resolveManagedBunRuntimeRoot()
            : undefined;
    return pruneDashboardReleases(retainCount, releasesRoot, runtimeRoot);
}

export async function runReleaseDeploymentCommand(
    arguments_: string[],
    releasesRoot = resolveDashboardReleasesRoot()
) {
    const [command, value, ...extra] = arguments_;
    if (extra.length > 0) {
        throw new TypeError("Release deployment command received unexpected arguments");
    }
    if (command === "stage") {
        if (!value) {
            throw new TypeError("Release deployment stage requires a commit SHA");
        }
        const release = await stageDashboardRelease(value, { releasesRoot });
        return {
            commitSha: release.commitSha,
            commitTitle: release.manifest.commitTitle,
            path: release.path,
        };
    }
    if (command === "prune") {
        const retainCount = value === undefined ? 3 : Number(value);
        return prunePublishedDashboardReleases(retainCount, releasesRoot);
    }
    throw new TypeError(
        "Usage: releaseDeployment.ts <stage COMMIT_SHA|prune [RETAIN_COUNT]>"
    );
}

if (import.meta.main) {
    try {
        const result = await runReleaseDeploymentCommand(Bun.argv.slice(2));
        writeCliOutput(JSON.stringify(result));
    } catch (error) {
        writeCliError(
            error instanceof Error ? error.message : "Release deployment failed"
        );
        process.exitCode = 1;
    }
}
