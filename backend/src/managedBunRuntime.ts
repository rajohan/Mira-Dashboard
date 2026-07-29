import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveDashboardProjectPaths } from "./lib/dashboardPaths.ts";
import { resolveAbsoluteNonRootPath } from "./lib/safePath.ts";

const BUN_RUNTIME_VERSION_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][\dA-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][\dA-Za-z-]*)))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;
const BUN_RUNTIME_VERSION_MAX_LENGTH = 64;
const RUNTIME_CHECK_TIMEOUT_MS = 5000;

export interface ManagedBunRuntimeInstallOptions {
    runtimeRoot?: string;
}

/**
 * Accepts only bounded, complete semantic versions that are safe as path segments.
 * @param value Candidate Bun version.
 * @returns Whether the candidate is a strict Bun runtime version.
 */
export function isBunRuntimeVersion(value: string): boolean {
    if (
        !value ||
        value.length > BUN_RUNTIME_VERSION_MAX_LENGTH ||
        !BUN_RUNTIME_VERSION_PATTERN.test(value)
    ) {
        return false;
    }
    try {
        return Bun.semver.order(value, value) === 0;
    } catch {
        return false;
    }
}

function assertBunRuntimeVersion(value: string): string {
    if (!isBunRuntimeVersion(value)) {
        throw new TypeError("Managed Bun runtime version must be valid semver");
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

/**
 * Reads a Bun executable's strict version without inheriting application secrets.
 * @param executablePath Absolute executable path.
 * @param argument Bun identity flag.
 * @returns Reported Bun version, or undefined when verification fails.
 */
function bunExecutableReportedIdentity(
    executablePath: string,
    argument: "--revision" | "--version"
): string | undefined {
    if (!isCanonicalRegularExecutable(executablePath)) {
        return undefined;
    }
    const result = spawnSync(executablePath, [argument], {
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
    return bunExecutableReportedIdentity(executablePath, "--revision");
}

/**
 * Returns the revision-qualified identity of the Bun process running Dashboard.
 * @returns Current exact Bun runtime identity.
 */
export function currentBunRuntimeIdentity(): string {
    const identity = bunExecutableRuntimeIdentity(process.execPath);
    if (!identity) {
        throw new Error("Current Bun runtime identity is unavailable");
    }
    return identity;
}

/**
 * Checks an executable against either a revision-qualified or legacy version identity.
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
    return (
        bunExecutableRuntimeIdentity(executablePath) === identity ||
        bunExecutableReportedIdentity(executablePath, "--version") === identity
    );
}

/**
 * Checks whether an identity matches the Bun process running Dashboard.
 * @param identity Release-manifest Bun identity.
 * @returns Whether the current process satisfies the exact or legacy identity.
 */
export function isCurrentBunRuntime(identity: string): boolean {
    return bunExecutableMatchesRuntime(process.execPath, identity);
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
    if (fs.existsSync(destinationPath)) {
        throw new Error(`Managed Bun runtime ${expectedVersion} is invalid`);
    }

    await fsp.mkdir(runtimeRoot, { mode: 0o700, recursive: true });
    await assertRealDirectory(runtimeRoot, "Managed Bun runtime root");
    await fsp.mkdir(versionDirectory, { mode: 0o700, recursive: true });
    await assertRealDirectory(versionDirectory, "Managed Bun runtime version directory");

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
                !hasManagedBunRuntime(expectedVersion, runtimeRoot)
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
