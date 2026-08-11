import { describe, expect, test } from "bun:test";
import {
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

import { resolveDevelopmentStackConfig } from "./developmentStackConfig.ts";
import {
    prepareDevelopmentRuntimeState,
    prepareDevelopmentState,
    resetDevelopmentDatabase,
    resetDevelopmentState,
} from "./developmentState.ts";

const databaseMarkerFileName = ".mira-dashboard-development-database.json";
const repositoryRoot = path.resolve(import.meta.dir, "../..");

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
            await writeFile(workspaceSentinel, "preserved\n", "utf8");
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
            await resetDevelopmentState(config);
            expect(await directoryExists(config.stateRoot)).toBeFalse();
            const stateParentEntries = await readdir(path.dirname(config.stateRoot));
            expect(
                stateParentEntries.filter((entry) => entry.includes(".removed-"))
            ).toEqual([]);
            await prepareDevelopmentState(config);
            expect(await directoryExists(config.stateRoot)).toBeTrue();
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
