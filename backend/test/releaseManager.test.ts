import { spawnSync } from "node:child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { runReleaseLifecycleCommand } from "../src/releaseLifecycle.ts";
import {
    activateDashboardRelease,
    ensureDashboardReleaseLayout,
    loadManagedRelease,
    managedReleasePath,
    readDashboardReleaseState,
    resolveDashboardReleasesRoot,
    rollbackDashboardRelease,
} from "../src/releaseManager.ts";
import {
    loadReleaseManifest,
    parseReleaseManifest,
    RELEASE_MANIFEST_FILE_NAME,
    writeReleaseManifest,
} from "../src/releaseManifest.ts";

const temporaryRoots: string[] = [];
const FIRST_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "b".repeat(40);
const THIRD_COMMIT = "c".repeat(40);
const SCHEMA_6_OPTIONS = {
    readLiveSchemaVersion: () => 6,
};

function holdTransitionLock(releasesRoot: string): number {
    const lockFileDescriptor = openSync(
        path.join(releasesRoot, ".release-transition.lock"),
        "r+"
    );
    const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "pipe", lockFileDescriptor],
    });
    if (result.error || result.status !== 0) {
        closeSync(lockFileDescriptor);
        throw new Error("Test release transition lock did not become ready");
    }
    return lockFileDescriptor;
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
    bunVersion = Bun.version
): Promise<string> {
    await ensureDashboardReleaseLayout(releasesRoot);
    const releasePath = managedReleasePath(releasesRoot, directoryCommit);
    mkdirSync(path.join(releasePath, "backend", "config"), { recursive: true });
    mkdirSync(path.join(releasePath, "backend", "dist"), { recursive: true });
    mkdirSync(path.join(releasePath, "dist", "assets"), { recursive: true });
    writeFileSync(path.join(releasePath, "package.json"), "{}\n");
    writeFileSync(path.join(releasePath, "bun.lock"), "root-lock\n");
    writeFileSync(path.join(releasePath, "backend", "package.json"), "{}\n");
    writeFileSync(path.join(releasePath, "backend", "bun.lock"), "backend-lock\n");
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
        builtAt: new Date("2026-07-25T17:00:00.000Z"),
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
            ...(changes.migrationRegistrySha256 && {
                migrationRegistrySha256: changes.migrationRegistrySha256,
            }),
            ...(changes.schemaMaximum !== undefined && {
                maximumCompatible: changes.schemaMaximum,
            }),
            ...(changes.schemaMinimum !== undefined && {
                minimumCompatible: changes.schemaMinimum,
            }),
            ...(changes.schemaTarget !== undefined && {
                target: changes.schemaTarget,
            }),
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

    it("exposes bounded lifecycle command summaries without artifact contents", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);

        await expect(runReleaseLifecycleCommand(["status"], root)).resolves.toEqual({
            current: undefined,
            previous: undefined,
            root,
        });
        await expect(runReleaseLifecycleCommand(["activate"], root)).rejects.toThrow(
            "requires a commit SHA"
        );
        await expect(runReleaseLifecycleCommand([], root)).rejects.toThrow(
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
        const rolledBack = await runReleaseLifecycleCommand(
            ["rollback"],
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
        expect(status.current).not.toHaveProperty("manifest");
        await expect(
            runReleaseLifecycleCommand(["rollback", FIRST_COMMIT], root)
        ).rejects.toThrow("takes no commit SHA");
        await expect(runReleaseLifecycleCommand(["rollback", ""], root)).rejects.toThrow(
            "takes no commit SHA"
        );
        await expect(runReleaseLifecycleCommand(["status", ""], root)).rejects.toThrow(
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

        await expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "contains manifest"
        );

        rmSync(mismatchedPath, { force: true, recursive: true });
        const releasePath = await createManagedRelease(root, FIRST_COMMIT);
        writeFileSync(path.join(releasePath, "dist", "index.html"), "tampered\n");
        await expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "Release artifact verification failed"
        );
    });

    it("revalidates component build identities when loading a managed release", async () => {
        const root = temporaryReleasesRoot();
        const originalPath = await createManagedRelease(root, FIRST_COMMIT);
        const relabeledPath = managedReleasePath(root, SECOND_COMMIT);
        renameSync(originalPath, relabeledPath);
        await rewriteManifest(relabeledPath, { commitSha: SECOND_COMMIT });

        await expect(loadManagedRelease(root, SECOND_COMMIT)).rejects.toThrow(
            "backend build identity does not match the release manifest"
        );
    });

    it("rejects symlinked release directories and non-symlink state slots", async () => {
        const root = temporaryReleasesRoot();
        const outside = mkdtempSync(path.join(tmpdir(), "mira-release-outside-"));
        temporaryRoots.push(outside);
        const layout = await ensureDashboardReleaseLayout(root);
        symlinkSync(outside, path.join(layout.releasesPath, FIRST_COMMIT), "dir");

        await expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "must be a real directory"
        );

        rmSync(path.join(layout.releasesPath, FIRST_COMMIT), { force: true });
        const releasePath = await createManagedRelease(root, FIRST_COMMIT);
        writeFileSync(path.join(root, "current"), FIRST_COMMIT);
        await expect(readDashboardReleaseState(root)).rejects.toThrow(
            "current slot must be a symlink"
        );

        rmSync(path.join(root, "current"));
        const outsideBackend = path.join(outside, "backend");
        renameSync(path.join(releasePath, "backend"), outsideBackend);
        symlinkSync(outsideBackend, path.join(releasePath, "backend"), "dir");
        await expect(loadManagedRelease(root, FIRST_COMMIT)).rejects.toThrow(
            "must not traverse symlinks"
        );
    });

    it("rejects managed links whose relative target escapes the release directory", async () => {
        const root = temporaryReleasesRoot();
        await ensureDashboardReleaseLayout(root);
        symlinkSync("releases/../outside", path.join(root, "current"), "dir");

        await expect(readDashboardReleaseState(root)).rejects.toThrow(
            "link target is invalid"
        );
    });

    it("rejects a symlinked layout root before creating release directories", async () => {
        const parent = temporaryReleasesRoot();
        const outside = mkdtempSync(path.join(tmpdir(), "mira-layout-outside-"));
        temporaryRoots.push(outside);
        const linkedRoot = path.join(parent, "linked-root");
        symlinkSync(outside, linkedRoot, "dir");

        await expect(ensureDashboardReleaseLayout(linkedRoot)).rejects.toThrow(
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
            schemaMaximum: 7,
            schemaMinimum: 6,
            schemaTarget: 7,
        });
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);

        await expect(
            activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS)
        ).rejects.toThrow("cannot roll back after SQLite schema 7");
        expect(readlinkSync(path.join(root, "current"))).toBe(`releases/${FIRST_COMMIT}`);
        expect(existsSync(path.join(root, "previous"))).toBe(false);
    });

    it("blocks same-schema migration rewrites and mismatched Bun runtimes", async () => {
        const registryRoot = temporaryReleasesRoot();
        await createManagedRelease(registryRoot, FIRST_COMMIT);
        const rewrittenPath = await createManagedRelease(registryRoot, SECOND_COMMIT);
        await rewriteManifest(rewrittenPath, {
            migrationRegistrySha256: "d".repeat(64),
        });
        await activateDashboardRelease(FIRST_COMMIT, registryRoot, SCHEMA_6_OPTIONS);
        await expect(
            activateDashboardRelease(SECOND_COMMIT, registryRoot, SCHEMA_6_OPTIONS)
        ).rejects.toThrow("migration registry changed");

        const runtimeRoot = temporaryReleasesRoot();
        await createManagedRelease(runtimeRoot, FIRST_COMMIT, FIRST_COMMIT, "0.0.0");
        await expect(
            activateDashboardRelease(FIRST_COMMIT, runtimeRoot, SCHEMA_6_OPTIONS)
        ).rejects.toThrow("requires Bun 0.0.0");
    });

    it("checks the effective live schema after a code-only rollback", async () => {
        const root = temporaryReleasesRoot();
        const rollbackPath = await createManagedRelease(root, FIRST_COMMIT);
        const migratedPath = await createManagedRelease(root, SECOND_COMMIT);
        await createManagedRelease(root, THIRD_COMMIT);
        await rewriteManifest(rollbackPath, {
            schemaMaximum: 7,
        });
        await rewriteManifest(migratedPath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 7,
            schemaMinimum: 6,
            schemaTarget: 7,
        });

        let liveSchemaVersion = 6;
        const options = {
            readLiveSchemaVersion: () => liveSchemaVersion,
        };
        await activateDashboardRelease(FIRST_COMMIT, root, options);
        await activateDashboardRelease(SECOND_COMMIT, root, options);
        liveSchemaVersion = 7;
        await rollbackDashboardRelease(root, options);

        await expect(
            activateDashboardRelease(THIRD_COMMIT, root, options)
        ).rejects.toThrow("Activation release cannot open live SQLite schema 7");
        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(FIRST_COMMIT);
        expect(state.previous?.commitSha).toBe(SECOND_COMMIT);
    });

    it("requires an explicit coordinated mode for incompatible schema cutovers", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        const candidatePath = await createManagedRelease(root, SECOND_COMMIT);
        await rewriteManifest(candidatePath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 7,
            schemaMinimum: 7,
            schemaTarget: 7,
        });

        let liveSchemaVersion = 6;
        const options = {
            readLiveSchemaVersion: () => liveSchemaVersion,
        };
        await activateDashboardRelease(FIRST_COMMIT, root, options);
        await expect(
            activateDashboardRelease(FIRST_COMMIT, root, {
                ...options,
                schemaCutoverMode: "coordinated",
            })
        ).rejects.toThrow(
            "Coordinated schema cutover mode requires an incompatible schema boundary"
        );
        await expect(
            activateDashboardRelease(SECOND_COMMIT, root, options)
        ).rejects.toThrow("cannot roll back after SQLite schema 7");

        await runReleaseLifecycleCommand(
            ["activate", SECOND_COMMIT, "--coordinated-schema-cutover"],
            root,
            options
        );
        liveSchemaVersion = 7;
        await expect(
            activateDashboardRelease(SECOND_COMMIT, root, {
                readLiveSchemaVersion: () => 8,
            })
        ).rejects.toThrow("Activation release cannot open live SQLite schema 8");
        await expect(rollbackDashboardRelease(root, options)).rejects.toThrow(
            "Rollback release cannot open SQLite schema 7"
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
            schemaMaximum: 7,
        });
        await rewriteManifest(migratedPath, {
            migrationRegistrySha256: "d".repeat(64),
            schemaMaximum: 7,
            schemaMinimum: 7,
            schemaTarget: 7,
        });

        let liveSchemaVersion = 6;
        const options = {
            readLiveSchemaVersion: () => liveSchemaVersion,
        };
        await activateDashboardRelease(FIRST_COMMIT, root, options);
        await activateDashboardRelease(SECOND_COMMIT, root, {
            ...options,
            schemaCutoverMode: "coordinated",
        });
        liveSchemaVersion = 7;

        const oldCode = await rollbackDashboardRelease(root, options);
        expect(oldCode.current?.commitSha).toBe(FIRST_COMMIT);
        const migratedCode = await rollbackDashboardRelease(root, options);
        expect(migratedCode.current?.commitSha).toBe(SECOND_COMMIT);
    });

    it("recovers the prior slots from an interrupted activation journal", async () => {
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

        const recovered = await readDashboardReleaseState(root);
        expect(recovered.current?.commitSha).toBe(SECOND_COMMIT);
        expect(recovered.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(existsSync(path.join(root, ".release-transition.lock"))).toBe(true);
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(false);
    });

    it("serializes status and transitions with a kernel-owned lock", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        const lockFileDescriptor = holdTransitionLock(root);

        try {
            await expect(readDashboardReleaseState(root)).rejects.toThrow(
                "Another managed release transition is in progress"
            );
            await expect(
                activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS)
            ).rejects.toThrow("Another managed release transition is in progress");
            expect(readlinkSync(path.join(root, "current"))).toBe(
                `releases/${FIRST_COMMIT}`
            );
            expect(existsSync(path.join(root, "previous"))).toBe(false);
        } finally {
            closeSync(lockFileDescriptor);
        }
    });

    it("restores both prior slots when activation fails after changing a link", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await createManagedRelease(root, SECOND_COMMIT);
        const candidatePath = await createManagedRelease(root, THIRD_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        await activateDashboardRelease(SECOND_COMMIT, root, SCHEMA_6_OPTIONS);

        await expect(
            activateDashboardRelease(THIRD_COMMIT, root, {
                readLiveSchemaVersion: () => {
                    rmSync(candidatePath, { force: true, recursive: true });
                    return 6;
                },
            })
        ).rejects.toThrow();

        const state = await readDashboardReleaseState(root);
        expect(state.current?.commitSha).toBe(SECOND_COMMIT);
        expect(state.previous?.commitSha).toBe(FIRST_COMMIT);
        expect(existsSync(path.join(root, ".release-transition.json"))).toBe(false);
        expect(existsSync(path.join(root, ".release-transition.lock"))).toBe(true);
    });

    it("requires two distinct releases before rollback", async () => {
        const root = temporaryReleasesRoot();
        await createManagedRelease(root, FIRST_COMMIT);
        await activateDashboardRelease(FIRST_COMMIT, root, SCHEMA_6_OPTIONS);
        symlinkSync(`releases/${FIRST_COMMIT}`, path.join(root, "previous"), "dir");

        await expect(rollbackDashboardRelease(root, SCHEMA_6_OPTIONS)).rejects.toThrow(
            "requires two distinct releases"
        );
    });
});
