import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { runProcess } from "./lib/processes.ts";
import { resolveAbsoluteNonRootPath } from "./lib/safePath.ts";
import {
    type DashboardReleaseRetentionResult,
    ensureDashboardReleaseLayout,
    loadManagedRelease,
    type ManagedDashboardRelease,
    managedReleasePath,
    pruneDashboardReleases,
    resolveDashboardReleasesRoot,
} from "./releaseManager.ts";
import {
    loadReleaseManifest,
    RELEASE_MANIFEST_FILE_NAME,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./releaseManifest.ts";

const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const DEFAULT_DASHBOARD_SOURCE_ROOT = "/home/ubuntu/projects/mira-dashboard";
const DEFAULT_DASHBOARD_WORKTREE_ROOT = "/home/ubuntu/projects/mira-dashboard-worktrees";
const DEFAULT_DASHBOARD_STATE_ROOT = "/home/ubuntu/projects/mira-dashboard-state";
const DEFAULT_DASHBOARD_DATABASE_PATH = `${DEFAULT_DASHBOARD_STATE_ROOT}/mira-dashboard.db`;
const DEFAULT_DASHBOARD_OPENCLAW_HOME = `${DEFAULT_DASHBOARD_STATE_ROOT}/openclaw-client`;
const DEFAULT_DASHBOARD_LOG_ROTATION_LOCK_FILE = `${DEFAULT_DASHBOARD_STATE_ROOT}/log-rotation.lock`;
const MAX_PROCESS_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MANAGED_DASHBOARD_UNITS = {
    "mira-dashboard-worker.service": "dist/workerStart.js",
    "mira-dashboard.service": "dist/serverStart.js",
} as const;
export const MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT = [
    "MIRA_DASHBOARD_DB_PATH",
    "MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE",
    "MIRA_DASHBOARD_OPENCLAW_HOME",
    "MIRA_DASHBOARD_RELEASE_ROOT",
    "MIRA_DASHBOARD_RELEASES_ROOT",
] as const;

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
    commandRunner?: DashboardReleaseCommandRunner;
    databasePath?: string;
    onProgress?: (message: string) => void;
    openClawHome?: string;
    releasesRoot?: string;
    signal?: AbortSignal;
    sourceRoot?: string;
    worktreeRoot?: string;
}

export interface ManagedDashboardUnitContract {
    databasePath: string;
    logRotationLockFile: string;
    openClawHome: string;
    releaseRoot: string;
    releasesRoot: string;
}

type ManagedDashboardUnitName = keyof typeof MANAGED_DASHBOARD_UNITS;

