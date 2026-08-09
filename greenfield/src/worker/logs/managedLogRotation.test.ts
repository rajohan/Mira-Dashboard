import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type {
    ManagedArchiveTarget,
    ManagedLogFileTarget,
    ManagedLogManifest,
} from "./managedLogManifest.ts";
import { validateManagedLogManifest } from "./managedLogManifest.ts";
import { createManagedLogRotationEngine } from "./managedLogRotation.ts";

const roots: string[] = [];
const ownerId = typeof process.getuid === "function" ? process.getuid() : 0;

interface Fixture {
    readonly archiveDirectory: string;
    readonly logDirectory: string;
    readonly manifest: ManagedLogManifest;
    readonly root: string;
    readonly stateDirectory: string;
}

async function fixture(
    options: {
        readonly archiveTargets?: readonly ManagedArchiveTarget[];
        readonly fileTargets?: readonly ManagedLogFileTarget[];
    } = {}
): Promise<Fixture> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-managed-logs-"));
    roots.push(root);
    const archiveDirectory = path.join(root, "archives");
    const logDirectory = path.join(root, "logs");
    const stateDirectory = path.join(root, "state");
    await Promise.all(
        [archiveDirectory, logDirectory, stateDirectory].map((directory) =>
            mkdir(directory, { mode: 0o700 })
        )
    );
    return {
        archiveDirectory,
        logDirectory,
        manifest: {
            archiveTargets: options.archiveTargets ?? [],
            fileTargets: options.fileTargets ?? [],
            lockPath: path.join(stateDirectory, "managed.lock"),
            statePath: path.join(stateDirectory, "managed-state.json"),
        },
        root,
        stateDirectory,
    };
}

function fileTarget(
    filePath: string,
    overrides: Partial<ManagedLogFileTarget> = {}
): ManagedLogFileTarget {
    return {
        compress: true,
        filePath,
        id: "dashboard.test",
        maximumSizeBytes: 4,
        maximumSourceBytes: 1024 * 1024,
        retentionAgeMs: 30 * 24 * 60 * 60 * 1000,
        retentionCount: 3,
        strategy: "copytruncate",
        trustedOwnerIds: [ownerId],
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await lstat(filePath);
        return true;
    } catch {
        return false;
    }
}

