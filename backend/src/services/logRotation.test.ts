import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { db } from "../db.js";
import { __testing, runLogRotationService } from "./logRotation.js";

async function writeConfig(root: string, config: unknown) {
    const configPath = path.join(root, `log-rotation-${Math.random()}.json`);
    await writeFile(configPath, JSON.stringify(config), "utf8");
    return configPath;
}

function seedState(data: unknown) {
    const timestamp = new Date().toISOString();
    db.prepare(
        `INSERT OR REPLACE INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
        ) VALUES ('log_rotation.state', ?, 'test', ?, ?, ?, 'fresh', NULL, NULL, 0, '{}')`
    ).run(
        typeof data === "string" ? data : JSON.stringify(data),
        timestamp,
        timestamp,
        timestamp
    );
}

describe("log rotation service", { concurrency: false }, () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-log-rotation-"));
        db.exec("DELETE FROM cache_entries;");
    });

    afterEach(async () => {
        mock.restoreAll();
        db.exec("DELETE FROM cache_entries;");
        await rm(tempDir, { recursive: true, force: true });
    });

    it("validates config shape and policy helpers", async () => {
        assert.equal(__testing.byteLimitFromMb("2"), 2 * 1024 * 1024);
        assert.equal(__testing.byteLimitFromMb(0), null);
        assert.ok(
            __testing
                .globToRegex(path.join(tempDir, "*.log"))
                .test(path.join(tempDir, "a.log"))
        );
        assert.equal(
            __testing.mergePolicy({ keep: 1 }, { name: "g", paths: ["x"], keep: 2 }).keep,
            2
        );
        assert.equal(
            __testing.archiveRetentionKey(
                path.join(tempDir, "parent", "child", "a.log"),
                { archiveRetentionScope: "parent" }
            ),
            path.join(tempDir, "parent")
        );
        assert.equal(
            __testing.archiveRetentionKey(path.join(tempDir, ".hidden"), {
                archiveRetentionScope: "basename",
            }),
            path.join(tempDir, ".hidden")
        );
        assert.equal(__testing.caughtMessage("plain failure"), "plain failure");
        assert.equal(
            __testing.caughtMessage(new Error("typed failure")),
            "typed failure"
        );
        assert.equal(
            __testing.hasRotatedInCadence({ lastRotatedAt: "not-a-date" }, "daily"),
            false
        );
        assert.equal(
            __testing.hasRotatedInCadence(
                { lastRotatedAt: new Date().toISOString() },
                "weekly"
            ),
            true
        );
        assert.equal(__testing.hasRotatedInCadence(undefined, null), false);
        assert.deepEqual(
            await __testing.resolveGlob(path.join(tempDir, "missing", "*.log")),
            []
        );
        assert.deepEqual(
            await __testing.resolveGlob(path.join(tempDir, "missing.log")),
            []
        );
        assert.equal(
            await __testing.assertSafePath(path.join(tempDir, "missing.log"), [tempDir]),
            false
        );
        const safeFile = path.join(tempDir, "safe.log");
        await writeFile(safeFile, "safe", "utf8");
        assert.equal(
            await __testing.assertSafePath(safeFile, [
                path.join(tempDir, "missing-root"),
                tempDir,
            ]),
            true
        );
        await assert.rejects(
            () =>
                __testing.assertSafePath(safeFile, [path.join(tempDir, "missing-root")]),
            /No approved roots exist/u
        );
        await assert.rejects(
            () => __testing.assertSafePath(tempDir, [tempDir]),
            /Refusing non-file path/u
        );
        const globRoot = path.join(tempDir, "glob");
        const globChild = path.join(globRoot, "child");
        const globFile = path.join(globRoot, "file.txt");
        await mkdir(globChild, { recursive: true });
        await writeFile(globFile, "file", "utf8");
        await symlink(globChild, path.join(globRoot, "link"));
        await writeFile(path.join(globChild, "app.log"), "log", "utf8");
        assert.deepEqual(await __testing.resolveGlob(path.join(globRoot, "*", "*.log")), [
            path.join(globChild, "app.log"),
        ]);
        mock.method(fsPromises, "readdir", async () => {
            throw new Error("readdir crashed");
        });
        await assert.rejects(
            () => __testing.resolveGlob(path.join(tempDir, "*.log")),
            /readdir crashed/u
        );
        mock.restoreAll();
        mock.method(fsPromises, "lstat", async () => {
            throw new Error("lstat crashed");
        });
        await assert.rejects(
            () => __testing.resolveGlob(path.join(tempDir, "file.log")),
            /lstat crashed/u
        );
        mock.restoreAll();
        mock.method(fsPromises, "realpath", async () => {
            throw new Error("realpath crashed");
        });
        await assert.rejects(
            () => __testing.assertSafePath(path.join(tempDir, "file.log"), [tempDir]),
            /realpath crashed/u
        );
        mock.restoreAll();
        assert.deepEqual(
            __testing.shouldRotate({
                stat: { size: 10 },
                policy: { maxSizeMb: 1, daily: false, weekly: false },
                stateEntry: undefined,
            }),
            { rotate: false, reason: "notDue" }
        );
        assert.deepEqual(
            __testing.shouldRotate({
                stat: { size: 10 },
                policy: { weekly: true },
                stateEntry: undefined,
            }),
            { rotate: true, reason: "weekly" }
        );
        assert.deepEqual(
            __testing.shouldRotate({
                stat: { size: 10 },
                policy: { daily: true },
                stateEntry: { lastRotatedAt: "2020-01-01T00:00:00.000Z" },
            }),
            { rotate: true, reason: "daily" }
        );

        const invalidCases: Array<[unknown, RegExp]> = [
            [null, /Config must be an object/u],
            [{ version: 2, groups: [] }, /version must be 1/u],
            [{ version: 1, groups: "bad" }, /groups must be an array/u],
            [{ version: 1, groups: [{ paths: ["x"] }] }, /string name/u],
            [{ version: 1, groups: [{ name: "empty" }] }, /needs at least/u],
            [
                { version: 1, groups: [{ name: "bad", paths: ["x"], strategy: "move" }] },
                /unsupported strategy/u,
            ],
        ];
        for (const [config, message] of invalidCases) {
            const configPath = await writeConfig(tempDir, config);
            await assert.rejects(
                () => runLogRotationService({ dryRun: true, config: configPath }),
                message
            );
        }
    });

    it("rotates files, skips excluded entries, and persists SQLite state", async () => {
        const root = path.join(tempDir, "logs");
        await mkdir(root);
        const rotate = path.join(root, "app.log");
        const duplicate = path.join(root, "duplicate.log");
        const compressed = path.join(root, "compressed.log");
        const excluded = path.join(root, "excluded.log");
        const alreadyRotated = path.join(root, "old.log.2026-06-06T00-00-00Z");
        await writeFile(rotate, "needs rotation", "utf8");
        await writeFile(duplicate, "dup", "utf8");
        await writeFile(compressed, "gzip me", "utf8");
        await writeFile(excluded, "excluded", "utf8");
        await writeFile(alreadyRotated, "archive", "utf8");

        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            defaults: { compress: false, maxSizeMb: 0.000001, keep: 10 },
            groups: [
                {
                    name: "main",
                    paths: [path.join(root, "*.log"), duplicate, alreadyRotated],
                    excludePaths: [excluded, compressed],
                    strategy: "rename",
                },
                {
                    name: "compressed",
                    paths: [compressed],
                    strategy: "rename",
                    compress: true,
                },
                {
                    name: "disabled",
                    enabled: false,
                    paths: [path.join(root, "nope.log")],
                },
            ],
        });

        const summary = await runLogRotationService({
            dryRun: false,
            config,
            verbose: true,
        });

        assert.equal(summary.ok, true);
        assert.equal(summary.checkedGroups, 2);
        assert.equal(summary.rotatedFiles, 3);
        assert.equal(summary.compressedFiles, 1);
        assert.equal(summary.skippedFiles, 0);
        assert.equal(await readFile(rotate, "utf8"), "");
        assert.equal(await readFile(duplicate, "utf8"), "");
        const state = JSON.parse(
            (
                db
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
                    )
                    .get() as { data_json: string }
            ).data_json
        ) as { files: Record<string, { lastArchive: string }> };
        assert.match(state.files[rotate]?.lastArchive ?? "", /app\.log\./u);
    });

    it("handles dry-run, empty files, not-due cadence, retention compression, and invalid state", async () => {
        const root = path.join(tempDir, "logs");
        await mkdir(root);
        const empty = path.join(root, "empty.log");
        const daily = path.join(root, "daily.log");
        const archive = path.join(root, "daily.log.2020-01-01T00-00-00Z");
        await writeFile(empty, "", "utf8");
        await writeFile(daily, "small", "utf8");
        await writeFile(archive, "old archive", "utf8");
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await utimes(archive, oldTime, oldTime);
        seedState("not-json");

        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "empty",
                    paths: [empty],
                    skipEmpty: true,
                    archivePaths: [path.join(root, "daily.log.*")],
                    compress: true,
                    keep: 0,
                },
                {
                    name: "daily",
                    paths: [daily],
                    daily: true,
                    maxSizeMb: 100,
                    keepDays: 0,
                    compress: false,
                },
            ],
        });

        const dryRun = await runLogRotationService({ dryRun: true, config });
        assert.equal(dryRun.skippedFiles, 1);
        assert.equal(dryRun.rotatedFiles, 1);
        assert.equal(dryRun.compressedFiles, 1);
        assert.equal(dryRun.deletedArchives, 2);
        assert.equal(await readFile(daily, "utf8"), "small");

        seedState({
            version: 1,
            files: { [daily]: { lastRotatedAt: new Date().toISOString() } },
            lastRun: { ok: true },
        });
        const notDue = await runLogRotationService({ dryRun: false, config });
        assert.equal(notDue.skippedFiles, 2);
        assert.equal(notDue.rotatedFiles, 0);
    });

    it("skips archive paths that fail approved-root validation during retention", async () => {
        const root = path.join(tempDir, "logs");
        await mkdir(root);
        const file = path.join(root, "app.log");
        const archive = path.join(root, "other.log.2020-01-01T00-00-00Z");
        await writeFile(file, "log", "utf8");
        await writeFile(archive, "archive", "utf8");
        const realpathMock = mock.method(
            fsPromises,
            "realpath",
            async (target: unknown) => {
                if (target === archive) {
                    throw Object.assign(new Error("vanished"), { code: "ENOENT" });
                }
                return target as string;
            }
        );
        try {
            assert.deepEqual(
                await __testing.listArchives(file, { archivePaths: [archive] }, [root]),
                []
            );
        } finally {
            realpathMock.mock.restore();
        }
    });

    it("applies archive-only retention scopes and records group/file errors", async () => {
        const root = path.join(tempDir, "logs");
        const outside = path.join(tempDir, "outside");
        await mkdir(root);
        await mkdir(outside);
        const recent = path.join(root, "a.log.2026-06-06T00-00-00Z");
        const oldA = path.join(root, "a.log.2020-01-01T00-00-00Z");
        const oldB = path.join(root, "nested.log.2020-01-01T00-00-00Z");
        const unsafe = path.join(outside, "unsafe.log.2020-01-01T00-00-00Z");
        const unsafePlain = path.join(outside, "plain.log");
        const target = path.join(root, "target.log");
        const link = path.join(root, "link.log");
        await writeFile(recent, "recent", "utf8");
        await writeFile(oldA, "old a", "utf8");
        await writeFile(oldB, "old b", "utf8");
        await writeFile(unsafe, "unsafe", "utf8");
        await writeFile(unsafePlain, "unsafe", "utf8");
        await writeFile(target, "target", "utf8");
        await symlink(target, link);
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await Promise.all(
            [oldA, oldB, unsafe].map((file) => utimes(file, oldTime, oldTime))
        );

        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "archive-only",
                    archiveOnly: true,
                    archivePaths: [path.join(root, "*.log.*")],
                    archiveRetentionScope: "basename",
                    archiveMinAgeMinutes: 1,
                    compress: true,
                    keep: 1,
                    keepDays: 0,
                },
                {
                    name: "unsafe-archive",
                    archiveOnly: true,
                    archivePaths: [path.join(outside, "*.log.*")],
                    archiveRetentionScope: "parent",
                    keep: 0,
                },
                {
                    name: "file-errors",
                    paths: [link, unsafePlain, path.join(root, "missing.log")],
                    missingOk: true,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });
        await assert.rejects(
            () => __testing.assertSafePath(link, [root]),
            /Refusing symlink path/u
        );

        assert.equal(summary.ok, false);
        assert.equal(summary.groups[0]?.compressedFiles, 2);
        assert.ok(summary.groups[0]?.deletedArchives);
        assert.ok(
            summary.errors.some((error) => JSON.stringify(error).includes("Unsafe path"))
        );
    });

    it("reads malformed log rotation state with safe defaults", () => {
        seedState({ version: 2, files: [], lastRun: "bad" });
        assert.deepEqual(__testing.readLogRotationState(), { version: 1, files: {} });
    });

    it("uses default roots and group filters when requested", async () => {
        const root = path.join(tempDir, "logs");
        await mkdir(root);
        const file = path.join(root, "app.log");
        await writeFile(file, "small", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            groups: [
                { name: "target", paths: [file], daily: true },
                { name: "skip", paths: [path.join(root, "skip.log")], daily: true },
            ],
        });

        const summary = await runLogRotationService({
            dryRun: true,
            config,
            group: "target",
        });

        assert.equal(summary.checkedGroups, 1);
        assert.equal(summary.groups[0]?.name, "target");
        assert.equal(summary.ok, false);
        assert.match(
            (summary.errors[0] as { message?: string } | undefined)?.message ?? "",
            /No approved roots exist|Unsafe path/u
        );
    });

    it("covers copytruncate compression and disappearing safe-path races", async () => {
        const root = path.join(tempDir, "race-logs");
        const archiveRoot = path.join(tempDir, "race-archives");
        await mkdir(root);
        await mkdir(archiveRoot);
        const copyPlain = path.join(root, "copy-plain.log");
        const copyGzip = path.join(root, "copy-gzip.log");
        const vanish = path.join(root, "vanish.log");
        const archiveVanish = path.join(archiveRoot, "archive.log.2020-01-01T00-00-00Z");
        const otherDirArchive = path.join(
            archiveRoot,
            "copy-plain.log.2020-01-01T00-00-00Z"
        );
        await writeFile(copyPlain, "plain", "utf8");
        await writeFile(copyGzip, "gzip", "utf8");
        await writeFile(vanish, "vanish", "utf8");
        await writeFile(archiveVanish, "archive vanish", "utf8");
        await writeFile(otherDirArchive, "other dir", "utf8");

        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root, archiveRoot],
            groups: [
                {
                    name: "copy-plain",
                    paths: [copyPlain],
                    archivePaths: [otherDirArchive],
                    strategy: "copytruncate",
                    compress: false,
                    maxSizeMb: 0.000001,
                },
                {
                    name: "copy-gzip",
                    paths: [copyGzip],
                    strategy: "copytruncate",
                    compress: true,
                    maxSizeMb: 0.000001,
                },
                {
                    name: "path-race",
                    paths: [vanish],
                    daily: true,
                },
                {
                    name: "archive-race",
                    archiveOnly: true,
                    archivePaths: [archiveVanish],
                    keep: 0,
                },
                {
                    name: "archive-pattern-only",
                    archivePaths: [path.join(archiveRoot, "none.*")],
                },
            ],
        });
        const realpath = fsPromises.realpath.bind(fsPromises);
        mock.method(fsPromises, "realpath", async (filePath: string | Buffer | URL) => {
            const asString = String(filePath);
            if (asString === vanish || asString === archiveVanish) {
                const error = Object.assign(new Error("vanished"), { code: "ENOENT" });
                throw error;
            }
            return realpath(filePath);
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(await readFile(copyPlain, "utf8"), "");
        assert.equal(await readFile(copyGzip, "utf8"), "");
        assert.equal(summary.rotatedFiles, 2);
        assert.equal(summary.compressedFiles, 1);
    });

    it("verifies opened log file identity before rotation", async () => {
        const root = path.join(tempDir, "verified-logs");
        const outside = path.join(tempDir, "verified-outside");
        await mkdir(root);
        await mkdir(outside);
        const file = path.join(root, "app.log");
        const outsideFile = path.join(outside, "app.log");
        await writeFile(file, "log", "utf8");
        await writeFile(outsideFile, "log", "utf8");

        const verified = await __testing.openVerifiedLogFile(file, [root]);
        assert.ok(verified);
        await verified.handle.close();

        await assert.rejects(
            () => __testing.openVerifiedLogFile(root, [root]),
            /EISDIR|Refusing non-file path/u
        );
        const realOpen = fsPromises.open.bind(fsPromises);
        const fakeHandle = {
            close: async () => {},
            stat: async () => ({ isFile: () => false }),
        };
        mock.method(fsPromises, "open", async () => fakeHandle);
        await assert.rejects(
            () => __testing.openVerifiedLogFile(file, [root]),
            /Refusing non-file path/u
        );
        (fsPromises.open as unknown as { mock: { restore(): void } }).mock.restore();
        assert.equal(await realOpen(file).then((handle) => handle.close()), undefined);
        await assert.rejects(
            () =>
                __testing.openVerifiedLogFile(file, [path.join(tempDir, "missing-root")]),
            /No approved roots exist/u
        );
        await assert.rejects(
            () => __testing.openVerifiedLogFile(outsideFile, [root]),
            /Unsafe path outside approved roots/u
        );

        const realStat = fsPromises.stat.bind(fsPromises);
        mock.method(fsPromises, "stat", async (filePath: string | Buffer | URL) => {
            const stat = await realStat(filePath);
            if (String(filePath) === file) {
                return { ...stat, ino: stat.ino + 1 };
            }
            return stat;
        });
        await assert.rejects(
            () => __testing.openVerifiedLogFile(file, [root]),
            /Unsafe path changed before rotation/u
        );
    });
});
