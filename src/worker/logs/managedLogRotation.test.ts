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

import { createLogRotationEpochProbe } from "../../server/platform/logs/logRotationEpochProbe.ts";
import { createSafeLogReader } from "../../server/platform/logs/safeLogReader.ts";
import { createLogSourceCatalog } from "../../server/platform/logs/sourceCatalog.ts";
import { logRotationEpochProjectionFileName } from "../../shared/logRotationEpochProjection.ts";
import type {
    ManagedArchiveTarget,
    ManagedLogFileTarget,
    ManagedLogManifest,
} from "./managedLogManifest.ts";
import { validateManagedLogManifest } from "./managedLogManifest.ts";
import { createManagedLogRotationEngine } from "./managedLogRotation.ts";

const roots: string[] = [];
const ownerId = typeof process.getuid === "function" ? process.getuid() : 0;
const retainedEpoch = "019feb02-8b7e-72ab-8f76-19b2ce15c8ef";

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve() {
            resolvePromise?.();
        },
    };
}

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

async function expectRejection(
    operation: Promise<unknown>,
    expectedMessage: string
): Promise<void> {
    try {
        await operation;
    } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(expectedMessage);
        return;
    }
    throw new Error("Expected operation to reject");
}

async function readEpochProjection(stateDirectory: string): Promise<{
    readonly entries: readonly {
        readonly epoch: string;
        readonly sourceId: string;
        readonly state: "committed" | "rotating";
    }[];
    readonly version: number;
}> {
    return JSON.parse(
        await readFile(
            path.join(stateDirectory, logRotationEpochProjectionFileName),
            "utf8"
        )
    ) as {
        readonly entries: readonly {
            readonly epoch: string;
            readonly sourceId: string;
            readonly state: "committed" | "rotating";
        }[];
        readonly version: number;
    };
}

