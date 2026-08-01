import FS from "node:fs";
import os from "node:os";
import Path from "node:path";

import { guardedPath, mkdirGuarded } from "../../lib/guardedOps.ts";
import { safePathWithinRoot } from "../../lib/safePath.ts";

export { prepareSafeWriteTargetWithinRoot as prepareAgentMetadataDirectoryForWrite } from "../../lib/safePath.ts";

export interface ActivityLogRoot {
    directory: string;
    recursive: boolean;
}

function defaultOpenclawRoot(): string {
    return Path.join(process.cwd(), "data", "openclaw");
}

function resolveOpenclawRoot(): string {
    const configuredRoot = process.env.OPENCLAW_HOME?.trim();
    if (configuredRoot) {
        const resolved = Path.resolve(configuredRoot);
        return Path.isAbsolute(configuredRoot) && Path.parse(resolved).root !== resolved
            ? resolved
            : defaultOpenclawRoot();
    }

    const rawHomeDirectory = process.env.HOME?.trim() || os.homedir().trim();
    const homeDirectory = Path.resolve(rawHomeDirectory);
    if (
        rawHomeDirectory.length === 0 ||
        !Path.isAbsolute(rawHomeDirectory) ||
        Path.parse(homeDirectory).root === homeDirectory
    ) {
        return defaultOpenclawRoot();
    }
    return Path.join(homeDirectory, ".openclaw");
}

const hasProcfsAvailabilityProbe = (): boolean =>
    process.platform === "linux" && FS.existsSync("/proc/self/fd");

export function getOpenclawRoot(): string {
    return resolveOpenclawRoot();
}

export function getAgentsDirectory(): string {
    return Path.join(getOpenclawRoot(), "agents");
}

export function isProcfsAvailable(): boolean {
    return hasProcfsAvailabilityProbe();
}

function isValidChildDirectoryName(name: string): boolean {
    return (
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= 64 &&
        name !== "." &&
        name !== ".." &&
        SAFE_AGENT_ID_RE.test(name)
    );
}

