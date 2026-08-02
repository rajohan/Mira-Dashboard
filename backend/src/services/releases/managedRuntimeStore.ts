import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";
import {
    bunExecutableMatchesRuntime,
    hasManagedBunRuntime,
    isBunRuntimeVersion,
    managedBunRuntimeExecutablePath,
    resolveManagedBunRuntimeRoot,
} from "./runtime.ts";

const RETIRED_RUNTIME_DIRECTORY_PATTERN =
    /^\.retired-[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

export interface ManagedBunRuntimeInstallOptions {
    runtimeRoot?: string;
}

export interface ManagedBunRuntimePruneResult {
    removed: string[];
    retained: string[];
    warnings: string[];
}

function assertBunRuntimeVersion(value: string): string {
    if (!isBunRuntimeVersion(value)) {
        throw new TypeError(
            "Managed Bun runtime version must be revision-qualified semver"
        );
    }
    return value;
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
