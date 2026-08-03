import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    databaseMigrationIdentities,
    type DatabaseMigrationIdentity,
} from "../../src/databaseMigrations/registry.ts";
import { runReleaseLifecycleCommand } from "../../src/releaseLifecycle.ts";
import { installManagedBunRuntime } from "../../src/services/releases/managedRuntimeStore.ts";
import {
    RELEASE_TRANSITION_LOCK_FILE_NAME,
    RELEASE_TRANSITION_LOCK_PROGRAM,
} from "../../src/services/releases/managerModel.ts";
import {
    loadReleaseManifest,
    writeReleaseManifest,
} from "../../src/services/releases/manifestArtifacts.ts";
import { parseReleaseManifest } from "../../src/services/releases/manifestParser.ts";
import {
    databaseMigrationInventorySha256,
    RELEASE_MANIFEST_FILE_NAME,
} from "../../src/services/releases/manifestPolicy.ts";
import {
    activateDashboardRelease,
    readDashboardReleaseState,
} from "../../src/services/releases/releaseActivation.ts";
import {
    ensureDashboardReleaseLayout,
    loadManagedRelease,
    managedReleasePath,
    resolveDashboardReleasesRoot,
} from "../../src/services/releases/releaseLayout.ts";
import { publishVerifiedDashboardRelease } from "../../src/services/releases/releasePublication.ts";
import { pruneDashboardReleases } from "../../src/services/releases/releaseRetention.ts";
import {
    restoreDashboardReleaseAfterFailedActivation,
    rollbackDashboardRelease,
} from "../../src/services/releases/releaseRollback.ts";
import {
    currentBunRuntimeIdentity,
    hasManagedBunRuntime,
} from "../../src/services/releases/runtime.ts";
import { assertDashboardReleaseRuntimeAvailable } from "../../src/services/releases/schemaCompatibility.ts";
import { assertReleaseTransitionLockCommandSucceeded } from "../../src/services/releases/transitionLock.ts";
import { captureRejection } from "../support/rejections.ts";
import { createReleaseFixture } from "../support/releaseFixture.ts";

const temporaryRoots: string[] = [];
const FIRST_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "b".repeat(40);
const THIRD_COMMIT = "c".repeat(40);
const FOURTH_COMMIT = "d".repeat(40);
const CURRENT_BUN_RUNTIME_IDENTITY = currentBunRuntimeIdentity();
const TEST_FUTURE_MIGRATIONS: DatabaseMigrationIdentity[] = [
    {
        checksum: "9".repeat(64),
        name: "test-migration-10",
        version: 10,
    },
    {
        checksum: "a".repeat(64),
        name: "test-migration-11",
        version: 11,
    },
];

function testLiveSchemaState(
    version: number,
    overrides: Partial<Record<number, DatabaseMigrationIdentity>> = {}
) {
    const availableMigrations = [
        ...databaseMigrationIdentities(),
        ...TEST_FUTURE_MIGRATIONS,
    ];
    if (version > availableMigrations.length) {
        throw new Error(
            `testLiveSchemaState(${version}) requires ${version} known migrations, only ${availableMigrations.length} available`
        );
    }
    const migrations = availableMigrations
        .slice(0, version)
        .map((migration) => overrides[migration.version] ?? migration);
    return { migrations, version };
}

const SCHEMA_6_OPTIONS = {
    hasRuntime: () => true,
    readLiveSchemaState: () => testLiveSchemaState(6),
};

function holdTransitionLock(
    releasesRoot: string,
    mode: "exclusive" | "shared" = "exclusive"
): number {
    const lockFileDescriptor = openSync(
        path.join(releasesRoot, RELEASE_TRANSITION_LOCK_FILE_NAME),
        "r+"
    );
    const result = spawnSync(
        RELEASE_TRANSITION_LOCK_PROGRAM,
        [mode === "exclusive" ? "--exclusive" : "--shared", "--nonblock", "3"],
        {
            stdio: ["ignore", "ignore", "pipe", lockFileDescriptor],
        }
    );
    if (result.error || result.status !== 0) {
        closeSync(lockFileDescriptor);
        throw new Error("Test release transition lock did not become ready");
    }
    return lockFileDescriptor;
}

async function throwWhenPromiseSettles(
    promise: Promise<unknown>,
    message: string
): Promise<never> {
    await promise;
    throw new Error(message);
}

async function throwAfterDelay(milliseconds: number, message: string): Promise<never> {
    await Bun.sleep(milliseconds);
    throw new Error(message);
}

function temporaryReleasesRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "mira-releases-"));
    temporaryRoots.push(root);
    return root;
}

async function createManagedRelease(
    releasesRoot: string,
    directoryCommit: string,
    manifestCommit = directoryCommit,
    bunVersion = CURRENT_BUN_RUNTIME_IDENTITY,
    builtAt = new Date("2026-07-25T17:00:00.000Z")
): Promise<string> {
    await ensureDashboardReleaseLayout(releasesRoot);
    const releasePath = managedReleasePath(releasesRoot, directoryCommit);
    mkdirSync(path.join(releasePath, "backend", "config"), { recursive: true });
    mkdirSync(path.join(releasePath, "backend", "dist"), { recursive: true });
    mkdirSync(path.join(releasePath, "dist", "assets"), { recursive: true });
    mkdirSync(path.join(releasePath, "scripts"), { recursive: true });
    writeFileSync(path.join(releasePath, "package.json"), "{}\n");
    writeFileSync(path.join(releasePath, "bun.lock"), "root-lock\n");
    writeFileSync(
        path.join(releasePath, "scripts", "runManagedDashboardRelease.sh"),
        '#!/usr/bin/env bash\nexec bun "$@"\n',
        { mode: 0o755 }
    );
    writeFileSync(
        path.join(releasePath, "backend", "config", "log-rotation.json"),
        '{"jobs":[]}\n'
    );
    writeFileSync(
        path.join(releasePath, "dist", "index.html"),
        `<main>${directoryCommit}</main>\n`
    );
    writeFileSync(
        path.join(releasePath, "dist", "assets", "app.js"),
        `export const release = "${directoryCommit}";\n`
    );
    writeFileSync(
        path.join(releasePath, "dist", "build-identity.json"),
        `${JSON.stringify({
            bunVersion,
            commitSha: manifestCommit,
            component: "frontend",
            formatVersion: 1,
        })}\n`
    );
    writeFileSync(
        path.join(releasePath, "backend", "dist", "build-identity.json"),
        `${JSON.stringify({
            bunVersion,
            commitSha: manifestCommit,
            component: "backend",
            formatVersion: 1,
        })}\n`
    );
    for (const entrypoint of [
        "databasePreflight",
        "pullRequestPreviewGatewayProxy",
        "releaseLifecycle",
        "resetDashboardPassword",
        "serverStart",
        "workerStart",
    ]) {
        writeFileSync(
            path.join(releasePath, "backend", "dist", `${entrypoint}.js`),
            `export const release = "${directoryCommit}";\n`
        );
    }
    await writeReleaseManifest({
        builtAt,
        bunVersion,
        commitSha: manifestCommit,
        commitTitle: `Release ${manifestCommit.slice(0, 8)}`,
        releaseRoot: releasePath,
    });
    return releasePath;
}

