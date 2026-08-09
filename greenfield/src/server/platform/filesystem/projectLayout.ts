import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Stable host paths derived from one Dashboard project root. */
export interface DashboardProjectLayout {
    readonly development: {
        readonly root: string;
        readonly state: string;
        readonly worktrees: string;
    };
    readonly production: {
        readonly checkout: string;
        readonly releases: string;
        readonly root: string;
        readonly runtimes: string;
        readonly state: {
            readonly backups: string;
            readonly database: string;
            readonly jobOutput: string;
            readonly logMaintenance: string;
            readonly logs: string;
            readonly root: string;
            readonly terminalBroker: string;
            readonly terminalBrokerSocket: string;
            readonly workspaceFileUploads: string;
        };
    };
    readonly root: string;
}

function invalidProjectRoot(): TypeError {
    return new TypeError("Dashboard project root is invalid");
}

function currentUserId(): number {
    if (typeof process.getuid !== "function") throw invalidProjectRoot();
    return process.getuid();
}

function hasProtectedDirectoryEntry(
    status: BigIntStats,
    childOwnerId: bigint,
    userId: number
): boolean {
    const trustedOwner = status.uid === 0n || status.uid === BigInt(userId);
    if (!status.isDirectory() || status.isSymbolicLink() || !trustedOwner) {
        return false;
    }
    if ((status.mode & 0o022n) === 0n) return true;
    const sticky = (status.mode & 0o1000n) !== 0n;
    const protectedChildOwner = childOwnerId === 0n || childOwnerId === BigInt(userId);
    return sticky && protectedChildOwner;
}

async function assertProtectedAncestorChain(
    root: string,
    rootStatus: BigIntStats,
    userId: number
): Promise<void> {
    let currentPath = root;
    let currentStatus = rootStatus;
    let childOwnerId = BigInt(userId);

    while (true) {
        if (!hasProtectedDirectoryEntry(currentStatus, childOwnerId, userId)) {
            throw invalidProjectRoot();
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) return;
        childOwnerId = currentStatus.uid;
        currentPath = parentPath;
        currentStatus = await lstat(currentPath, { bigint: true });
    }
}

function normalizedAbsoluteProjectRoot(projectRoot: string): string {
    if (
        projectRoot.includes("\0") ||
        !path.isAbsolute(projectRoot) ||
        projectRoot === path.parse(projectRoot).root ||
        path.resolve(projectRoot) !== projectRoot
    ) {
        throw invalidProjectRoot();
    }
    return projectRoot;
}

/**
 * Derives the only supported development and production host layout.
 * This is lexical and does not create, repair, or trust any filesystem entry.
 * @param projectRoot Normalized absolute stable Dashboard project root.
 * @returns Frozen project-local path inventory.
 */
export function deriveDashboardProjectLayout(
    projectRoot: string
): DashboardProjectLayout {
    const root = normalizedAbsoluteProjectRoot(projectRoot);
    const developmentRoot = path.join(root, "development");
    const productionRoot = path.join(root, "production");
    const stateRoot = path.join(productionRoot, "state");
    const development = Object.freeze({
        root: developmentRoot,
        state: path.join(developmentRoot, "state"),
        worktrees: path.join(developmentRoot, "worktrees"),
    });
    const state = Object.freeze({
        backups: path.join(stateRoot, "backups"),
        database: path.join(stateRoot, "mira-dashboard.db"),
        jobOutput: path.join(stateRoot, "job-output"),
        logMaintenance: path.join(stateRoot, "log-maintenance"),
        logs: path.join(stateRoot, "logs"),
        root: stateRoot,
        terminalBroker: path.join(stateRoot, "terminal-broker"),
        terminalBrokerSocket: path.join(stateRoot, "terminal-broker", "terminal.sock"),
        workspaceFileUploads: path.join(stateRoot, "workspace-file-uploads"),
    });
    const production = Object.freeze({
        checkout: path.join(productionRoot, "checkout"),
        releases: path.join(productionRoot, "releases"),
        root: productionRoot,
        runtimes: path.join(productionRoot, "runtimes"),
        state,
    });
    return Object.freeze({
        development,
        production,
        root,
    });
}

/**
 * Resolves and validates the existing stable project root before host paths are opened.
 * Runtime startup never creates directories or repairs permissions.
 * @param projectRoot Normalized absolute project-root candidate.
 * @returns Frozen canonical project-local path inventory.
 */
export async function resolveDashboardProjectLayout(
    projectRoot: string
): Promise<DashboardProjectLayout> {
    const root = normalizedAbsoluteProjectRoot(projectRoot);
    try {
        const userId = currentUserId();
        const [canonicalRoot, status] = await Promise.all([
            realpath(root),
            lstat(root, { bigint: true }),
        ]);
        if (
            canonicalRoot !== root ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(userId)
        ) {
            throw invalidProjectRoot();
        }
        await assertProtectedAncestorChain(root, status, userId);
    } catch {
        throw invalidProjectRoot();
    }
    return deriveDashboardProjectLayout(root);
}