describe("managed log rotation engine", () => {
    test("copytruncates into a compressed archive and persists atomic bounded state", async () => {
        const base = await fixture();
        const source = path.join(base.logDirectory, "application.log");
        const contents = "first\nsecond\n";
        await writeFile(source, contents, { mode: 0o600 });
        const manifest = { ...base.manifest, fileTargets: [fileTarget(source)] };
        const clock = Date.parse("2026-08-09T12:00:00.000Z");
        const engine = createManagedLogRotationEngine({
            manifest,
            now: () => clock,
        });
        const summary = await engine.run();

        expect(summary).toMatchObject({ checkedTargets: 1, dryRun: false, ok: true });
        expect(summary.results).toContainEqual({
            action: "rotated",
            reason: "size",
            targetId: "dashboard.test",
        });
        expect(await readFile(source, "utf8")).toBe("");
        const directoryEntries = await readdir(base.logDirectory);
        const archives = directoryEntries.filter((name) => name.endsWith(".gz"));
        expect(archives).toHaveLength(1);
        expect(
            gunzipSync(
                await readFile(path.join(base.logDirectory, archives[0]!))
            ).toString()
        ).toBe(contents);
        const stateText = await readFile(manifest.statePath, "utf8");
        expect(JSON.parse(stateText)).toMatchObject({
            files: { "dashboard.test": { lastRotatedAtMs: clock } },
            version: 1,
        });
        const stateStatus = await lstat(manifest.statePath);
        expect(stateStatus.mode & 0o777).toBe(0o600);
        expect(await pathExists(manifest.lockPath)).toBe(false);
        expect(await engine.status()).toMatchObject({
            lastRun: { finishedAtMs: clock, ok: true, startedAtMs: clock },
            observedAtMs: clock,
            policyId: "docker-managed",
            targetCount: 1,
        });
    });

    test("dry-run reports size and retention work without mutating bytes or state", async () => {
        const base = await fixture();
        const source = path.join(base.logDirectory, "application.log");
        await writeFile(source, "oversize\n", { mode: 0o600 });
        const manifest = { ...base.manifest, fileTargets: [fileTarget(source)] };
        const summary = await createManagedLogRotationEngine({ manifest }).run({
            dryRun: true,
        });

        expect(summary.results[0]).toMatchObject({ action: "rotated", reason: "size" });
        expect(await readFile(source, "utf8")).toBe("oversize\n");
        expect(await readdir(base.logDirectory)).toEqual(["application.log"]);
        expect(await pathExists(manifest.statePath)).toBe(false);
        expect(await pathExists(manifest.lockPath)).toBe(false);
    });

    test("supports a policy-reviewed rename strategy with an immediate replacement", async () => {
        const base = await fixture();
        const source = path.join(base.logDirectory, "rename.log");
        await writeFile(source, "rename payload\n", { mode: 0o600 });
        const original = await lstat(source);
        const manifest = {
            ...base.manifest,
            fileTargets: [
                fileTarget(source, {
                    compress: false,
                    id: "dashboard.rename",
                    strategy: "rename",
                }),
            ],
        };
        await createManagedLogRotationEngine({ manifest }).run();

        expect(await readFile(source, "utf8")).toBe("");
        const replacement = await lstat(source);
        expect(replacement.ino).not.toBe(original.ino);
        const entries = await readdir(base.logDirectory);
        const archive = entries.find((name) => name.startsWith("rename.log."));
        expect(archive).toBeDefined();
        expect(await readFile(path.join(base.logDirectory, archive!), "utf8")).toBe(
            "rename payload\n"
        );
    });

    test("compresses and retains a bounded archive-only OpenClaw inventory", async () => {
        const base = await fixture();
        const old = new Date("2026-07-01T00:00:00.000Z");
        for (const day of ["01", "02", "03"]) {
            const filePath = path.join(
                base.archiveDirectory,
                `openclaw-2026-07-${day}.log`
            );
            await writeFile(filePath, `day ${day}\n`, { mode: 0o600 });
            await utimes(filePath, old, old);
        }
        const target: ManagedArchiveTarget = {
            compressAfterMs: 1,
            directoryPath: base.archiveDirectory,
            id: "openclaw.daily",
            kind: "openclaw-daily",
            maximumEntries: 10,
            maximumSourceBytes: 1024 * 1024,
            retentionAgeMs: 365 * 24 * 60 * 60 * 1000,
            retentionCount: 2,
            trustedOwnerIds: [ownerId],
        };
        const manifest = { ...base.manifest, archiveTargets: [target] };
        const summary = await createManagedLogRotationEngine({
            manifest,
            now: () => Date.parse("2026-08-09T12:00:00.000Z"),
        }).run();

        expect(summary.ok).toBe(true);
        expect(
            summary.results.filter(({ action }) => action === "compressed")
        ).toHaveLength(3);
        expect(summary.results.filter(({ action }) => action === "deleted")).toHaveLength(
            1
        );
        const retained = await readdir(base.archiveDirectory);
        expect(retained).toHaveLength(2);
        expect(retained.every((name) => name.endsWith(".log.gz"))).toBe(true);
    });

    test("fails closed for symlinks, hardlinks, unsafe modes, and oversized sources", async () => {
        const base = await fixture();
        const outside = path.join(base.root, "outside.log");
        const hardlinked = path.join(base.logDirectory, "hardlinked.log");
        const symlinked = path.join(base.logDirectory, "symlinked.log");
        const oversized = path.join(base.logDirectory, "oversized.log");
        const unsafeMode = path.join(base.logDirectory, "unsafe-mode.log");
        await writeFile(outside, "private bytes\n", { mode: 0o600 });
        await Promise.all([
            link(outside, hardlinked),
            symlink(outside, symlinked),
            writeFile(oversized, "x".repeat(32), { mode: 0o600 }),
            writeFile(unsafeMode, "unsafe\n", { mode: 0o600 }),
        ]);
        await chmod(unsafeMode, 0o622);
        const manifest = {
            ...base.manifest,
            fileTargets: [
                fileTarget(hardlinked, { id: "dashboard.hardlink" }),
                fileTarget(symlinked, { id: "dashboard.symlink" }),
                fileTarget(oversized, {
                    id: "dashboard.oversized",
                    maximumSourceBytes: 16,
                    maximumSizeBytes: 8,
                }),
                fileTarget(unsafeMode, { id: "dashboard.unsafe-mode" }),
            ],
        };
        const summary = await createManagedLogRotationEngine({ manifest }).run();

        expect(summary.ok).toBe(false);
        expect(summary.results).toHaveLength(4);
        expect(summary.results.every(({ action }) => action === "error")).toBe(true);
        expect(JSON.stringify(summary)).not.toContain(base.root);
        expect(JSON.stringify(summary)).not.toContain("private bytes");
        expect(await readFile(outside, "utf8")).toBe("private bytes\n");
    });

    test("rejects a fresh lock and never removes another active run's inode", async () => {
        const base = await fixture();
        await writeFile(
            base.manifest.lockPath,
            JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }),
            { mode: 0o600 }
        );
        const before = await lstat(base.manifest.lockPath);
        expect(
            createManagedLogRotationEngine({ manifest: base.manifest }).run()
        ).rejects.toThrow("Managed log maintenance failed");
        const after = await lstat(base.manifest.lockPath);
        expect(after.ino).toBe(before.ino);
    });

    test("reclaims only a stale lock whose recorded process is not alive", async () => {
        const base = await fixture();
        const clock = Date.parse("2026-08-09T12:00:00.000Z");
        await writeFile(
            base.manifest.lockPath,
            JSON.stringify({
                pid: 2_000_000_000,
                startedAtMs: clock - 3 * 60 * 60 * 1000,
            }),
            { mode: 0o600 }
        );
        const result = await createManagedLogRotationEngine({
            manifest: base.manifest,
            now: () => clock,
        }).run();
        expect(result.ok).toBe(true);
        expect(await pathExists(base.manifest.lockPath)).toBe(false);
    });

    test("validates fixed paths and bounded manifest policies before I/O", () => {
        expect(() =>
            validateManagedLogManifest({
                archiveTargets: [],
                fileTargets: [fileTarget("relative.log")],
                lockPath: "/tmp/state/lock",
                statePath: "/tmp/state/status",
            })
        ).toThrow("Managed log manifest is invalid");
    });
});