async function rewriteManifest(
    releasePath: string,
    changes: {
        bunVersion?: string;
        commitSha?: string;
        migrationRegistrySha256?: string;
        schemaMaximum?: number;
        schemaMinimum?: number;
        schemaTarget?: number;
    }
): Promise<void> {
    const manifest = await loadReleaseManifest(releasePath);
    const commitSha = changes.commitSha ?? manifest.commitSha;
    const commitShort = commitSha.slice(0, 8);
    const schemaTarget = changes.schemaTarget ?? manifest.schema.target;
    const migrations = [
        ...(manifest.schema.migrations ?? []),
        ...TEST_FUTURE_MIGRATIONS.filter((migration) =>
            (manifest.schema.migrations ?? []).every(
                (existing) => existing.version !== migration.version
            )
        ),
    ].slice(0, schemaTarget);
    const rewritten = parseReleaseManifest({
        ...manifest,
        ...(changes.bunVersion && { bunVersion: changes.bunVersion }),
        commitSha,
        commitShort,
        components: {
            backendCommit: commitShort,
            frontendCommit: commitShort,
        },
        schema: {
            ...manifest.schema,
            migrations,
            migrationInventorySha256: databaseMigrationInventorySha256(migrations),
            ...(changes.migrationRegistrySha256 && {
                migrationRegistrySha256: changes.migrationRegistrySha256,
            }),
            ...(changes.schemaMaximum !== undefined && {
                maximumCompatible: changes.schemaMaximum,
            }),
            ...(changes.schemaMinimum !== undefined && {
                minimumCompatible: changes.schemaMinimum,
            }),
            target: schemaTarget,
        },
    });
    writeFileSync(
        path.join(releasePath, RELEASE_MANIFEST_FILE_NAME),
        `${JSON.stringify(rewritten, undefined, 2)}\n`
    );
}

afterEach(() => {
    const roots = [...temporaryRoots];
    temporaryRoots.length = 0;
    for (const root of roots) {
        rmSync(root, { force: true, recursive: true });
    }
});