export function mkdirChildDirectoryFromVerifiedParent(
    parent: string,
    childName: string
): void {
    if (!isValidChildDirectoryName(childName)) {
        throw Object.assign(new Error("Invalid child directory name"), {
            code: "EINVAL",
        });
    }

    if (!isProcfsAvailable()) {
        throw Object.assign(
            new Error("Verified child directory creation is not supported"),
            { code: "ENOTSUP" }
        );
    }

    const parentFd = FS.openSync(
        Buffer.from(parent),
        FS.constants.O_DIRECTORY | FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
    );
    try {
        const fdPath = Path.join("/proc/self/fd", String(parentFd), childName);
        try {
            FS.mkdirSync(Buffer.from(fdPath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
    } finally {
        FS.closeSync(parentFd);
    }
}

export function realExistingChildDirectoryFromVerifiedParent(
    parent: string,
    childName: string
): string {
    if (!isValidChildDirectoryName(childName)) {
        throw Object.assign(new Error("Invalid child directory name"), {
            code: "EINVAL",
        });
    }

    const childPath = Path.join(parent, childName);
    const parentFd = FS.openSync(
        Buffer.from(parent),
        FS.constants.O_DIRECTORY | FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
    );
    try {
        const openedParentStat = FS.fstatSync(parentFd);
        const realParent = FS.realpathSync(parent);
        const realParentStat = FS.statSync(realParent);
        if (
            openedParentStat.dev !== realParentStat.dev ||
            openedParentStat.ino !== realParentStat.ino
        ) {
            throw Object.assign(new Error("Parent path validation failed"), {
                code: "EACCES",
            });
        }
        const realChild = FS.realpathSync(childPath);
        const relativeChild = Path.relative(realParent, realChild);
        if (
            relativeChild === ".." ||
            relativeChild.length === 0 ||
            relativeChild.startsWith(`..${Path.sep}`) ||
            Path.isAbsolute(relativeChild)
        ) {
            throw Object.assign(new Error("Child path escapes parent directory"), {
                code: "EACCES",
            });
        }
        if (!FS.statSync(realChild).isDirectory()) {
            throw Object.assign(new Error("Child directory is not a directory"), {
                code: "ENOTDIR",
            });
        }
        return realChild;
    } finally {
        FS.closeSync(parentFd);
    }
}

export function assertOpenedDirectoryMatches(
    parentFd: number,
    realDirectory: string
): void {
    const openedStat = FS.fstatSync(parentFd);
    const realDirectoryStat = FS.statSync(realDirectory);
    if (
        openedStat.dev !== realDirectoryStat.dev ||
        openedStat.ino !== realDirectoryStat.ino ||
        !openedStat.isDirectory()
    ) {
        throw Object.assign(new Error("Directory path validation failed"), {
            code: "EACCES",
        });
    }
}

/** Matches agent ids that are safe to use as path segments. */
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9._-]+$/u;

/**
 * Returns whether an agent id is safe for filesystem-backed agent metadata paths.
 * @param id Resource identifier.
 * @returns Whether an agent id is safe for filesystem-backed agent metadata paths.
 */
export function isValidAgentId(id: string): boolean {
    return isValidChildDirectoryName(id);
}

function getRealAgentsDirectory(): string | undefined {
    try {
        return FS.realpathSync(getAgentsDirectory());
    } catch {
        return undefined;
    }
}

export function ensureRealAgentsDirectory(): string | undefined {
    try {
        const agentsDirectory = getAgentsDirectory();
        const realAgentsDirectory = FS.realpathSync(agentsDirectory);
        const agentsDirectoryStat = FS.statSync(realAgentsDirectory);
        if (!agentsDirectoryStat.isDirectory()) {
            return undefined;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return undefined;
        }
        mkdirGuarded(guardedPath(getAgentsDirectory()), { recursive: true });
    }

    return getRealAgentsDirectory();
}

/**
 * Returns the canonical sessions directory for a validated agent id.
 * @param agentId Agent identifier.
 * @returns the canonical sessions directory for a validated agent id.
 */
export function getSafeAgentSessionsDirectory(agentId: string): string | undefined {
    if (!isValidAgentId(agentId)) {
        return undefined;
    }

    const agentsDirectory = getAgentsDirectory();
    const sessionsDirectory = safePathWithinRoot(
        Path.join(agentId, "sessions"),
        agentsDirectory
    );
    if (!sessionsDirectory) {
        return undefined;
    }

    try {
        const realAgentsDirectory = getRealAgentsDirectory();
        if (!realAgentsDirectory) {
            return undefined;
        }
        const expectedSessionsDirectory = Path.join(agentsDirectory, agentId, "sessions");
        const canonicalExpectedSessionsDirectory = Path.join(
            realAgentsDirectory,
            agentId,
            "sessions"
        );
        const realExpectedSessionsDirectory = FS.realpathSync(expectedSessionsDirectory);
        const realSessionsDirectory = FS.realpathSync(sessionsDirectory);
        return realSessionsDirectory === realExpectedSessionsDirectory &&
            realExpectedSessionsDirectory === canonicalExpectedSessionsDirectory
            ? realSessionsDirectory
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Returns activity log roots for an agent, including Codex-native rollout logs.
 * @param agentId Agent identifier.
 * @returns activity log roots for an agent, including Codex-native rollout logs.
 */
export function getSafeAgentActivityRoots(agentId: string): ActivityLogRoot[] {
    if (!isValidAgentId(agentId)) {
        return [];
    }

    const roots = [
        { relative: Path.join(agentId, "sessions"), recursive: false },
        {
            relative: Path.join(agentId, "agent", "codex-home", "sessions"),
            recursive: true,
        },
    ];

    const realAgentsDirectory = getRealAgentsDirectory();
    if (!realAgentsDirectory) {
        return [];
    }
    return roots.flatMap((root) => {
        const rootDirectory = safePathWithinRoot(root.relative, getAgentsDirectory());
        if (!rootDirectory) {
            return [];
        }

        try {
            const expected = Path.join(realAgentsDirectory, root.relative);
            const realRootDirectory = FS.realpathSync(rootDirectory);
            return realRootDirectory === expected
                ? [{ directory: realRootDirectory, recursive: root.recursive }]
                : [];
        } catch {
            return [];
        }
    });
}

// Activity thresholds (in milliseconds)