function createLogAccess(base: Fixture) {
    const probe = createLogRotationEpochProbe({
        logMaintenanceRoot: base.stateDirectory,
    });
    return {
        probe,
        reader: createSafeLogReader(
            createLogSourceCatalog({
                dashboardLogsRoot: base.logDirectory,
                hostLogsRoot: base.archiveDirectory,
                hostOwnerIds: [ownerId],
                openClawLogsRoot: base.archiveDirectory,
            }),
            () => 100,
            probe
        ),
    };
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
            new TextDecoder().decode(
                Bun.gunzipSync(await readFile(path.join(base.logDirectory, archives[0]!)))
            )
        ).toBe(contents);
        const stateText = await readFile(manifest.statePath, "utf8");
        expect(JSON.parse(stateText)).toMatchObject({
            files: { "dashboard.test": { lastRotatedAtMs: clock } },
            version: 1,
        });
        const stateStatus = await lstat(manifest.statePath);
        expect(stateStatus.mode & 0o777).toBe(0o600);
        const epochPath = path.join(
            base.stateDirectory,
            logRotationEpochProjectionFileName
        );
        const epochProjection = JSON.parse(await readFile(epochPath, "utf8")) as {
            readonly entries: readonly {
                readonly epoch: string;
                readonly sourceId: string;
                readonly state: "committed" | "rotating";
            }[];
            readonly version: number;
        };
        expect(epochProjection).toMatchObject({
            entries: [
                {
                    sourceId: "dashboard.test",
                    state: "committed",
                },
            ],
            version: 1,
        });
        expect(epochProjection.entries[0]?.epoch).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        );
        const epochStatus = await lstat(epochPath);
        expect(epochStatus.mode & 0o777).toBe(0o600);
        expect(await pathExists(manifest.lockPath)).toBe(false);
        expect(await engine.status()).toMatchObject({
            lastRun: { finishedAtMs: clock, ok: true, startedAtMs: clock },
            observedAtMs: clock,
            policyId: "docker-managed",
            targetCount: 1,
        });
    });

    test("fails closed during the pre-truncate phase and commits a new exact-prefix generation", async () => {
        const base = await fixture();
        const sourceId = "dashboard.web.stdout";
        const source = path.join(base.logDirectory, "web-stdout.log");
        const contents = "same line\n";
        await writeFile(source, contents, { mode: 0o600 });
        await writeFile(
            path.join(base.stateDirectory, logRotationEpochProjectionFileName),
            `${JSON.stringify({
                entries: [
                    {
                        epoch: retainedEpoch,
                        sourceId: "dashboard.worker.stdout",
                        state: "committed",
                    },
                ],
                version: 1,
            })}\n`,
            { mode: 0o600 }
        );
        const manifest = {
            ...base.manifest,
            fileTargets: [
                fileTarget(source, {
                    id: sourceId,
                    maximumSizeBytes: 1,
                }),
                fileTarget(path.join(base.logDirectory, "worker-stdout.log"), {
                    id: "dashboard.worker.stdout",
                }),
            ],
        };
        const { probe, reader } = createLogAccess(base);
        const before = await reader.tail({ limit: 10, sourceId });
        const beforeId = before.lines[0]?.id;
        expect(beforeId).toBeDefined();

        const markedRotating = deferred();
        const continueTruncate = deferred();
        let markedSourceId: string | undefined;
        const run = createManagedLogRotationEngine({
            manifest,
            testHooks: {
                async afterCopyTruncateMarkedRotating(observedSourceId) {
                    markedSourceId = observedSourceId;
                    markedRotating.resolve();
                    await continueTruncate.promise;
                },
            },
        }).run();
        await markedRotating.promise;
        try {
            expect(markedSourceId).toBe(sourceId);
            expect(await readFile(source, "utf8")).toBe(contents);
            expect(await readEpochProjection(base.stateDirectory)).toMatchObject({
                entries: [
                    { sourceId, state: "rotating" },
                    {
                        epoch: retainedEpoch,
                        sourceId: "dashboard.worker.stdout",
                        state: "committed",
                    },
                ],
                version: 1,
            });
            await expectRejection(
                probe.epoch(sourceId),
                "Log rotation epoch is unavailable"
            );
            expect(await probe.epoch("dashboard.worker.stdout")).toBe(retainedEpoch);
            await expectRejection(
                reader.tail({ limit: 10, sourceId }),
                "Log source is unavailable"
            );
        } finally {
            continueTruncate.resolve();
        }

        expect(await run).toMatchObject({ ok: true });
        expect(await readFile(source, "utf8")).toBe("");
        const committedProjection = await readEpochProjection(base.stateDirectory);
        expect(committedProjection).toMatchObject({
            entries: [
                { sourceId, state: "committed" },
                {
                    epoch: retainedEpoch,
                    sourceId: "dashboard.worker.stdout",
                    state: "committed",
                },
            ],
            version: 1,
        });
        await writeFile(source, contents);
        const replacement = await reader.tail({ limit: 10, sourceId });
        expect(replacement.lines[0]?.line).toBe("same line");
        expect(replacement.lines[0]?.id).not.toBe(beforeId);
    });

    test("recovers old pre-truncate bytes on a new engine under the persisted epoch", async () => {
        const base = await fixture();
        const sourceId = "dashboard.web.stdout";
        const source = path.join(base.logDirectory, "web-stdout.log");
        const contents = "same line\nold bytes\n";
        await writeFile(source, contents, { mode: 0o600 });
        await writeFile(
            path.join(base.stateDirectory, logRotationEpochProjectionFileName),
            `${JSON.stringify({
                entries: [
                    {
                        epoch: retainedEpoch,
                        sourceId: "dashboard.worker.stdout",
                        state: "committed",
                    },
                ],
                version: 1,
            })}\n`,
            { mode: 0o600 }
        );
        const manifest = {
            ...base.manifest,
            fileTargets: [
                fileTarget(source, { id: sourceId, maximumSizeBytes: 1 }),
                fileTarget(path.join(base.logDirectory, "worker-stdout.log"), {
                    id: "dashboard.worker.stdout",
                }),
            ],
        };
        const { probe, reader } = createLogAccess(base);
        const before = await reader.tail({ limit: 10, sourceId });
        const beforeId = before.lines[0]?.id;
        expect(beforeId).toBeDefined();

        const interrupted = await createManagedLogRotationEngine({
            manifest,
            testHooks: {
                afterCopyTruncateMarkedRotating() {
                    throw new Error("simulated shutdown");
                },
            },
        }).run();
        expect(interrupted).toMatchObject({ ok: false });
        expect(interrupted.results).toContainEqual({
            action: "error",
            reason: "invalid-source",
            targetId: sourceId,
        });
        expect(await readFile(source, "utf8")).toBe(contents);
        const rotatingProjection = await readEpochProjection(base.stateDirectory);
        expect(rotatingProjection).toMatchObject({
            entries: [
                {
                    sourceId,
                    state: "rotating",
                },
                {
                    epoch: retainedEpoch,
                    sourceId: "dashboard.worker.stdout",
                    state: "committed",
                },
            ],
            version: 1,
        });
        const pendingEpoch = rotatingProjection.entries.find(
            (entry) => entry.sourceId === sourceId
        )?.epoch;
        expect(pendingEpoch).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        );
        await expectRejection(probe.epoch(sourceId), "Log rotation epoch is unavailable");
        await expectRejection(
            reader.tail({ limit: 10, sourceId }),
            "Log source is unavailable"
        );
        expect(await probe.epoch("dashboard.worker.stdout")).toBe(retainedEpoch);

        const recovered = await createManagedLogRotationEngine({ manifest }).run();
        expect(recovered).toMatchObject({ ok: true });
        expect(recovered.results).toContainEqual({
            action: "rotated",
            reason: "recovery",
            targetId: sourceId,
        });
        expect(await readFile(source, "utf8")).toBe("");
        const committedProjection = await readEpochProjection(base.stateDirectory);
        expect(committedProjection).toMatchObject({
            entries: [
                {
                    epoch: pendingEpoch,
                    sourceId,
                    state: "committed",
                },
                {
                    epoch: retainedEpoch,
                    sourceId: "dashboard.worker.stdout",
                    state: "committed",
                },
            ],
            version: 1,
        });
        expect(await probe.epoch(sourceId)).toBe(pendingEpoch);
        expect(await probe.epoch("dashboard.worker.stdout")).toBe(retainedEpoch);
        const archiveNames = await readdir(base.logDirectory);
        const archivedContents = await Promise.all(
            archiveNames
                .filter((name) => name.endsWith(".gz"))
                .map(async (name) =>
                    new TextDecoder().decode(
                        Bun.gunzipSync(await readFile(path.join(base.logDirectory, name)))
                    )
                )
        );
        expect(archivedContents).toContain(contents);
        const recoveredEmptySnapshot = await reader.tail({ limit: 10, sourceId });
        expect(recoveredEmptySnapshot.lines).toEqual([]);
        await writeFile(source, contents);
        const replacement = await reader.tail({ limit: 10, sourceId });
        expect(replacement.lines[0]?.line).toBe("same line");
        expect(replacement.lines[0]?.id).not.toBe(beforeId);
        expect(await pathExists(manifest.lockPath)).toBe(false);
    });

    test("settles a pending epoch when the source disappears before recovery", async () => {
        const base = await fixture();
        const sourceId = "dashboard.web.stdout";
        const source = path.join(base.logDirectory, "web-stdout.log");
        await writeFile(source, "pending bytes\n", { mode: 0o600 });
        const manifest = {
            ...base.manifest,
            fileTargets: [fileTarget(source, { id: sourceId, maximumSizeBytes: 1 })],
        };
        const { probe, reader } = createLogAccess(base);

        const interrupted = await createManagedLogRotationEngine({
            manifest,
            testHooks: {
                afterCopyTruncateMarkedRotating() {
                    throw new Error("simulated shutdown");
                },
            },
        }).run();
        expect(interrupted).toMatchObject({ ok: false });
        const rotatingProjection = await readEpochProjection(base.stateDirectory);
        const pendingEpoch = rotatingProjection.entries[0]?.epoch;
        expect(rotatingProjection).toMatchObject({
            entries: [{ epoch: pendingEpoch, sourceId, state: "rotating" }],
            version: 1,
        });
        await rm(source);

        const recovered = await createManagedLogRotationEngine({ manifest }).run();
        expect(recovered).toMatchObject({ ok: true });
        expect(recovered.results).toContainEqual({
            action: "missing",
            reason: "missing",
            targetId: sourceId,
        });
        expect(await readEpochProjection(base.stateDirectory)).toMatchObject({
            entries: [{ epoch: pendingEpoch, sourceId, state: "committed" }],
            version: 1,
        });
        expect(await probe.epoch(sourceId)).toBe(pendingEpoch);

        await writeFile(source, "replacement\n", { mode: 0o600 });
        const replacement = await reader.tail({ limit: 10, sourceId });
        expect(replacement.lines[0]?.line).toBe("replacement");
    });

    test.each([
        { name: "empty source", regrowth: "" },
        { name: "small exact-prefix regrowth", regrowth: "same line\n" },
    ])(
        "recovers a post-sync $name on a new engine without committing prematurely",
        async ({ regrowth }) => {
            const base = await fixture();
            const sourceId = "dashboard.web.stdout";
            const source = path.join(base.logDirectory, "web-stdout.log");
            const contents = "same line\nold tail that exceeds the threshold\n";
            await writeFile(source, contents, { mode: 0o600 });
            await writeFile(
                path.join(base.stateDirectory, logRotationEpochProjectionFileName),
                `${JSON.stringify({
                    entries: [
                        {
                            epoch: retainedEpoch,
                            sourceId: "dashboard.worker.stdout",
                            state: "committed",
                        },
                    ],
                    version: 1,
                })}\n`,
                { mode: 0o600 }
            );
            const manifest = {
                ...base.manifest,
                fileTargets: [
                    fileTarget(source, {
                        id: sourceId,
                        maximumSizeBytes: 16,
                    }),
                    fileTarget(path.join(base.logDirectory, "worker-stdout.log"), {
                        id: "dashboard.worker.stdout",
                    }),
                ],
            };
            const { probe, reader } = createLogAccess(base);
            const before = await reader.tail({ limit: 10, sourceId });
            const beforeId = before.lines[0]?.id;
            expect(beforeId).toBeDefined();

            const interrupted = await createManagedLogRotationEngine({
                manifest,
                testHooks: {
                    afterCopyTruncateSynced() {
                        throw new Error("simulated shutdown");
                    },
                },
            }).run();
            expect(interrupted).toMatchObject({ ok: false });
            expect(await readFile(source, "utf8")).toBe("");
            const rotatingProjection = await readEpochProjection(base.stateDirectory);
            const pendingEpoch = rotatingProjection.entries.find(
                (entry) => entry.sourceId === sourceId
            )?.epoch;
            expect(rotatingProjection).toMatchObject({
                entries: [
                    { epoch: pendingEpoch, sourceId, state: "rotating" },
                    {
                        epoch: retainedEpoch,
                        sourceId: "dashboard.worker.stdout",
                        state: "committed",
                    },
                ],
                version: 1,
            });
            if (regrowth !== "") await writeFile(source, regrowth);
            expect(Buffer.byteLength(regrowth)).toBeLessThan(16);
            await expectRejection(
                probe.epoch(sourceId),
                "Log rotation epoch is unavailable"
            );
            await expectRejection(
                reader.tail({ limit: 10, sourceId }),
                "Log source is unavailable"
            );
            expect(await probe.epoch("dashboard.worker.stdout")).toBe(retainedEpoch);

            const recovered = await createManagedLogRotationEngine({ manifest }).run();
            expect(recovered).toMatchObject({ ok: true });
            expect(recovered.results).toContainEqual({
                action: "rotated",
                reason: "recovery",
                targetId: sourceId,
            });
            expect(await readFile(source, "utf8")).toBe("");
            expect(await readEpochProjection(base.stateDirectory)).toMatchObject({
                entries: [
                    { epoch: pendingEpoch, sourceId, state: "committed" },
                    {
                        epoch: retainedEpoch,
                        sourceId: "dashboard.worker.stdout",
                        state: "committed",
                    },
                ],
                version: 1,
            });
            expect(await probe.epoch(sourceId)).toBe(pendingEpoch);
            expect(await probe.epoch("dashboard.worker.stdout")).toBe(retainedEpoch);
            const recoveredEmptySnapshot = await reader.tail({ limit: 10, sourceId });
            expect(recoveredEmptySnapshot.lines).toEqual([]);
            if (regrowth !== "") {
                const archiveNames = await readdir(base.logDirectory);
                const archivedContents = await Promise.all(
                    archiveNames
                        .filter((name) => name.endsWith(".gz"))
                        .map(async (name) =>
                            new TextDecoder().decode(
                                Bun.gunzipSync(
                                    await readFile(path.join(base.logDirectory, name))
                                )
                            )
                        )
                );
                expect(archivedContents).toContain(regrowth);
            }
            await writeFile(source, "same line\n");
            const replacement = await reader.tail({ limit: 10, sourceId });
            expect(replacement.lines[0]?.line).toBe("same line");
            expect(replacement.lines[0]?.id).not.toBe(beforeId);
            expect(await pathExists(manifest.lockPath)).toBe(false);
        }
    );

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

    test("fails closed and releases the lock for a corrupt or non-allowlisted epoch projection", async () => {
        const base = await fixture();
        const source = path.join(base.logDirectory, "application.log");
        await writeFile(source, "oversize\n", { mode: 0o600 });
        const manifest = { ...base.manifest, fileTargets: [fileTarget(source)] };
        const epochPath = path.join(
            base.stateDirectory,
            logRotationEpochProjectionFileName
        );
        await writeFile(epochPath, "not-json\n", { mode: 0o600 });

        await expectRejection(
            createManagedLogRotationEngine({ manifest }).run(),
            "Managed log maintenance failed"
        );
        expect(await readFile(source, "utf8")).toBe("oversize\n");
        expect(await pathExists(manifest.lockPath)).toBe(false);

        await writeFile(
            epochPath,
            `${JSON.stringify({
                entries: [
                    {
                        epoch: "019feb02-8b7d-7062-94c6-2708cc994799",
                        sourceId: "dashboard.not-allowlisted",
                        state: "committed",
                    },
                ],
                version: 1,
            })}\n`,
            { mode: 0o600 }
        );
        await expectRejection(
            createManagedLogRotationEngine({ manifest }).run(),
            "Managed log maintenance failed"
        );
        expect(await readFile(source, "utf8")).toBe("oversize\n");
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
        expect(() =>
            validateManagedLogManifest({
                archiveTargets: [],
                fileTargets: Array.from({ length: 65 }, (_, index) =>
                    fileTarget(`/tmp/log-${index}.log`, {
                        id: `dashboard.test-${index}`,
                    })
                ),
                lockPath: "/tmp/state/lock",
                statePath: "/tmp/state/status",
            })
        ).toThrow("Managed log manifest is invalid");
        expect(() =>
            validateManagedLogManifest({
                archiveTargets: [],
                fileTargets: [],
                lockPath: "/tmp/state/lock",
                statePath: `/tmp/state/${logRotationEpochProjectionFileName}`,
            })
        ).toThrow("Managed log manifest is invalid");
    });
});