describe("Dashboard immutable release manager", () => {
    it("classifies transition-lock command failures explicitly", () => {
        const missing = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
        expect(() =>
            assertReleaseTransitionLockCommandSucceeded(missing, undefined, "")
        ).toThrow(`require executable ${RELEASE_TRANSITION_LOCK_PROGRAM}`);
        expect(() =>
            assertReleaseTransitionLockCommandSucceeded(
                new Error("permission denied"),
                undefined,
                ""
            )
        ).toThrow("lock failed: permission denied");
        expect(() =>
            assertReleaseTransitionLockCommandSucceeded(undefined, 75, "")
        ).toThrow("Another managed release transition is in progress");
        expect(() =>
            assertReleaseTransitionLockCommandSucceeded(undefined, 2, "flock diagnostic")
        ).toThrow("exited 2: flock diagnostic");
        expect(() =>
            assertReleaseTransitionLockCommandSucceeded(undefined, 0, "")
        ).not.toThrow();
    });

    it("accepts only absolute non-root layouts and full lowercase commit SHAs", () => {
        expect(() => resolveDashboardReleasesRoot("relative")).toThrow(
            "absolute non-root"
        );
        expect(() =>
            resolveDashboardReleasesRoot(path.parse(process.cwd()).root)
        ).toThrow("absolute non-root");
        expect(() => managedReleasePath("/tmp/dashboard-releases", "abc")).toThrow(
            "full lowercase Git SHA"
        );
    });

    it("does not expose active staging paths before publication owns the transition lock", async () => {
        const releasesRoot = temporaryReleasesRoot();
        const buildRoot = temporaryReleasesRoot();
        await ensureDashboardReleaseLayout(releasesRoot);
        await createReleaseFixture(buildRoot, FIRST_COMMIT);
        chmodSync(
            path.join(buildRoot, "scripts", "runManagedDashboardRelease.sh"),
            0o644
        );
        await readDashboardReleaseState(releasesRoot);
        const lockFileDescriptor = holdTransitionLock(releasesRoot);
        const { promise: lockContention, resolve: didReachLockContention } =
            Promise.withResolvers<void>();
        const publication = publishVerifiedDashboardRelease(
            buildRoot,
            FIRST_COMMIT,
            releasesRoot,
            {
                onTransitionLockContention: () => {
                    didReachLockContention();
                },
            }
        );
        try {
            await Promise.race([
                lockContention,
                throwWhenPromiseSettles(
                    publication,
                    "Release publication completed before waiting for the held transition lock"
                ),
                throwAfterDelay(
                    2000,
                    "Release publication did not reach transition-lock contention"
                ),
            ]);
            expect(
                readdirSync(path.join(releasesRoot, "releases")).filter((entry) =>
                    entry.startsWith(".staging-")
                )
            ).toEqual([]);
        } finally {
            closeSync(lockFileDescriptor);
        }
        const release = await publication;
        expect(release.commitSha).toBe(FIRST_COMMIT);
        expect(
            statSync(path.join(release.path, "scripts", "runManagedDashboardRelease.sh"))
                .mode & 0o777
        ).toBe(0o755);
    });

    it("repairs launcher permissions when reusing an existing verified release", async () => {
        const releasesRoot = temporaryReleasesRoot();
        const buildRoot = temporaryReleasesRoot();
        await createReleaseFixture(buildRoot, FIRST_COMMIT);
        const published = await publishVerifiedDashboardRelease(
            buildRoot,
            FIRST_COMMIT,
            releasesRoot
        );
        const launcherPath = path.join(
            published.path,
            "scripts",
            "runManagedDashboardRelease.sh"
        );
        chmodSync(launcherPath, 0o644);

        const reused = await publishVerifiedDashboardRelease(
            buildRoot,
            FIRST_COMMIT,
            releasesRoot
        );

        expect(reused.path).toBe(published.path);
        expect(statSync(launcherPath).mode & 0o777).toBe(0o755);
    });

    it("repairs launcher permissions after a concurrent publication wins", async () => {
        const releasesRoot = temporaryReleasesRoot();
        const buildRoot = temporaryReleasesRoot();
        await createReleaseFixture(buildRoot, FIRST_COMMIT);
        const finalPath = managedReleasePath(releasesRoot, FIRST_COMMIT);
        const launcherPath = path.join(
            finalPath,
            "scripts",
            "runManagedDashboardRelease.sh"
        );
        const originalRename = fsp.rename.bind(fsp);
        const rename = spyOn(fsp, "rename").mockImplementation(
            async (oldPath, newPath) => {
                if (
                    typeof oldPath === "string" &&
                    oldPath.includes(`.staging-${FIRST_COMMIT}-`) &&
                    newPath === finalPath
                ) {
                    await createReleaseFixture(finalPath, FIRST_COMMIT);
                    chmodSync(launcherPath, 0o644);
                    throw Object.assign(new Error("concurrent publication won"), {
                        code: "EEXIST",
                    });
                }
                return originalRename(oldPath, newPath);
            }
        );

        try {
            const published = await publishVerifiedDashboardRelease(
                buildRoot,
                FIRST_COMMIT,
                releasesRoot
            );
            expect(published.path).toBe(finalPath);
            expect(statSync(launcherPath).mode & 0o777).toBe(0o755);
        } finally {
            rename.mockRestore();
        }
    });

    it("activates and rolls back verified releases through relative atomic links", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);

        const first = await activateDashboardRelease(
            FIRST_COMMIT,
            root,
            SCHEMA_6_OPTIONS
        );
        expect(first.current?.commitSha).toBe(FIRST_COMMIT);
        expect(first.previous).toBeUndefined();
        expect(readlinkSync(path.join(root, "current"))).toBe(`releases/${FIRST_COMMIT}`);

        const second = await activateDashboardRelease(
            SECOND_COMMIT,
            root,
            SCHEMA_6_OPTIONS
        );
        expect(second.current?.commitSha).toBe(SECOND_COMMIT);
        expect(second.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(readlinkSync(path.join(root, "current"))).toBe(
            `releases/${SECOND_COMMIT}`
        );
        expect(readlinkSync(path.join(root, "previous"))).toBe(
            `releases/${FIRST_COMMIT}`
        );

        const rolledBack = await rollbackDashboardRelease(root, SCHEMA_6_OPTIONS);
        expect(rolledBack.current?.commitSha).toBe(FIRST_COMMIT);
        expect(rolledBack.previous?.commitSha).toBe(SECOND_COMMIT);
        expect(
            readdirSync(root).filter((entry) => entry.startsWith(".current."))
        ).toEqual([]);
        expect(
            readdirSync(root).filter((entry) => entry.startsWith(".previous."))
        ).toEqual([]);
    });

    it("restores the exact release slots that preceded a failed activation", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await createManagedRelease(root, THIRD_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(THIRD_COMMIT, root, SCHEMA_6_OPTIONS);

        const restored = await restoreDashboardReleaseAfterFailedActivation(
            {
                ...SCHEMA_6_OPTIONS,
                expected: {
                    candidateCommitSha: THIRD_COMMIT,
                    previousCommitSha: FIRST_COMMIT,
                    rollbackCommitSha: SECOND_COMMIT,
                },
            },
            root
        );

        expect(restored.current?.commitSha).toBe(SECOND_COMMIT);
        expect(restored.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(readlinkSync(path.join(root, "current"))).toBe(
            `releases/${SECOND_COMMIT}`
        );
        expect(readlinkSync(path.join(root, "previous"))).toBe(
            `releases/${FIRST_COMMIT}`
        );
        expect(
            restoreDashboardReleaseAfterFailedActivation(
                {
                    ...SCHEMA_6_OPTIONS,
                    expected: {
                        candidateCommitSha: THIRD_COMMIT,
                        previousCommitSha: FIRST_COMMIT,
                        rollbackCommitSha: SECOND_COMMIT,
                    },
                },
                root
            )
        ).resolves.toMatchObject({
            current: { commitSha: SECOND_COMMIT },
            previous: { commitSha: FIRST_COMMIT },
        });
        expect(readDashboardReleaseState(root)).resolves.toMatchObject({
            current: { commitSha: SECOND_COMMIT },
            previous: { commitSha: FIRST_COMMIT },
        });
    });

    it("removes the previous slot when the failed activation had no older release", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);

        const restored = await runReleaseLifecycleCommand(
            ["restore", SECOND_COMMIT, FIRST_COMMIT],
            root,
            SCHEMA_6_OPTIONS
        );

        expect(restored).toMatchObject({
            current: { commitSha: FIRST_COMMIT },
            previous: undefined,
        });
        expect(existsSync(path.join(root, "previous"))).toBe(false);
    });

    it("removes an orphaned previous link during first activation", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        symlinkSync(`releases/${FIRST_COMMIT}`, path.join(root, "previous"), "dir");

        const activated = await activateDashboardRelease(
            SECOND_COMMIT,
            root,
            SCHEMA_6_OPTIONS
        );

        expect(activated.current?.commitSha).toBe(SECOND_COMMIT);
        expect(activated.previous).toBeUndefined();
        expect(readlinkSync(path.join(root, "current"))).toBe(
            `releases/${SECOND_COMMIT}`
        );
        expect(existsSync(path.join(root, "previous"))).toBe(false);
    });

    it("excludes an unverifiable previous slot and replaces it on activation", async () => {
        const root = temporaryReleasesRoot();
        const firstReleasePath = await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await createManagedRelease(root, THIRD_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);
        rmSync(path.join(firstReleasePath, "scripts", "runManagedDashboardRelease.sh"));

        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(SECOND_COMMIT);
        expect(state.previous).toBeUndefined();

        const activated = await activateDashboardRelease(
            THIRD_COMMIT,
            root,
            SCHEMA_6_OPTIONS
        );
        expect(activated).toMatchObject({
            current: { commitSha: THIRD_COMMIT },
            previous: { commitSha: SECOND_COMMIT },
        });
        expect(readlinkSync(path.join(root, "previous"))).toBe(
            `releases/${SECOND_COMMIT}`
        );
    });

    it("exposes bounded lifecycle command summaries without artifact contents", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);

        expect(runReleaseLifecycleCommand(["status"], root)).resolves.toEqual({
            current: undefined,
            previous: undefined,
            root,
        });
        expect(runReleaseLifecycleCommand(["activate"], root)).rejects.toThrow(
            "requires a commit SHA"
        );
        expect(runReleaseLifecycleCommand([], root)).rejects.toThrow(
            "Usage: releaseLifecycle.js"
        );

        await runReleaseLifecycleCommand(
            ["activate", FIRST_COMMIT],
            root,
            SCHEMA_6_OPTIONS
        );
        await runReleaseLifecycleCommand(
            ["activate", SECOND_COMMIT],
            root,
            SCHEMA_6_OPTIONS
        );
        expect(
            runReleaseLifecycleCommand(
                ["rollback", FIRST_COMMIT, SECOND_COMMIT],
                root,
                SCHEMA_6_OPTIONS
            )
        ).rejects.toThrow("rollback slots changed");
        expect(readDashboardReleaseState(root)).resolves.toMatchObject({
            current: { commitSha: SECOND_COMMIT },
            previous: { commitSha: FIRST_COMMIT },
        });
        const rolledBack = await runReleaseLifecycleCommand(
            ["rollback", SECOND_COMMIT, FIRST_COMMIT],
            root,
            SCHEMA_6_OPTIONS
        );
        expect(rolledBack).toMatchObject({
            current: { commitSha: FIRST_COMMIT },
            previous: { commitSha: SECOND_COMMIT },
        });

        const status = await runReleaseLifecycleCommand(["status"], root);
        expect(status).toMatchObject({
            current: {
                commitSha: FIRST_COMMIT,
                commitTitle: "Release aaaaaaaa",
            },
            previous: {
                commitSha: SECOND_COMMIT,
                commitTitle: "Release bbbbbbbb",
            },
            root,
        });
        expect(status).not.toHaveProperty("current.manifest");
        expect(runReleaseLifecycleCommand(["prune"], root)).resolves.toEqual({
            removed: [],
            removedRuntimes: [],
            retained: [SECOND_COMMIT, FIRST_COMMIT],
            retainedRuntimes: [],
            warnings: [],
        });
        expect(runReleaseLifecycleCommand(["prune", "2"], root)).rejects.toThrow(
            "retention must be between 3 and 20"
        );
        expect(runReleaseLifecycleCommand(["prune", "3", "extra"], root)).rejects.toThrow(
            "unexpected arguments"
        );
        expect(
            runReleaseLifecycleCommand(["rollback", FIRST_COMMIT], root)
        ).rejects.toThrow("requires expected current and target");
        expect(
            runReleaseLifecycleCommand(
                ["rollback", FIRST_COMMIT, SECOND_COMMIT, "extra"],
                root
            )
        ).rejects.toThrow("requires expected current and target");
        expect(
            runReleaseLifecycleCommand(["rollback", "", FIRST_COMMIT], root)
        ).rejects.toThrow("requires expected current and target");
        expect(
            runReleaseLifecycleCommand(["restore", FIRST_COMMIT], root)
        ).rejects.toThrow("requires expected candidate and rollback");
        expect(
            runReleaseLifecycleCommand(
                ["restore", FIRST_COMMIT, SECOND_COMMIT, THIRD_COMMIT, "extra"],
                root
            )
        ).rejects.toThrow("requires expected candidate and rollback");
        expect(runReleaseLifecycleCommand(["status", ""], root)).rejects.toThrow(
            "takes no commit SHA"
        );
    });

    it("rejects directories whose manifest identity or artifacts do not match", async () => {
        const root = temporaryReleasesRoot();
        const mismatchedPath = await createManagedRelease(
            root,
            FIRST_COMMIT,
            SECOND_COMMIT
        );

        expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "contains manifest"
        );

        rmSync(mismatchedPath, { force: true, recursive: true });
        const releasePath = await createManagedRelease(root, FIRST_COMMIT);
        writeFileSync(path.join(releasePath, "dist", "index.html"), "tampered\n");
        expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "Release artifact verification failed"
        );
    });

    it("revalidates component build identities when loading a managed release", async () => {
        const root = temporaryReleasesRoot();
        const originalPath = await createManagedRelease(root, FIRST_COMMIT);
        const relabeledPath = managedReleasePath(root, SECOND_COMMIT);
        renameSync(originalPath, relabeledPath);
        await rewriteManifest(relabeledPath, { commitSha: SECOND_COMMIT });

        expect(loadManagedRelease(root, SECOND_COMMIT)).rejects.toThrow(
            "backend build identity does not match the release manifest"
        );
    });

    it("rejects symlinked release directories and non-symlink state slots", async () => {
        const root = temporaryReleasesRoot();
        const outside = mkdtempSync(path.join(tmpdir(), "mira-release-outside-"));
        temporaryRoots.push(outside);
        const layout = await ensureDashboardReleaseLayout(root);
        symlinkSync(outside, path.join(layout.releasesPath, FIRST_COMMIT), "dir");

        expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "must be a real directory"
        );

        rmSync(path.join(layout.releasesPath, FIRST_COMMIT), { force: true });
        const releasePath = await createManagedRelease(root, FIRST_COMMIT);
        writeFileSync(path.join(root, "current"), FIRST_COMMIT);
        expect(readDashboardReleaseState(root)).rejects.toThrow(
            "current slot must be a symlink"
        );

        rmSync(path.join(root, "current"));
        const outsideBackend = path.join(outside, "backend");
        renameSync(path.join(releasePath, "backend"), outsideBackend);
        symlinkSync(outsideBackend, path.join(releasePath, "backend"), "dir");
        expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "must not traverse symlinks"
        );
    });

    it("rejects managed links whose relative target escapes the release directory", async () => {
        const root = temporaryReleasesRoot();
        await ensureDashboardReleaseLayout(root);
        symlinkSync("releases/../outside", path.join(root, "current"), "dir");

        expect(readDashboardReleaseState(root)).rejects.toThrow("link target is invalid");
    });

    it("rejects a symlinked layout root before creating release directories", () => {
        const parent = temporaryReleasesRoot();
        const outside = mkdtempSync(path.join(tmpdir(), "mira-layout-outside-"));
        temporaryRoots.push(outside);
        const linkedRoot = path.join(parent, "linked-root");
        symlinkSync(outside, linkedRoot, "dir");

        expect(ensureDashboardReleaseLayout(linkedRoot)).rejects.toThrow(
            "must be a real directory"
        );
        expect(existsSync(path.join(outside, "releases"))).toBe(false);
    });

    it("blocks activation when the previous release cannot read the next schema", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        const candidatePath = await createManagedRelease(root, SECOND_COMMIT);
        await rewriteManifest(candidatePath, {
            migrationRegistrySha256: "c".repeat(64),
            schemaMaximum: 10,
            schemaMinimum: 6,
            schemaTarget: 10,
        });
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);

        expect(
            activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS)
        ).rejects.toThrow("cannot roll back after SQLite schema 10");
        expect(readlinkSync(path.join(root, "current"))).toBe(`releases/${FIRST_COMMIT}`);
        expect(existsSync(path.join(root, "previous"))).toBe(false);
    });

    it("blocks same-schema migration rewrites and unsafe Bun runtimes", async () => {
        const registryRoot = temporaryReleasesRoot();
        await createManagedRelease(registryRoot, FIRST_COMMIT);
        const rewrittenPath = await createManagedRelease(registryRoot, SECOND_COMMIT);
        await rewriteManifest(rewrittenPath, {
            migrationRegistrySha256: "d".repeat(64),
        });
        await activateDashboardRelease(FIRST_COMMIT, registryRoot, SCHEMA_6_OPTIONS);
        expect(
            activateDashboardRelease(SECOND_COMMIT, registryRoot, SCHEMA_6_OPTIONS)
        ).rejects.toThrow("migration registry changed");
        const restoredRegistryState = await restoreDashboardReleaseAfterFailedActivation(
            {
                ...SCHEMA_6_OPTIONS,
                expected: {
                    candidateCommitSha: SECOND_COMMIT,
                    previousCommitSha: undefined,
                    rollbackCommitSha: FIRST_COMMIT,
                },
            },
            registryRoot
        );
        expect(restoredRegistryState).toMatchObject({
            current: { commitSha: FIRST_COMMIT },
        });
        expect(restoredRegistryState.previous).toBeUndefined();

        const runtimeRoot = temporaryReleasesRoot();
        await createManagedRelease(
            runtimeRoot,
            FIRST_COMMIT,
            FIRST_COMMIT,
            "0.0.0+missing"
        );
        const incompatibleRelease = await loadManagedRelease(runtimeRoot, FIRST_COMMIT);
        expect(() => assertDashboardReleaseRuntimeAvailable(incompatibleRelease)).toThrow(
            "requires unavailable managed Bun runtime 0.0.0+missing"
        );
        const activationError = await captureRejection(() =>
            activateDashboardRelease(FIRST_COMMIT, runtimeRoot, {
                ...SCHEMA_6_OPTIONS,
                hasRuntime: () => false,
            })
        );
        expect(activationError).toBeInstanceOf(Error);
        expect((activationError as Error).message).toContain(
            "requires unavailable managed Bun runtime 0.0.0+missing"
        );

        const cachedMajorRuntimeRoot = temporaryReleasesRoot();
        await createManagedRelease(
            cachedMajorRuntimeRoot,
            FIRST_COMMIT,
            FIRST_COMMIT,
            "1.3.14+cached"
        );
        const cachedMajorRuntimeRelease = await loadManagedRelease(
            cachedMajorRuntimeRoot,
            FIRST_COMMIT
        );
        expect(() =>
            assertDashboardReleaseRuntimeAvailable(cachedMajorRuntimeRelease, {
                hasRuntime: (version) => version === "1.3.14+cached",
            })
        ).not.toThrow();
        expect(() =>
            assertDashboardReleaseRuntimeAvailable(cachedMajorRuntimeRelease, {
                hasRuntime: () => false,
            })
        ).toThrow("requires unavailable managed Bun runtime 1.3.14+cached");
    });

    it("checks the effective live schema after a code-only rollback", async () => {
        const root = temporaryReleasesRoot();
        const rollbackPath = await createManagedRelease(root, FIRST_COMMIT);
        const migratedPath = await createManagedRelease(root, SECOND_COMMIT);
        await createManagedRelease(root, THIRD_COMMIT);
        await rewriteManifest(rollbackPath, {
            schemaMaximum: 10,
        });
        await rewriteManifest(migratedPath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 10,
            schemaMinimum: 9,
            schemaTarget: 10,
        });

        let liveSchemaVersion = 9;
        const options = {
            hasRuntime: () => true,
            readLiveSchemaState: () => testLiveSchemaState(liveSchemaVersion),
        };
        await activateDashboardRelease(FIRST_COMMIT, root, options);
        await activateDashboardRelease(SECOND_COMMIT, root, options);
        liveSchemaVersion = 10;
        await rollbackDashboardRelease(root, options);

        expect(activateDashboardRelease(THIRD_COMMIT, root, options)).rejects.toThrow(
            "Activation release cannot open live SQLite schema 10"
        );
        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(FIRST_COMMIT);
        expect(state.previous?.commitSha).toBe(SECOND_COMMIT);
    });

    it("rejects a candidate whose migration identity differs from live history", async () => {
        const root = temporaryReleasesRoot();
        const currentPath = await createManagedRelease(root, FIRST_COMMIT);
        const candidatePath = await createManagedRelease(root, SECOND_COMMIT);
        await rewriteManifest(currentPath, {
            schemaMaximum: 10,
        });
        await rewriteManifest(candidatePath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 10,
            schemaMinimum: 9,
            schemaTarget: 10,
        });
        await activateDashboardRelease(FIRST_COMMIT, root, {
            hasRuntime: () => true,
            readLiveSchemaState: () => testLiveSchemaState(9),
        });

        expect(
            activateDashboardRelease(SECOND_COMMIT, root, {
                hasRuntime: () => true,
                readLiveSchemaState: () =>
                    testLiveSchemaState(10, {
                        10: {
                            ...TEST_FUTURE_MIGRATIONS[0]!,
                            checksum: "f".repeat(64),
                        },
                    }),
            })
        ).rejects.toThrow(
            "Activation release SQLite migration 10 identity does not match live history"
        );
    });

    it("allows coordinated activation and requires it across incompatible schemas", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        const candidatePath = await createManagedRelease(root, SECOND_COMMIT);
        await rewriteManifest(candidatePath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 10,
            schemaMinimum: 10,
            schemaTarget: 10,
        });

        let liveSchemaVersion = 9;
        const options = {
            hasRuntime: () => true,
            readLiveSchemaState: () => testLiveSchemaState(liveSchemaVersion),
        };
        await activateDashboardRelease(FIRST_COMMIT, root, options);
        expect(
            activateDashboardRelease(FIRST_COMMIT, root, {
                ...options,
                schemaCutoverMode: "coordinated",
            })
        ).resolves.toMatchObject({
            current: { commitSha: FIRST_COMMIT },
        });
        expect(activateDashboardRelease(SECOND_COMMIT, root, options)).rejects.toThrow(
            "cannot roll back after SQLite schema 10"
        );

        await runReleaseLifecycleCommand(
            ["activate", SECOND_COMMIT, "--coordinated-schema-cutover"],
            root,
            options
        );
        liveSchemaVersion = 10;
        expect(
            activateDashboardRelease(SECOND_COMMIT, root, {
                hasRuntime: () => true,
                readLiveSchemaState: () => testLiveSchemaState(11),
            })
        ).rejects.toThrow("Activation release cannot open live SQLite schema 11");
        expect(rollbackDashboardRelease(root, options)).rejects.toThrow(
            "Rollback release cannot open SQLite schema 10"
        );
        expect(readlinkSync(path.join(root, "current"))).toBe(
            `releases/${SECOND_COMMIT}`
        );
    });

    it("bases repeated code rollback compatibility on the live schema", async () => {
        const root = temporaryReleasesRoot();
        const compatibleOldPath = await createManagedRelease(root, FIRST_COMMIT);
        const migratedPath = await createManagedRelease(root, SECOND_COMMIT);
        await rewriteManifest(compatibleOldPath, {
            schemaMaximum: 10,
        });
        await rewriteManifest(migratedPath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 10,
            schemaMinimum: 10,
            schemaTarget: 10,
        });

        let liveSchemaVersion = 9;
        const options = {
            hasRuntime: () => true,
            readLiveSchemaState: () => testLiveSchemaState(liveSchemaVersion),
        };
        await activateDashboardRelease(FIRST_COMMIT, root, options);
        await activateDashboardRelease(SECOND_COMMIT, root, {
            ...options,
            schemaCutoverMode: "coordinated",
        });
        liveSchemaVersion = 10;

        const oldCode = await rollbackDashboardRelease(root, options);
        expect(oldCode.current?.commitSha).toBe(FIRST_COMMIT);
        const migratedCode = await rollbackDashboardRelease(root, options);
        expect(migratedCode.current?.commitSha).toBe(SECOND_COMMIT);
    });

    it("restores the prior slots from an interrupted activation journal", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await createManagedRelease(root, THIRD_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);

        const journal = {
            after: {
                current: THIRD_COMMIT,
                previous: SECOND_COMMIT,
            },
            before: {
                current: SECOND_COMMIT,
                previous: FIRST_COMMIT,
            },
            formatVersion: 1,
            operation: "activate",
        };
        writeFileSync(
            path.join(root, ".release-transition.json"),
            `${JSON.stringify(journal)}\n`
        );
        rmSync(path.join(root, "previous"));
        symlinkSync(`releases/${SECOND_COMMIT}`, path.join(root, "previous"), "dir");

        expect(readDashboardReleaseState(root)).rejects.toThrow(
            "requires activate, restore, or rollback to recover"
        );
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(true);

        const recovered = await restoreDashboardReleaseAfterFailedActivation(
            {
                ...SCHEMA_6_OPTIONS,
                expected: {
                    candidateCommitSha: THIRD_COMMIT,
                    previousCommitSha: FIRST_COMMIT,
                    rollbackCommitSha: SECOND_COMMIT,
                },
            },
            root
        );
        expect(recovered.current?.commitSha).toBe(SECOND_COMMIT);
        expect(recovered.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(existsSync(path.join(root, RELEASE_TRANSITION_LOCK_FILE_NAME))).toBe(true);
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(false);
    });

    it("recovers a journal when current changed before previous was linked", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        writeFileSync(
            path.join(root, ".release-transition.json"),
            `${JSON.stringify({
                after: {
                    current: SECOND_COMMIT,
                    previous: FIRST_COMMIT,
                },
                before: {
                    current: FIRST_COMMIT,
                    previous: false,
                },
                formatVersion: 1,
                operation: "activate",
            })}\n`
        );
        rmSync(path.join(root, "current"));
        symlinkSync(`releases/${SECOND_COMMIT}`, path.join(root, "current"), "dir");

        const recovered = await activateDashboardRelease(
            SECOND_COMMIT,
            root,
            SCHEMA_6_OPTIONS
        );
        expect(recovered.current?.commitSha).toBe(SECOND_COMMIT);
        expect(recovered.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(false);
    });

    it("serializes status and transitions with a kernel-owned lock", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        const lockFileDescriptor = holdTransitionLock(root);
        let preparationCalls = 0;

        try {
            const statusError = await captureRejection(() =>
                readDashboardReleaseState(root)
            );
            expect(statusError).toBeInstanceOf(Error);
            expect((statusError as Error).message).toContain(
                "Another managed release transition is in progress"
            );
            const activationError = await captureRejection(() =>
                activateDashboardRelease(SECOND_COMMIT, root, {
                    ...SCHEMA_6_OPTIONS,
                    prepareReleaseTransition: () => {
                        preparationCalls += 1;
                        return Promise.resolve({
                            rollback: () => Promise.resolve(),
                        });
                    },
                })
            );
            expect(activationError).toBeInstanceOf(Error);
            expect((activationError as Error).message).toContain(
                "Another managed release transition is in progress"
            );
            expect(preparationCalls).toBe(0);
            expect(readlinkSync(path.join(root, "current"))).toBe(
                `releases/${FIRST_COMMIT}`
            );
            expect(existsSync(path.join(root, "previous"))).toBe(false);
        } finally {
            closeSync(lockFileDescriptor);
        }
    });

    it("rejects invalid release transition lock wait values", () => {
        const root = temporaryReleasesRoot();

        for (const transitionLockWaitMs of [-1, Number.NaN, Infinity]) {
            expect(
                readDashboardReleaseState(root, { transitionLockWaitMs })
            ).rejects.toThrow(
                "Managed release transition lock wait must be a finite non-negative number"
            );
        }
    });

    it("lets lifecycle transitions wait for an in-flight status reader", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await readDashboardReleaseState(root);
        const lockFileDescriptor = holdTransitionLock(root, "shared");
        const activation = runReleaseLifecycleCommand(
            ["activate", FIRST_COMMIT],
            root,
            SCHEMA_6_OPTIONS
        );
        let isSettled = false;
        void (async () => {
            try {
                await activation;
            } catch {
                // The assertion below reports a rejected transition.
            } finally {
                isSettled = true;
            }
        })();

        try {
            await Bun.sleep(125);
            expect(isSettled).toBe(false);
        } finally {
            closeSync(lockFileDescriptor);
        }

        expect(activation).resolves.toMatchObject({
            current: { commitSha: FIRST_COMMIT },
        });
    });

    it("lets lifecycle status wait for an in-flight transition", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        const lockFileDescriptor = holdTransitionLock(root);
        const status = runReleaseLifecycleCommand(["status"], root);
        let isSettled = false;
        void (async () => {
            try {
                await status;
            } catch {
                // The assertion below reports a rejected status read.
            } finally {
                isSettled = true;
            }
        })();

        try {
            await Bun.sleep(125);
            expect(isSettled).toBe(false);
        } finally {
            closeSync(lockFileDescriptor);
        }

        expect(status).resolves.toMatchObject({
            current: { commitSha: FIRST_COMMIT },
        });
    });

    it("restores both prior slots when activation fails after changing a link", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        const candidatePath = await createManagedRelease(root, THIRD_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);

        expect(
            activateDashboardRelease(THIRD_COMMIT, root, {
                hasRuntime: () => true,
                readLiveSchemaState: () => {
                    rmSync(candidatePath, { force: true, recursive: true });
                    return testLiveSchemaState(6);
                },
            })
        ).rejects.toThrow();

        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(SECOND_COMMIT);
        expect(state.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(false);
        expect(existsSync(path.join(root, ".release-transition.lock"))).toBe(true);
    });

    it("rejects a candidate directory replaced during locked validation", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);

        expect(
            activateDashboardRelease(SECOND_COMMIT, root, {
                hasRuntime: () => true,
                readLiveSchemaState: async () => {
                    rmSync(managedReleasePath(root, SECOND_COMMIT), {
                        force: true,
                        recursive: true,
                    });
                    await createManagedRelease(root, SECOND_COMMIT);
                    return testLiveSchemaState(6);
                },
            })
        ).rejects.toThrow("Managed release snapshot changed before linking");
        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(FIRST_COMMIT);
        expect(state.previous).toBeUndefined();
    });

    it("restores the prior state when an artifact changes during the link switch", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        const candidatePath = await createManagedRelease(root, SECOND_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        const originalRename = fsp.rename.bind(fsp);
        let hasChangedCandidate = false;
        let preparationRollbacks = 0;
        const rename = spyOn(fsp, "rename").mockImplementation(
            async (oldPath, newPath) => {
                if (!hasChangedCandidate && newPath === path.join(root, "current")) {
                    hasChangedCandidate = true;
                    writeFileSync(
                        path.join(candidatePath, "dist", "assets", "app.js"),
                        "changed during activation\n"
                    );
                }
                return originalRename(oldPath, newPath);
            }
        );

        try {
            expect(
                activateDashboardRelease(SECOND_COMMIT, root, {
                    ...SCHEMA_6_OPTIONS,
                    prepareReleaseTransition: (target) => {
                        expect(target.commitSha).toBe(SECOND_COMMIT);
                        return Promise.resolve({
                            rollback: () => {
                                preparationRollbacks += 1;
                                return Promise.resolve();
                            },
                        });
                    },
                })
            ).rejects.toThrow("Managed release snapshot changed while linking");
        } finally {
            rename.mockRestore();
        }

        expect(preparationRollbacks).toBe(1);
        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(FIRST_COMMIT);
        expect(state.previous).toBeUndefined();
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(false);
    });

    it("requires two distinct releases before rollback", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        symlinkSync(`releases/${FIRST_COMMIT}`, path.join(root, "previous"), "dir");

        expect(rollbackDashboardRelease(root, SCHEMA_6_OPTIONS)).rejects.toThrow(
            "requires two distinct releases"
        );
    });

    it("prunes old releases while preserving current and previous", async () => {
        const root = temporaryReleasesRoot();
        const runtimeRoot = path.join(root, "runtimes");
        const obsoleteRuntimeIdentity = "2.0.0+deadbeef";
        const obsoleteRuntimeSource = path.join(root, "obsolete-bun");
        writeFileSync(
            obsoleteRuntimeSource,
            `#!/bin/sh
if [ "\${1:-}" = "--revision" ]; then
    printf '%s\\n' '${obsoleteRuntimeIdentity}'
else
    exit 2
fi
`
        );
        chmodSync(obsoleteRuntimeSource, 0o700);
        await installManagedBunRuntime(process.execPath, CURRENT_BUN_RUNTIME_IDENTITY, {
            runtimeRoot,
        });
        await installManagedBunRuntime(obsoleteRuntimeSource, obsoleteRuntimeIdentity, {
            runtimeRoot,
        });
        await createManagedRelease(
            root,
            FIRST_COMMIT,
            FIRST_COMMIT,
            CURRENT_BUN_RUNTIME_IDENTITY,
            new Date("2026-07-25T17:00:00.000Z")
        );
        await createManagedRelease(
            root,
            SECOND_COMMIT,
            SECOND_COMMIT,
            CURRENT_BUN_RUNTIME_IDENTITY,
            new Date("2026-07-25T17:01:00.000Z")
        );
        await createManagedRelease(
            root,
            THIRD_COMMIT,
            THIRD_COMMIT,
            CURRENT_BUN_RUNTIME_IDENTITY,
            new Date("2026-07-25T17:02:00.000Z")
        );
        await createManagedRelease(
            root,
            FOURTH_COMMIT,
            FOURTH_COMMIT,
            CURRENT_BUN_RUNTIME_IDENTITY,
            new Date("2026-07-25T17:03:00.000Z")
        );
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(THIRD_COMMIT, root, SCHEMA_6_OPTIONS);
        const interruptedRetirementPath = path.join(
            root,
            "releases",
            `.retired-${"e".repeat(40)}-00000000-0000-4000-8000-000000000000`
        );
        mkdirSync(interruptedRetirementPath);
        writeFileSync(path.join(interruptedRetirementPath, "stale"), "stale\n");
        const staleStagingPath = path.join(
            root,
            "releases",
            `.staging-${FIRST_COMMIT}-00000000-0000-4000-8000-000000000001`
        );
        mkdirSync(staleStagingPath);
        writeFileSync(path.join(staleStagingPath, "partial"), "partial\n");
        const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(staleStagingPath, staleTimestamp, staleTimestamp);
        const activeStagingPath = path.join(
            root,
            "releases",
            `.staging-${FOURTH_COMMIT}-00000000-0000-4000-8000-000000000002`
        );
        mkdirSync(activeStagingPath);
        writeFileSync(path.join(activeStagingPath, "partial"), "active\n");
        const unverifiableCommit = "e".repeat(40);
        const unverifiablePath = managedReleasePath(root, unverifiableCommit);
        mkdirSync(unverifiablePath);
        writeFileSync(path.join(unverifiablePath, "invalid"), "invalid\n");

        const result = await pruneDashboardReleases(3, root, runtimeRoot);

        expect(result).toEqual({
            removed: [FIRST_COMMIT],
            removedRuntimes: [obsoleteRuntimeIdentity],
            retained: [FOURTH_COMMIT, THIRD_COMMIT, SECOND_COMMIT],
            retainedRuntimes: [CURRENT_BUN_RUNTIME_IDENTITY],
            warnings: [`Skipped unverifiable release ${unverifiableCommit}`],
        });
        expect(hasManagedBunRuntime(CURRENT_BUN_RUNTIME_IDENTITY, runtimeRoot)).toBe(
            true
        );
        expect(hasManagedBunRuntime(obsoleteRuntimeIdentity, runtimeRoot)).toBe(false);
        expect(existsSync(managedReleasePath(root, FIRST_COMMIT))).toBe(false);
        expect(existsSync(managedReleasePath(root, SECOND_COMMIT))).toBe(true);
        expect(existsSync(managedReleasePath(root, THIRD_COMMIT))).toBe(true);
        expect(existsSync(managedReleasePath(root, FOURTH_COMMIT))).toBe(true);
        expect(existsSync(unverifiablePath)).toBe(true);
        expect(existsSync(interruptedRetirementPath)).toBe(false);
        expect(existsSync(staleStagingPath)).toBe(false);
        expect(existsSync(activeStagingPath)).toBe(true);
        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(THIRD_COMMIT);
        expect(state.previous?.commitSha).toBe(SECOND_COMMIT);
    });

    it("validates release retention bounds", () => {
        const root = temporaryReleasesRoot();
        expect(pruneDashboardReleases(2, root)).rejects.toThrow(
            "retention must be between 3 and 20"
        );
        expect(pruneDashboardReleases(21, root)).rejects.toThrow(
            "retention must be between 3 and 20"
        );
        expect(pruneDashboardReleases(Number.NaN, root)).rejects.toThrow(
            "retention must be between 3 and 20"
        );
    });
});
