import { describe, expect, test } from "bun:test";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveReviewedOpenClawFileRoot } from "../../src/server/platform/files/openClawFileRootConfiguration.ts";
import { resolveReviewedWorkerOpenClawFileRoot } from "../../src/worker/files/openClawFileRootConfiguration.ts";
import { resolveDevelopmentStackConfig } from "./developmentStackConfig.ts";
import {
    prepareDevelopmentRuntimeState,
    prepareDevelopmentState,
    resetDevelopmentDatabase,
    resetDevelopmentState,
} from "./developmentState.ts";

const databaseMarkerFileName = ".mira-dashboard-development-database.json";
const repositoryRoot = path.resolve(import.meta.dir, "../..");

function openClawTransformPath(openClawRoot: string): string {
    return path.join(openClawRoot, "hooks", "transforms", "agentmail.ts");
}

async function pathExists(filePath: string): Promise<boolean> {
    return Bun.file(filePath).exists();
}

async function directoryExists(directoryPath: string): Promise<boolean> {
    try {
        const status = await lstat(directoryPath);
        return status.isDirectory();
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"
        ) {
            return false;
        }
        throw error;
    }
}

describe("development state", () => {
    test("seeds both reviewed OpenClaw files with private parents on first boot", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-openclaw-seed-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const hooksRoot = path.join(config.openClawRoot, "hooks");
        const transformsRoot = path.join(hooksRoot, "transforms");
        const transformPath = openClawTransformPath(config.openClawRoot);
        const userId = process.getuid?.();
        if (userId === undefined) throw new Error("Expected a POSIX test runtime");

        try {
            await prepareDevelopmentState(config);
            const [webRoot, workerRoot] = await Promise.all([
                resolveReviewedOpenClawFileRoot(
                    config.openClawRoot,
                    path.join(config.stateRoot, "production")
                ),
                resolveReviewedWorkerOpenClawFileRoot(
                    config.openClawRoot,
                    path.join(config.stateRoot, "production")
                ),
            ]);
            const writableManifestSegments =
                webRoot.manifest
                    ?.filter(({ writable }) => writable)
                    .map(({ segments }) => [...segments]) ?? [];
            expect(
                workerRoot.replacementManifest?.map(({ segments }) => [...segments])
            ).toEqual(writableManifestSegments);

            expect(
                await readFile(path.join(config.openClawRoot, "openclaw.json"), "utf8")
            ).toBe("{}\n");
            expect(await readFile(transformPath, "utf8")).toBe("");
            for (const directoryPath of [
                config.openClawRoot,
                hooksRoot,
                transformsRoot,
            ]) {
                const status = await lstat(directoryPath);
                expect(status.isDirectory()).toBeTrue();
                expect(status.isSymbolicLink()).toBeFalse();
                expect(status.uid).toBe(userId);
                expect(status.mode & 0o777).toBe(0o700);
            }
            for (const segments of writableManifestSegments) {
                const filePath = path.join(config.openClawRoot, ...segments);
                const status = await lstat(filePath);
                expect(status.isFile()).toBeTrue();
                expect(status.isSymbolicLink()).toBeFalse();
                expect(status.nlink).toBe(1);
                expect(status.uid).toBe(userId);
                expect(status.mode & 0o777).toBe(0o600);
            }
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("reuses existing reviewed OpenClaw files without replacing their contents", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-openclaw-reuse-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const configPath = path.join(config.openClawRoot, "openclaw.json");
        const transformPath = openClawTransformPath(config.openClawRoot);

        try {
            await prepareDevelopmentState(config);
            await writeFile(configPath, '{"hooks":{}}\n', "utf8");
            await writeFile(transformPath, "export const preserved = true;\n", "utf8");
            await chmod(transformPath, 0o664);

            const reused = await prepareDevelopmentState(config);

            expect(reused.database).toBe("created-empty");
            expect(await readFile(configPath, "utf8")).toBe('{"hooks":{}}\n');
            expect(await readFile(transformPath, "utf8")).toBe(
                "export const preserved = true;\n"
            );
            const transformStatus = await lstat(transformPath);
            expect(transformStatus.mode & 0o777).toBe(0o664);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("rejects OpenClaw symlinks and keeps their targets untouched", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-openclaw-symlink-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const hooksRoot = path.join(config.openClawRoot, "hooks");
        const outsideDirectory = path.join(temporaryRoot, "outside-hooks");
        const outsideSentinel = path.join(outsideDirectory, "sentinel.txt");

        try {
            await prepareDevelopmentState(config);
            await mkdir(outsideDirectory, { mode: 0o700 });
            await writeFile(outsideSentinel, "outside\n", { mode: 0o600 });
            await rm(hooksRoot, { recursive: true });
            await symlink(outsideDirectory, hooksRoot);

            const failure = await prepareDevelopmentState(config).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error)) {
                throw new Error("Expected OpenClaw symlink failure");
            }
            expect(failure.message).toBe("Development file root is invalid");
            expect(await readFile(outsideSentinel, "utf8")).toBe("outside\n");
            expect(await readdir(outsideDirectory)).toEqual(["sentinel.txt"]);

            await rm(hooksRoot);
            await mkdir(path.join(hooksRoot, "transforms"), {
                mode: 0o700,
                recursive: true,
            });
            const outsideTransform = path.join(outsideDirectory, "agentmail.ts");
            await writeFile(outsideTransform, "outside transform\n", { mode: 0o600 });
            await symlink(outsideTransform, openClawTransformPath(config.openClawRoot));

            const fileFailure = await prepareDevelopmentState(config).then(
                () => null,
                (error: unknown) => error
            );
            expect(fileFailure).toBeInstanceOf(Error);
            if (!(fileFailure instanceof Error)) {
                throw new Error("Expected OpenClaw file symlink failure");
            }
            expect(fileFailure.message).toBe("Development file root is invalid");
            expect(await readFile(outsideTransform, "utf8")).toBe("outside transform\n");
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("confines OpenClaw seed creation to its exact development state descendant", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-openclaw-confined-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const outsideOpenClawRoot = path.join(temporaryRoot, "outside-openclaw");
        const forgedConfig = Object.freeze({
            ...config,
            openClawRoot: outsideOpenClawRoot,
        });

        try {
            const failure = await prepareDevelopmentState(forgedConfig).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error)) {
                throw new Error("Expected OpenClaw root confinement failure");
            }
            expect(failure.message).toBe("Development file root is invalid");
            expect(await pathExists(outsideOpenClawRoot)).toBeFalse();
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("rolls only SQLite state when the migration fingerprint changes", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-state-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );

        try {
            const initial = await prepareDevelopmentState(config);
            expect(initial.database).toBe("created-empty");
            const originalKeyring = await readFile(config.keyringPath, "utf8");
            const workspaceSentinel = path.join(config.workspaceRoot, "sentinel.txt");
            const transformPath = openClawTransformPath(config.openClawRoot);
            await writeFile(workspaceSentinel, "preserved\n", "utf8");
            await writeFile(transformPath, "preserved transform\n", "utf8");
            await writeFile(config.databasePath, "database", { mode: 0o600 });
            await writeFile(`${config.databasePath}-wal`, "wal", { mode: 0o600 });

            const databaseMarkerPath = path.join(
                config.stateRoot,
                databaseMarkerFileName
            );
            const databaseMarker = JSON.parse(
                await readFile(databaseMarkerPath, "utf8")
            ) as Record<string, unknown>;
            await writeFile(
                databaseMarkerPath,
                `${JSON.stringify({
                    ...databaseMarker,
                    migrationFingerprint: "0".repeat(64),
                })}\n`,
                "utf8"
            );

            const rolled = await prepareDevelopmentState(config);

            expect(rolled.database).toBe("schema-reset");
            expect(await pathExists(config.databasePath)).toBeFalse();
            expect(await pathExists(`${config.databasePath}-wal`)).toBeFalse();
            expect(await readFile(config.keyringPath, "utf8")).toBe(originalKeyring);
            expect(await readFile(workspaceSentinel, "utf8")).toBe("preserved\n");
            expect(await readFile(transformPath, "utf8")).toBe("preserved transform\n");
            const updatedMarker = JSON.parse(
                await readFile(databaseMarkerPath, "utf8")
            ) as { migrationFingerprint?: unknown };
            expect(updatedMarker.migrationFingerprint).not.toBe("0".repeat(64));
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("supports an owner-validated database-only reset and rejects symlinks", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-reset-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );

        try {
            await prepareDevelopmentState(config);
            const originalKeyring = await readFile(config.keyringPath, "utf8");
            const workspaceSentinel = path.join(config.workspaceRoot, "sentinel.txt");
            await writeFile(workspaceSentinel, "preserved\n", "utf8");
            await writeFile(config.databasePath, "database", { mode: 0o600 });

            const didReset = await resetDevelopmentDatabase(config);
            expect(didReset).toBeTrue();
            expect(await pathExists(config.databasePath)).toBeFalse();
            expect(await readFile(config.keyringPath, "utf8")).toBe(originalKeyring);
            expect(await readFile(workspaceSentinel, "utf8")).toBe("preserved\n");

            const outsideTarget = path.join(temporaryRoot, "outside.db");
            await writeFile(outsideTarget, "outside", { mode: 0o600 });
            await symlink(outsideTarget, config.databasePath);
            const failure = await resetDevelopmentDatabase(config).then(
                () => null,
                (error: unknown) => error
            );
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error))
                throw new Error("Expected database reset failure");
            expect(failure.message).toContain("Development database path is invalid");
            expect(await readFile(outsideTarget, "utf8")).toBe("outside");
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("holds one process lease, blocks resets, and recovers an exact stale lease", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-lease-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );

        let session:
            | Awaited<ReturnType<typeof prepareDevelopmentRuntimeState>>
            | undefined;
        try {
            session = await prepareDevelopmentRuntimeState(config);
            const concurrentFailure = await prepareDevelopmentRuntimeState(config).then(
                () => null,
                (error: unknown) => error
            );
            expect(concurrentFailure).toBeInstanceOf(Error);
            if (!(concurrentFailure instanceof Error)) {
                throw new Error("Expected concurrent state failure");
            }
            expect(concurrentFailure.message).toContain(
                "Development state is already in use"
            );
            const resetFailure = await resetDevelopmentDatabase(config).then(
                () => null,
                (error: unknown) => error
            );
            expect(resetFailure).toBeInstanceOf(Error);
            if (!(resetFailure instanceof Error)) {
                throw new Error("Expected active-state reset failure");
            }
            expect(resetFailure.message).toContain("Development state is already in use");
            await Promise.all([session.release(), session.release()]);
            session = undefined;

            const staleToken = "a".repeat(32);
            const staleLeaseName = `.mira-dashboard-development-lease-2147483647-${staleToken}.json`;
            await writeFile(
                path.join(config.stateRoot, staleLeaseName),
                `${JSON.stringify({
                    formatVersion: 1,
                    owner: config.stateOwner,
                    processId: 2_147_483_647,
                    processIdentity: null,
                    startedAtMs: 0,
                    token: staleToken,
                })}\n`,
                { mode: 0o600 }
            );

            session = await prepareDevelopmentRuntimeState(config);
            expect(
                await pathExists(path.join(config.stateRoot, staleLeaseName))
            ).toBeFalse();
            await session.release();
            session = undefined;
            const stateEntries = await readdir(config.stateRoot);
            expect(
                stateEntries.filter((entry) =>
                    entry.startsWith(".mira-dashboard-development-lease-")
                )
            ).toEqual([]);
        } finally {
            await session?.release();
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("elects exactly one lease owner during simultaneous startup", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-lease-race-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        let sessions: Awaited<ReturnType<typeof prepareDevelopmentRuntimeState>>[] = [];

        try {
            await prepareDevelopmentState(config);
            const attempts = await Promise.allSettled(
                Array.from({ length: 8 }, () => prepareDevelopmentRuntimeState(config))
            );
            sessions = attempts.flatMap((attempt) =>
                attempt.status === "fulfilled" ? [attempt.value] : []
            );
            const failures = attempts.flatMap((attempt) =>
                attempt.status === "rejected" ? [attempt.reason as unknown] : []
            );

            expect(sessions).toHaveLength(1);
            expect(failures).toHaveLength(7);
            for (const failure of failures) {
                expect(failure).toBeInstanceOf(Error);
                if (!(failure instanceof Error)) {
                    throw new Error("Expected concurrent state lease failure");
                }
                expect(failure.message).toContain("Development state is already in use");
            }
            const activeStateEntries = await readdir(config.stateRoot);
            expect(
                activeStateEntries.filter((entry) =>
                    entry.startsWith(".mira-dashboard-development-lease-")
                )
            ).toHaveLength(1);

            const winner = sessions[0];
            if (winner === undefined) throw new Error("Expected one lease owner");
            await Promise.all([winner.release(), winner.release()]);
            sessions = [];
            const releasedStateEntries = await readdir(config.stateRoot);
            expect(
                releasedStateEntries.filter((entry) =>
                    entry.startsWith(".mira-dashboard-development-lease-")
                )
            ).toEqual([]);
        } finally {
            await Promise.all(sessions.map((session) => session.release()));
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("names the invalid lease file in parse and marker diagnostics", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-invalid-lease-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const token = "b".repeat(32);
        const invalidLeaseName = `.mira-dashboard-development-lease-2147483647-${token}.json`;
        const invalidLeasePath = path.join(config.stateRoot, invalidLeaseName);

        try {
            await prepareDevelopmentState(config);
            for (const contents of ["{\n", "{}\n"]) {
                await writeFile(invalidLeasePath, contents, { mode: 0o600 });
                const failure = await prepareDevelopmentRuntimeState(config).then(
                    () => null,
                    (error: unknown) => error
                );
                expect(failure).toBeInstanceOf(Error);
                if (!(failure instanceof Error)) {
                    throw new Error("Expected invalid lease failure");
                }
                expect(failure.message).toBe(
                    `Development state lease is invalid: ${invalidLeaseName}`
                );
            }
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("refuses a forged database path outside the exact state descendant", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-database-path-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const outsideDatabase = path.join(temporaryRoot, "outside.db");

        try {
            await prepareDevelopmentState(config);
            await writeFile(outsideDatabase, "outside", { mode: 0o600 });
            const forgedConfig = Object.freeze({
                ...config,
                databasePath: outsideDatabase,
            });

            const failure = await resetDevelopmentDatabase(forgedConfig).then(
                () => null,
                (error: unknown) => error
            );
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error)) {
                throw new Error("Expected forged database path failure");
            }
            expect(failure.message).toContain("Development database path is invalid");
            expect(await readFile(outsideDatabase, "utf8")).toBe("outside");
            const session = await prepareDevelopmentRuntimeState(config);
            await session.release();
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("never follows a replaced database-directory symlink during reset", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-database-parent-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const outsideDirectory = path.join(temporaryRoot, "outside-state");
        const outsideDatabase = path.join(outsideDirectory, "mira-dashboard.db");

        try {
            await prepareDevelopmentState(config);
            await mkdir(outsideDirectory, { mode: 0o700 });
            await writeFile(outsideDatabase, "outside", { mode: 0o600 });
            const databaseDirectory = path.dirname(config.databasePath);
            await rm(databaseDirectory, { recursive: true });
            await symlink(outsideDirectory, databaseDirectory);

            const failure = await resetDevelopmentDatabase(config).then(
                () => null,
                (error: unknown) => error
            );
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error)) {
                throw new Error("Expected database parent symlink failure");
            }
            expect(failure.message).toContain(
                "protected project-local filesystem policy"
            );
            expect(await readFile(outsideDatabase, "utf8")).toBe("outside");
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("atomically detaches a complete state reset before recursive cleanup", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-full-reset-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );

        try {
            await prepareDevelopmentState(config);
            const transformPath = openClawTransformPath(config.openClawRoot);
            await writeFile(transformPath, "removed with state\n", "utf8");
            await resetDevelopmentState(config);
            expect(await directoryExists(config.stateRoot)).toBeFalse();
            const stateParentEntries = await readdir(path.dirname(config.stateRoot));
            expect(
                stateParentEntries.filter((entry) => entry.includes(".removed-"))
            ).toEqual([]);
            await prepareDevelopmentState(config);
            expect(await directoryExists(config.stateRoot)).toBeTrue();
            expect(await readFile(transformPath, "utf8")).toBe("");
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
