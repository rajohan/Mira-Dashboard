import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";

const BUN_RUNTIME_VERSION_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][\dA-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][\dA-Za-z-]*)))*)?\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*$/u;
const BUN_RUNTIME_VERSION_MAX_LENGTH = 64;
const RUNTIME_CHECK_TIMEOUT_MS = 5000;
let currentRuntimeIdentity: string | undefined;

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
