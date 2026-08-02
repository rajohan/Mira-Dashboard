import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";

const BUN_RUNTIME_VERSION_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][\dA-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][\dA-Za-z-]*)))*)?\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*$/u;
const BUN_RUNTIME_VERSION_MAX_LENGTH = 64;
const RETIRED_RUNTIME_DIRECTORY_PATTERN =
    /^\.retired-[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const RUNTIME_CHECK_TIMEOUT_MS = 5000;
let currentRuntimeIdentity: string | undefined;

export interface ManagedBunRuntimeInstallOptions {
    runtimeRoot?: string;
}

export interface ManagedBunRuntimePruneResult {
    removed: string[];
    retained: string[];
    warnings: string[];
}

/**
 * Accepts only bounded, revision-qualified semantic versions that are safe as
 * path segments.
 * @param value Candidate Bun version.
 * @returns Whether the candidate is a strict Bun runtime version.
 */
export function isBunRuntimeVersion(value: string): boolean {
    return (
        value.length > 0 &&
        value.length <= BUN_RUNTIME_VERSION_MAX_LENGTH &&
        BUN_RUNTIME_VERSION_PATTERN.test(value)
    );
}

function assertBunRuntimeVersion(value: string): string {
    if (!isBunRuntimeVersion(value)) {
        throw new TypeError(
            "Managed Bun runtime version must be revision-qualified semver"
        );
    }
    return value;
}

/**
 * Resolves the host-owned directory containing versioned Bun runtimes.
 * @param runtimeRoot Optional runtime-root override for tests and one-shot tooling.
 * @returns Absolute managed Bun runtime root.
 */
export function resolveManagedBunRuntimeRoot(
    runtimeRoot = resolveDashboardProjectPaths().productionBunRuntimeRoot
): string {
    return resolveAbsoluteNonRootPath(runtimeRoot, "Managed Bun runtime root");
}

/**
 * Resolves the host bootstrap Bun used to install and build a candidate release.
 * The active worker may run an older release-specific Bun, so process.execPath is
 * intentionally not the default.
 * @param environment Process environment with an optional explicit executable.
 * @returns Absolute candidate-build Bun executable path.
 */
export function resolveDashboardReleaseBuildBunExecutable(
    environment: NodeJS.ProcessEnv = process.env
): string {
    const configured = environment.MIRA_DASHBOARD_DEPLOY_BUN_EXECUTABLE?.trim();
    const homeDirectory = environment.HOME?.trim() || homedir();
    return resolveAbsoluteNonRootPath(
        configured || path.join(homeDirectory, ".bun", "bin", "bun"),
        "Dashboard release build Bun executable"
    );
}

/**
 * Resolves the exact executable path for one Bun version.
 * @param version Exact Bun runtime version.
 * @param runtimeRoot Optional managed runtime root.
 * @returns Absolute managed Bun executable path.
 */
export function managedBunRuntimeExecutablePath(
    version: string,
    runtimeRoot = resolveManagedBunRuntimeRoot()
): string {
    return path.join(
        resolveManagedBunRuntimeRoot(runtimeRoot),
        assertBunRuntimeVersion(version),
        "bun"
    );
}

function isCanonicalRegularExecutable(filePath: string): boolean {
    try {
        const stat = fs.lstatSync(filePath);
        return (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            (stat.mode & 0o111) !== 0 &&
            fs.realpathSync(filePath) === filePath
        );
    } catch {
        return false;
    }
}

function isSingleLinkRegularExecutable(filePath: string): boolean {
    try {
        return (
            isCanonicalRegularExecutable(filePath) && fs.lstatSync(filePath).nlink === 1
        );
    } catch {
        return false;
    }
}

function readBunRevisionIdentity(executablePath: string): string | undefined {
    if (!isCanonicalRegularExecutable(executablePath)) {
        return undefined;
    }
    const result = spawnSync(executablePath, ["--revision"], {
        encoding: "utf8",
        env: {
            LANG: "C",
            PATH: "/usr/bin:/bin",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RUNTIME_CHECK_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
        return undefined;
    }
    const version = result.stdout.trim();
    return isBunRuntimeVersion(version) ? version : undefined;
}

/**
 * Reads the revision-qualified identity of a Bun executable.
 * @param executablePath Absolute executable path.
 * @returns Revision-qualified Bun identity, or undefined when verification fails.
 */
export function bunExecutableRuntimeIdentity(executablePath: string): string | undefined {
    return readBunRevisionIdentity(executablePath);
}

/**
 * Returns the revision-qualified identity of the Bun process running Dashboard.
 * @returns Current exact Bun runtime identity.
 */
export function currentBunRuntimeIdentity(): string {
    const identity =
        currentRuntimeIdentity ??
        (currentRuntimeIdentity = bunExecutableRuntimeIdentity(process.execPath));
    if (!identity) {
        throw new Error("Current Bun runtime identity is unavailable");
    }
    return identity;
}

/**
 * Checks an executable against its revision-qualified release identity.
 * @param executablePath Absolute executable path.
 * @param identity Release-manifest Bun identity.
 * @returns Whether the executable exactly satisfies the release identity.
 */
export function bunExecutableMatchesRuntime(
    executablePath: string,
    identity: string
): boolean {
    if (!isBunRuntimeVersion(identity)) {
        return false;
    }
    return bunExecutableRuntimeIdentity(executablePath) === identity;
}

/**
 * Checks whether an identity matches the Bun process running Dashboard.
 * @param identity Release-manifest Bun identity.
 * @returns Whether the current process satisfies the exact identity.
 */
export function isCurrentBunRuntime(identity: string): boolean {
    if (!isBunRuntimeVersion(identity)) {
        return false;
    }
    return identity === currentBunRuntimeIdentity();
}

/**
 * Checks whether an exact, canonical managed Bun runtime is available.
 * @param version Exact Bun runtime version.
 * @param runtimeRoot Optional managed runtime root.
 * @returns Whether the verified runtime is available.
 */
export function hasManagedBunRuntime(
    version: string,
    runtimeRoot = resolveManagedBunRuntimeRoot()
): boolean {
    if (!isBunRuntimeVersion(version)) {
        return false;
    }
    const executablePath = managedBunRuntimeExecutablePath(version, runtimeRoot);
    return (
        isSingleLinkRegularExecutable(executablePath) &&
        bunExecutableMatchesRuntime(executablePath, version)
    );
}

/**
 * Requires the exact managed runtime selected by a release manifest.
 * @param version Exact Bun runtime version.
 * @param runtimeRoot Optional managed runtime root.
 * @returns Absolute verified runtime path.
 */
export function requireManagedBunRuntime(
    version: string,
    runtimeRoot = resolveManagedBunRuntimeRoot()
): string {
    const executablePath = managedBunRuntimeExecutablePath(version, runtimeRoot);
    if (
        !isSingleLinkRegularExecutable(executablePath) ||
        !bunExecutableMatchesRuntime(executablePath, version)
    ) {
        throw new Error(`Managed Bun runtime ${version} is not available`);
    }
    return executablePath;
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

async function syncFile(filePath: string): Promise<void> {
    const file = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        await file.sync();
    } finally {
        await file.close();
    }
}

function isSameFileInode(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

async function recoverInterruptedRuntimeInstall(
    destinationPath: string,
    versionDirectory: string,
    expectedVersion: string
): Promise<boolean> {
    let destinationStat: fs.BigIntStats;
    try {
        destinationStat = await fsp.lstat(destinationPath, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
    if (
        !destinationStat.isFile() ||
        destinationStat.isSymbolicLink() ||
        (destinationStat.mode & 0o111n) === 0n ||
        (await fsp.realpath(destinationPath)) !== destinationPath ||
        !bunExecutableMatchesRuntime(destinationPath, expectedVersion)
    ) {
        return false;
    }
    let removedStagingLink = false;
    for (const entry of await fsp.readdir(versionDirectory, { withFileTypes: true })) {
        if (!entry.name.startsWith(".staging-") || !entry.isFile()) {
            continue;
        }
        const stagingPath = path.join(versionDirectory, entry.name);
        let stagingStat: fs.BigIntStats;
        try {
            stagingStat = await fsp.lstat(stagingPath, { bigint: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                continue;
            }
            throw error;
        }
        if (
            stagingStat.isSymbolicLink() ||
            stagingStat.dev !== destinationStat.dev ||
            stagingStat.ino !== destinationStat.ino
        ) {
            continue;
        }
        await fsp.unlink(stagingPath);
        removedStagingLink = true;
    }
    if (removedStagingLink) {
        await syncDirectory(versionDirectory);
    }
    return hasManagedBunRuntime(expectedVersion, path.dirname(versionDirectory));
}

/**
 * Atomically caches one verified Bun executable for release and rollback use.
 * @param sourceExecutable Absolute source executable.
 * @param version Expected exact Bun version.
 * @param options Managed runtime installation options.
 * @returns Promise resolving to the installed executable path.
 */
export async function installManagedBunRuntime(
    sourceExecutable: string,
    version: string,
    options: ManagedBunRuntimeInstallOptions = {}
): Promise<string> {
    const expectedVersion = assertBunRuntimeVersion(version);
    const sourcePath = resolveAbsoluteNonRootPath(
        sourceExecutable,
        "Bun runtime source executable"
    );
    if (!bunExecutableMatchesRuntime(sourcePath, expectedVersion)) {
        throw new Error(
            `Bun runtime source does not report expected version ${expectedVersion}`
        );
    }

    const runtimeRoot = resolveManagedBunRuntimeRoot(options.runtimeRoot);
    const versionDirectory = path.join(runtimeRoot, expectedVersion);
    const destinationPath = managedBunRuntimeExecutablePath(expectedVersion, runtimeRoot);
    if (hasManagedBunRuntime(expectedVersion, runtimeRoot)) {
        return destinationPath;
    }

    await fsp.mkdir(runtimeRoot, { mode: 0o700, recursive: true });
    await assertRealDirectory(runtimeRoot, "Managed Bun runtime root");
    await fsp.mkdir(versionDirectory, { mode: 0o700, recursive: true });
    await assertRealDirectory(versionDirectory, "Managed Bun runtime version directory");
    if (fs.existsSync(destinationPath)) {
        if (
            await recoverInterruptedRuntimeInstall(
                destinationPath,
                versionDirectory,
                expectedVersion
            )
        ) {
            return destinationPath;
        }
        throw new Error(`Managed Bun runtime ${expectedVersion} is invalid`);
    }

    const stagingPath = path.join(
        versionDirectory,
        `.staging-${process.pid}-${Bun.randomUUIDv7()}`
    );
    try {
        await fsp.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
        await fsp.chmod(stagingPath, 0o700);
        await syncFile(stagingPath);
        if (!bunExecutableMatchesRuntime(stagingPath, expectedVersion)) {
            throw new Error(
                `Staged Bun runtime does not report expected version ${expectedVersion}`
            );
        }
        try {
            await fsp.link(stagingPath, destinationPath);
        } catch (error) {
            if (
                (error as NodeJS.ErrnoException).code !== "EEXIST" ||
                !(await recoverInterruptedRuntimeInstall(
                    destinationPath,
                    versionDirectory,
                    expectedVersion
                ))
            ) {
                throw error;
            }
        }
        await syncDirectory(versionDirectory);
    } finally {
        await fsp.rm(stagingPath, { force: true });
        await syncDirectory(versionDirectory);
    }
    if (!hasManagedBunRuntime(expectedVersion, runtimeRoot)) {
        throw new Error(`Managed Bun runtime ${expectedVersion} installation failed`);
    }
    return destinationPath;
}

/**
 * Removes exact Bun runtimes that are no longer referenced by retained releases.
 * Interrupted retired directories are recovered before the operation returns.
 * @param referencedVersions Runtime identities referenced by retained manifests.
 * @param runtimeRoot Optional managed runtime root.
 * @returns Removed, retained, and skipped runtime identities.
 */
export async function pruneManagedBunRuntimes(
    referencedVersions: Iterable<string>,
    runtimeRoot = resolveManagedBunRuntimeRoot()
): Promise<ManagedBunRuntimePruneResult> {
    const referenced = new Set(referencedVersions);
    for (const version of referenced) {
        assertBunRuntimeVersion(version);
    }

    const root = resolveManagedBunRuntimeRoot(runtimeRoot);
    if (!fs.existsSync(root)) {
        if (referenced.size > 0) {
            throw new Error("Managed Bun runtime root is unavailable");
        }
        return { removed: [], retained: [], warnings: [] };
    }
    await assertRealDirectory(root, "Managed Bun runtime root");

    const versionDirectories = new Map<string, { path: string; stat: fs.BigIntStats }>();
    const retiredDirectories: Array<{ path: string; stat: fs.BigIntStats }> = [];
    const warnings: string[] = [];
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isSymbolicLink()) {
            throw new TypeError(
                `Managed Bun runtime entry must not be a symbolic link: ${entry.name}`
            );
        }
        if (RETIRED_RUNTIME_DIRECTORY_PATTERN.test(entry.name)) {
            if (!entry.isDirectory()) {
                throw new TypeError(
                    `Retired Bun runtime entry must be a real directory: ${entry.name}`
                );
            }
            retiredDirectories.push({
                path: entryPath,
                stat: await fsp.lstat(entryPath, { bigint: true }),
            });
            continue;
        }
        if (!isBunRuntimeVersion(entry.name)) {
            warnings.push(`Skipped unrecognized managed Bun runtime entry ${entry.name}`);
            continue;
        }
        if (!entry.isDirectory() || (await fsp.realpath(entryPath)) !== entryPath) {
            throw new TypeError(
                `Managed Bun runtime version must be a real directory: ${entry.name}`
            );
        }
        versionDirectories.set(entry.name, {
            path: entryPath,
            stat: await fsp.lstat(entryPath, { bigint: true }),
        });
    }

    for (const version of referenced) {
        if (!versionDirectories.has(version) || !hasManagedBunRuntime(version, root)) {
            throw new Error(
                `Retained release requires unavailable managed Bun runtime ${version}`
            );
        }
    }

    let hasFilesystemChanges = false;
    for (const retired of retiredDirectories) {
        const currentStat = await fsp.lstat(retired.path, { bigint: true });
        if (
            !currentStat.isDirectory() ||
            currentStat.isSymbolicLink() ||
            !isSameFileInode(retired.stat, currentStat)
        ) {
            throw new Error(
                `Retired managed Bun runtime changed before cleanup: ${path.basename(
                    retired.path
                )}`
            );
        }
        await fsp.rm(retired.path, { recursive: true });
        hasFilesystemChanges = true;
    }

    const removed: string[] = [];
    for (const [version, directory] of versionDirectories) {
        if (referenced.has(version)) {
            continue;
        }
        const currentStat = await fsp.lstat(directory.path, { bigint: true });
        if (
            !currentStat.isDirectory() ||
            currentStat.isSymbolicLink() ||
            !isSameFileInode(directory.stat, currentStat)
        ) {
            throw new Error(
                `Managed Bun runtime changed before retention cleanup: ${version}`
            );
        }
        const retiredPath = path.join(root, `.retired-${Bun.randomUUIDv7()}`);
        await fsp.rename(directory.path, retiredPath);
        await syncDirectory(root);
        const retiredStat = await fsp.lstat(retiredPath, { bigint: true });
        if (
            !retiredStat.isDirectory() ||
            retiredStat.isSymbolicLink() ||
            !isSameFileInode(currentStat, retiredStat)
        ) {
            throw new Error(
                `Managed Bun runtime changed during retention cleanup: ${version}`
            );
        }
        await fsp.rm(retiredPath, { recursive: true });
        hasFilesystemChanges = true;
        removed.push(version);
    }
    if (hasFilesystemChanges) {
        await syncDirectory(root);
    }

    return {
        removed: removed.toSorted(),
        retained: [...referenced].toSorted(),
        warnings: warnings.toSorted(),
    };
}