function managedReleaseEnvironment(
    contract: ManagedDashboardUnitContract,
    releaseRoot: string
): NodeJS.ProcessEnv {
    return {
        ...process.env,
        MIRA_DASHBOARD_DB_PATH: contract.databasePath,
        MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE: contract.logRotationLockFile,
        MIRA_DASHBOARD_OPENCLAW_HOME: contract.openClawHome,
        MIRA_DASHBOARD_RELEASE_ROOT: releaseRoot,
        MIRA_DASHBOARD_RELEASES_ROOT: contract.releasesRoot,
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
        throw new AggregateError(
            [removeError, fallbackError],
            "Failed to remove release build worktree",
            { cause: fallbackError }
        );
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

async function syncFile(filePath: string): Promise<void> {
    const file = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        await file.sync();
    } finally {
        await file.close();
    }
}

async function syncDirectory(directoryPath: string): Promise<void> {
    const directory = await fsp.open(
        directoryPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
    );
    try {
        await directory.sync();
    } finally {
        await directory.close();
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

async function copyVerifiedRelease(
    buildRoot: string,
    commitSha: string,
    releasesRoot: string
): Promise<ManagedDashboardRelease> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    const finalPath = managedReleasePath(releasesRoot, commitSha);
    try {
        return await loadManagedRelease(releasesRoot, commitSha);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }

    const manifest = await loadReleaseManifest(buildRoot);
    await verifyReleaseArtifacts(buildRoot, manifest);
    await verifyReleaseBuildIdentities(buildRoot, manifest);
    if (manifest.commitSha !== commitSha) {
        throw new Error(
            `Built release identity ${manifest.commitSha} does not match ${commitSha}`
        );
    }

    const stagingPath = path.join(
        layout.releasesPath,
        `.staging-${commitSha}-${randomUUID()}`
    );
    await fsp.mkdir(stagingPath, { mode: 0o755 });
    try {
        const files = [
            ...manifest.artifacts.map((artifact) => artifact.path),
            RELEASE_MANIFEST_FILE_NAME,
        ];
        const createdDirectories = new Set<string>([stagingPath]);
        for (const relativePath of files) {
            const sourcePath = path.join(buildRoot, relativePath);
            const destinationPath = path.join(stagingPath, relativePath);
            const destinationDirectory = path.dirname(destinationPath);
            await fsp.mkdir(destinationDirectory, { mode: 0o755, recursive: true });
            for (
                let directory = destinationDirectory;
                directory.startsWith(`${stagingPath}${path.sep}`);
                directory = path.dirname(directory)
            ) {
                createdDirectories.add(directory);
            }
            await fsp.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
            await syncFile(destinationPath);
        }

        const stagedManifest = await loadReleaseManifest(stagingPath);
        await verifyReleaseArtifacts(stagingPath, stagedManifest);
        await verifyReleaseBuildIdentities(stagingPath, stagedManifest);
        if (stagedManifest.commitSha !== commitSha) {
            throw new Error(
                `Staged release identity ${stagedManifest.commitSha} does not match ${commitSha}`
            );
        }
        const deepestFirst = [...createdDirectories].toSorted(
            (left, right) => right.length - left.length
        );
        for (const directory of deepestFirst) {
            await syncDirectory(directory);
        }
        try {
            await fsp.rename(stagingPath, finalPath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST" && code !== "ENOTEMPTY") {
                throw error;
            }
            // A concurrent publisher may have won the same immutable SHA.
            // Accept it only after full manifest, artifact, and identity verification.
            const concurrentlyPublished = await loadManagedRelease(
                releasesRoot,
                commitSha
            );
            await fsp.rm(stagingPath, { recursive: true });
            await syncDirectory(layout.releasesPath);
            return concurrentlyPublished;
        }
        await syncDirectory(layout.releasesPath);
    } catch (error) {
        await fsp.rm(stagingPath, { force: true, recursive: true });
        throw error;
    }
    return loadManagedRelease(releasesRoot, commitSha);
}

export function managedDashboardUnitContract(
    releasesRoot = resolveDashboardReleasesRoot(),
    databasePath = process.env.MIRA_DASHBOARD_DB_PATH ?? DEFAULT_DASHBOARD_DATABASE_PATH,
    openClawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME ??
        DEFAULT_DASHBOARD_OPENCLAW_HOME
): ManagedDashboardUnitContract {
    const root = resolveAbsoluteNonRootPath(releasesRoot, "Dashboard releases root");
    return {
        databasePath: resolveAbsoluteNonRootPath(databasePath, "Dashboard database path"),
        logRotationLockFile: resolveAbsoluteNonRootPath(
            process.env.MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE ??
                DEFAULT_DASHBOARD_LOG_ROTATION_LOCK_FILE,
            "Dashboard log rotation lock file"
        ),
        openClawHome: resolveAbsoluteNonRootPath(openClawHome, "Dashboard OpenClaw home"),
        releaseRoot: path.join(root, "current"),
        releasesRoot: root,
    };
}

export function assertManagedDashboardUnitProperties(
    unit: ManagedDashboardUnitName,
    properties: string,
    contract = managedDashboardUnitContract()
): void {
    const expectedEnvironment = [
        `MIRA_DASHBOARD_DB_PATH=${contract.databasePath}`,
        `MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE=${contract.logRotationLockFile}`,
        `MIRA_DASHBOARD_OPENCLAW_HOME=${contract.openClawHome}`,
        `MIRA_DASHBOARD_RELEASE_ROOT=${contract.releaseRoot}`,
        `MIRA_DASHBOARD_RELEASES_ROOT=${contract.releasesRoot}`,
    ];
    const expectedWorkingDirectory = `${contract.releaseRoot}/backend`;
    const actual = new Map(
        properties
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const separator = line.indexOf("=");
                return separator === -1
                    ? [line, ""]
                    : [line.slice(0, separator), line.slice(separator + 1)];
            })
    );
    if (actual.get("WorkingDirectory") !== expectedWorkingDirectory) {
        throw new Error(
            `${unit} must run from managed current/backend before Dashboard deployment`
        );
    }
    const execStart = actual.get("ExecStart") ?? "";
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
    const releasesRoot = resolveAbsoluteNonRootPath(
        options.releasesRoot ?? resolveDashboardReleasesRoot(),
        "Dashboard releases root"
    );
    const commandRunner = options.commandRunner ?? defaultCommandRunner;
    const contract = managedDashboardUnitContract(
        releasesRoot,
        options.databasePath ??
            process.env.MIRA_DASHBOARD_DB_PATH ??
            DEFAULT_DASHBOARD_DATABASE_PATH,
        options.openClawHome
    );
    let existingRelease: ManagedDashboardRelease | undefined;
    try {
        existingRelease = await loadManagedRelease(releasesRoot, expectedCommit);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    if (existingRelease) {
        options.onProgress?.("Preflighting existing immutable release");
        await commandRunner("bun", ["dist/databasePreflight.js"], {
            cwd: path.join(existingRelease.path, "backend"),
            environment: managedReleaseEnvironment(contract, existingRelease.path),
            signal: options.signal,
            timeoutMs: 120_000,
        });
        return existingRelease;
    }

    const sourceRoot = resolveAbsoluteNonRootPath(
        options.sourceRoot ?? DEFAULT_DASHBOARD_SOURCE_ROOT,
        "Dashboard source root"
    );
    const worktreeRoot = resolveAbsoluteNonRootPath(
        options.worktreeRoot ?? DEFAULT_DASHBOARD_WORKTREE_ROOT,
        "Dashboard worktree root"
    );
    await assertRealDirectory(sourceRoot, "Dashboard source root");
    await assertRealDirectory(worktreeRoot, "Dashboard worktree root");
    const worktreePath = path.join(
        worktreeRoot,
        `release-${expectedCommit.slice(0, 12)}-${randomUUID()}`
    );
    const environment = managedReleaseEnvironment(contract, worktreePath);
    let isWorktreeCreated = false;
    let stagedRelease: ManagedDashboardRelease | undefined;
    let stagingError: unknown;
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

        options.onProgress?.("Installing frontend release dependencies");
        await commandRunner("bun", ["install", "--frozen-lockfile"], {
            cwd: worktreePath,
            environment,
            signal: options.signal,
            timeoutMs: 180_000,
        });
        options.onProgress?.("Installing backend release dependencies");
        await commandRunner("bun", ["install", "--frozen-lockfile"], {
            cwd: path.join(worktreePath, "backend"),
            environment,
            signal: options.signal,
            timeoutMs: 120_000,
        });
        options.onProgress?.("Building and preflighting release");
        await commandRunner("bun", ["run", "deploy:prepare"], {
            cwd: worktreePath,
            environment,
            signal: options.signal,
            timeoutMs: 12 * 60 * 1000,
        });
        options.onProgress?.("Publishing verified immutable release");
        stagedRelease = await copyVerifiedRelease(
            worktreePath,
            expectedCommit,
            contract.releasesRoot
        );
    } catch (error) {
        stagingError = error;
    }
    let cleanupError: unknown;
    try {
        await cleanupReleaseWorktree(
            commandRunner,
            sourceRoot,
            worktreePath,
            environment,
            isWorktreeCreated
        );
    } catch (error) {
        cleanupError = error;
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
    return pruneDashboardReleases(retainCount, releasesRoot);
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
        console.log(JSON.stringify(result));
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : "Release deployment failed"
        );
        process.exitCode = 1;
    }
}
