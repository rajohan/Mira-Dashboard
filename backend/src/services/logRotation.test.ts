import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, type PathLike } from "node:fs";
import fsPromises from "node:fs/promises";
import {
    link,
    mkdir,
    mkdtemp,
    open,
    readFile,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { withEnv } from "../testUtils/env.js";

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(new URL("logRotation.ts", import.meta.url));
const suiteDbDir = await mkdtemp(path.join(os.tmpdir(), "mira-log-rotation-db-"));
const suiteDbPath = path.join(suiteDbDir, "log-rotation.sqlite");
const { db } = await withEnv(
    { MIRA_DASHBOARD_DB_PATH: suiteDbPath },
    () => import("../db.js")
);
const { __testing, runElevatedLogRotationService, runLogRotationService } = await withEnv(
    { MIRA_DASHBOARD_DB_PATH: suiteDbPath },
    () => import("./logRotation.js")
);

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

function testLockPath(tempDir: string) {
    return path.join(tempDir, "data", "log-rotation.lock");
}

after(async () => {
    db.close();
    await rm(suiteDbDir, { recursive: true, force: true });
});

describe("log rotation service", { concurrency: false }, () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-log-rotation-"));
        __testing.setLogRotationLockFileForTests(
            path.join(tempDir, "data", "log-rotation.lock")
        );
        db.exec("DELETE FROM cache_entries;");
    });

    afterEach(async () => {
        mock.restoreAll();
        __testing.resetLogRotationLockFileForTests();
        db.exec("DELETE FROM cache_entries;");
        await rm(tempDir, { recursive: true, force: true });
    });

    it("validates config shape and policy helpers", async () => {
        assert.equal(
            __testing.defaultConfigPath,
            path.resolve("config/log-rotation.json")
        );
        const originalConfig = process.env.MIRA_LOG_ROTATION_CONFIG;
        const runtimeConfig = path.join(tempDir, "runtime-log-rotation.json");
        try {
            process.env.MIRA_LOG_ROTATION_CONFIG = runtimeConfig;
            assert.equal(__testing.defaultConfigPath, runtimeConfig);
        } finally {
            if (originalConfig === undefined) {
                delete process.env.MIRA_LOG_ROTATION_CONFIG;
            } else {
                process.env.MIRA_LOG_ROTATION_CONFIG = originalConfig;
            }
        }
        assert.equal(__testing.byteLimitFromMb("2"), 2 * 1024 * 1024);
        assert.equal(__testing.byteLimitFromMb(0), null);
        assert.ok(
            __testing
                .globToRegex(path.join(tempDir, "*.log"))
                .test(path.join(tempDir, "a.log"))
        );
        assert.equal(
            __testing
                .globToRegex(path.join(tempDir, "*.log"))
                .test(path.join(tempDir, "nested", "a.log")),
            false
        );
        assert.ok(
            __testing
                .globToRegex(path.join(tempDir, "*.log.[0-9]*"))
                .test(path.join(tempDir, "a.log.12.gz"))
        );
        assert.equal(
            __testing
                .globToRegex(path.join(tempDir, "*.log.[0-9]*"))
                .test(path.join(tempDir, "a.log.[0-9]2.gz")),
            false
        );
        const numericArchiveDir = path.join(tempDir, "numeric-archives");
        await mkdir(numericArchiveDir, { recursive: true });
        await writeFile(path.join(numericArchiveDir, "app.log.1"), "rotated", "utf8");
        await writeFile(path.join(numericArchiveDir, "app.log.[0-9]"), "literal", "utf8");
        assert.deepEqual(
            await __testing.resolveGlob(path.join(numericArchiveDir, "*.log.[0-9]*")),
            [path.join(numericArchiveDir, "app.log.1")]
        );
        const config = JSON.parse(
            await readFile(__testing.defaultConfigPath, "utf8")
        ) as {
            groups: Array<{ name?: string; paths?: string[] }>;
        };
        const dockerFileLogs = config.groups.find(
            (group) => group.name === "docker-file-logs"
        );
        assert.ok(dockerFileLogs?.paths);
        const rootLevelPatterns = dockerFileLogs.paths.filter((pattern) =>
            pattern.startsWith("/opt/docker/data/*/")
        );
        const appRoot = "/opt/docker/data/app";
        const matches = (filePath: string) =>
            rootLevelPatterns.some((pattern) =>
                __testing.globToRegex(pattern).test(filePath)
            );
        assert.equal(matches(path.join(appRoot, "catalog.json")), false);
        assert.equal(matches(path.join(appRoot, "app.log.json")), true);
        assert.equal(matches(path.join(appRoot, "app-log.txt")), true);
        assert.equal(matches(path.join(appRoot, "app_log.txt")), true);
        assert.equal(matches(path.join(appRoot, "logfile.json")), true);
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
        assert.equal(
            __testing.archiveRetentionKey(path.join(tempDir, "app.log.1.gz"), {
                archiveRetentionScope: "basename",
            }),
            path.join(tempDir, "app.log")
        );
        assert.equal(
            __testing.archiveRetentionKey(
                path.join(tempDir, "app.log.2026-06-09T01-02-03.004Z.gz"),
                { archiveRetentionScope: "basename" }
            ),
            path.join(tempDir, "app.log")
        );
        assert.equal(__testing.caughtMessage("plain failure"), "plain failure");
        assert.equal(
            __testing.caughtMessage(new Error("typed failure")),
            "typed failure"
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        approvedRoots: tempDir,
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /approvedRoots/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { approvedRoots: tempDir },
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /defaults\.approvedRoots/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        approvedRoots: [],
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /approvedRoots must include at least one entry/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { approvedRoots: [] },
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /defaults\.approvedRoots must include at least one entry/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: ["*.log"],
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /Config defaults must be an object/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: "not an object",
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /Config defaults must be an object/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [
                            {
                                name: "invalid",
                                approvedRoots: [],
                                paths: ["*.log"],
                            },
                        ],
                    }),
                }),
            /Group invalid approvedRoots must include at least one entry/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { excludePaths: "*.tmp" },
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /defaults\.excludePaths/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        excludePaths: "*.tmp",
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /excludePaths/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [{ name: "invalid", paths: ["*.log", 1] }],
                    }),
                }),
            /paths/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [
                            {
                                name: "invalid",
                                paths: ["*.log"],
                                excludePaths: "*.tmp",
                            },
                        ],
                    }),
                }),
            /Group invalid excludePaths/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [
                            {
                                name: "invalid",
                                paths: ["*.log"],
                                archiveRetentionScope: "global",
                            },
                        ],
                    }),
                }),
            /archiveRetentionScope/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { enabled: "false" },
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /defaults\.enabled must be a boolean/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [
                            {
                                name: "invalid",
                                paths: ["*.log"],
                                maxSizeMb: "1",
                            },
                        ],
                    }),
                }),
            /Group invalid\.maxSizeMb must be a non-negative number/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [
                            {
                                name: "negative",
                                paths: ["*.log"],
                                keepDays: -1,
                            },
                        ],
                    }),
                }),
            /Group negative\.keepDays must be a non-negative number/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [{ name: "fractional", paths: ["*.log"], keep: 1.5 }],
                    }),
                }),
            /Group fractional\.keep must be a positive integer/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        groups: [{ name: "zero", paths: ["*.log"], keep: 0 }],
                    }),
                }),
            /Group zero\.keep must be a positive integer/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { archiveOnly: true },
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /Archive-only group invalid/u
        );
        await runLogRotationService({
            dryRun: true,
            config: await writeConfig(tempDir, {
                version: 1,
                defaults: {
                    archiveOnly: true,
                    archivePaths: [path.join(tempDir, "*.log.1")],
                },
                groups: [{ name: "valid-default-archive-only", paths: ["*.log"] }],
            }),
        });
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: {
                            archiveOnly: true,
                            archivePaths: [path.join(tempDir, "*.log.1")],
                        },
                        groups: [
                            {
                                name: "invalid-default-archive-only-override",
                                archivePaths: [],
                                paths: ["*.log"],
                            },
                        ],
                    }),
                }),
            /Archive-only group invalid-default-archive-only-override/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { paths: ["*.log"] },
                        groups: [
                            {
                                name: "invalid-default-paths-override",
                                paths: [],
                            },
                        ],
                    }),
                }),
            /Group invalid-default-paths-override needs at least one path/u
        );
        await assert.rejects(
            async () =>
                runLogRotationService({
                    dryRun: true,
                    config: await writeConfig(tempDir, {
                        version: 1,
                        defaults: { strategy: "move" },
                        groups: [{ name: "invalid", paths: ["*.log"] }],
                    }),
                }),
            /defaults\.strategy/u
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
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        assert.equal(
            __testing.hasRotatedInCadence(
                { lastRotatedAt: yesterday.toISOString() },
                "daily"
            ),
            false
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
        const modeFile = path.join(tempDir, "mode.log");
        const modeHandle = await __testing.createNoFollowFile(modeFile, 0o666);
        await modeHandle.close();
        const modeFileStats = await fsPromises.stat(modeFile);
        assert.equal(modeFileStats.mode & 0o777, 0o666);
        const noOwnerFile = path.join(tempDir, "no-owner.log");
        const noOwnerHandle = await __testing.createNoFollowFile(noOwnerFile, 0o600);
        await noOwnerHandle.close();
        assert.equal(await readFile(noOwnerFile, "utf8"), "");
        const ownerFile = path.join(tempDir, "owner.log");
        const chownCalls: Array<{ uid: number; gid: number }> = [];
        const chmodCalls: number[] = [];
        const closeCalls: string[] = [];
        mock.method(fsPromises, "open", async () => ({
            chmod: async (mode: number) => {
                chmodCalls.push(mode);
            },
            chown: async (uid: number, gid: number) => {
                chownCalls.push({ uid, gid });
            },
            close: async () => {
                closeCalls.push(ownerFile);
            },
            stat: async () => ({ uid: 0, gid: 0 }),
        }));
        const ownerHandle = await __testing.createNoFollowFile(ownerFile, 0o600, {
            uid: 123,
            gid: 456,
        });
        await ownerHandle.close();
        assert.deepEqual(chmodCalls, [0o600]);
        assert.deepEqual(chownCalls, [{ uid: 123, gid: 456 }]);
        assert.deepEqual(closeCalls, [ownerFile]);
        mock.restoreAll();
        mock.method(fsPromises, "open", async () => ({
            chmod: async () => {},
            close: async () => {
                closeCalls.push("failed-owner");
            },
            stat: async () => {
                throw new Error("created stat failed");
            },
        }));
        await assert.rejects(
            () =>
                __testing.createNoFollowFile(
                    path.join(tempDir, "failed-owner.log"),
                    0o600,
                    { uid: 123, gid: 456 }
                ),
            /created stat failed/u
        );
        assert.deepEqual(closeCalls, [ownerFile, "failed-owner"]);
        mock.restoreAll();
        const cleanupFile = path.join(tempDir, "cleanup-close-fails.log");
        const unlinkCalls: string[] = [];
        mock.method(fsPromises, "open", async () => ({
            chmod: async () => {
                throw new Error("chmod denied");
            },
            close: async () => {
                closeCalls.push("close-failed");
                throw new Error("close denied");
            },
        }));
        mock.method(fsPromises, "unlink", async (filePath: PathLike) => {
            unlinkCalls.push(String(filePath));
        });
        await assert.rejects(
            () => __testing.createNoFollowFile(cleanupFile, 0o600),
            /chmod denied/u
        );
        assert.deepEqual(closeCalls, [ownerFile, "failed-owner", "close-failed"]);
        assert.deepEqual(unlinkCalls, [cleanupFile]);
        mock.restoreAll();
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
        const originalRealpath = fsPromises.realpath.bind(fsPromises);
        const realpathMock = mock.method(
            fsPromises,
            "realpath",
            (
                target: Parameters<typeof fsPromises.realpath>[0],
                options?: Parameters<typeof fsPromises.realpath>[1]
            ) => {
                if (String(target).endsWith("denied-root")) {
                    const error = new Error(
                        "approved root denied"
                    ) as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpath(target, options);
            }
        );
        try {
            await assert.rejects(
                () =>
                    __testing.assertSafePath(safeFile, [
                        path.join(tempDir, "denied-root"),
                    ]),
                /approved root denied/u
            );
        } finally {
            realpathMock.mock.restore();
        }
        await assert.rejects(
            () =>
                __testing.assertSafePath(safeFile, [path.join(tempDir, "missing-root")]),
            /No approved roots exist/u
        );
        await assert.rejects(
            () => __testing.assertSafePath(tempDir, [tempDir]),
            /Refusing non-file path/u
        );
        const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "mira-log-outside-"));
        const outsideFile = path.join(outsideRoot, "outside.log");
        await writeFile(outsideFile, "outside", "utf8");
        const outsideStat = await fsPromises.stat(outsideFile);
        await assert.rejects(
            () =>
                __testing.assertFileIdentity(
                    outsideFile,
                    { dev: outsideStat.dev, ino: outsideStat.ino },
                    [tempDir]
                ),
            /Unsafe path outside approved roots/u
        );
        await assert.rejects(
            () =>
                __testing.assertFileIdentity(
                    path.join(tempDir, "missing-before-mutation.log"),
                    { dev: 1, ino: 1 },
                    [tempDir]
                ),
            /Unsafe path outside approved roots/u
        );
        const linkedFile = path.join(tempDir, "linked.log");
        const linkedAlias = path.join(tempDir, "linked-alias.log");
        await writeFile(linkedFile, "linked", "utf8");
        await link(linkedFile, linkedAlias);
        await assert.rejects(
            () => __testing.openVerifiedLogFile(linkedFile, [tempDir]),
            /Refusing multi-linked file/u
        );
        const linkedStat = await fsPromises.stat(linkedFile);
        await assert.rejects(
            () =>
                __testing.assertFileIdentity(
                    linkedFile,
                    { dev: linkedStat.dev, ino: linkedStat.ino },
                    [tempDir]
                ),
            /Refusing multi-linked file/u
        );
        await rm(outsideRoot, { recursive: true, force: true });
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
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        });
        await assert.rejects(
            () => __testing.resolveGlob(path.join(tempDir, "*.log")),
            /permission denied/u
        );
        mock.restoreAll();
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
        const gzipSource = path.join(tempDir, "gzip-source.log");
        await writeFile(gzipSource, "source", "utf8");
        await writeFile(`${gzipSource}.gz`, "already exists", "utf8");
        await assert.rejects(
            () => __testing.gzipFile(gzipSource, [tempDir]),
            /EEXIST|file already exists/u
        );
        assert.equal(await readFile(`${gzipSource}.gz`, "utf8"), "already exists");
        await rm(`${gzipSource}.gz`, { force: true });
        const deleteSource = path.join(tempDir, "delete-source.log");
        await writeFile(deleteSource, "delete me", "utf8");
        const originalRename = fsPromises.rename;
        let sawTombstoneRename = false;
        const deleteRenameMock = mock.method(
            fsPromises,
            "rename",
            async (from: PathLike, to: PathLike) => {
                const fromPath = String(from);
                const toPath = String(to);
                if (fromPath === deleteSource && toPath.includes(".delete-")) {
                    sawTombstoneRename = true;
                    return originalRename(from, to);
                }
                if (sawTombstoneRename && fromPath.includes(".delete-")) {
                    return originalRename(from, to);
                }
                throw new Error("unexpected rename");
            }
        );
        const deleteUnlinkMock = mock.method(fsPromises, "unlink", async () => {
            throw new Error("delete failed");
        });
        try {
            await assert.rejects(
                () => __testing.unlinkVerified(deleteSource, [tempDir]),
                /delete failed/u
            );
            assert.equal(await readFile(deleteSource, "utf8"), "delete me");
            assert.equal(sawTombstoneRename, true);
        } finally {
            deleteRenameMock.mock.restore();
            deleteUnlinkMock.mock.restore();
        }
        const outsideGzipTarget = path.join(os.tmpdir(), `mira-gzip-${Date.now()}`);
        await symlink(outsideGzipTarget, `${gzipSource}.gz`);
        await assert.rejects(
            () => __testing.gzipFile(gzipSource, [tempDir]),
            /EEXIST|file already exists/u
        );
        await __testing.assertSafeNewFileParent(`${gzipSource}.gz`, [tempDir]);
        await assert.rejects(
            () =>
                __testing.assertSafeNewFileParent(`${gzipSource}.gz`, [
                    path.join(tempDir, "missing-root"),
                ]),
            /No approved roots exist/u
        );
        const outsideSafeRoot = await mkdtemp(path.join(os.tmpdir(), "mira-gzip-root-"));
        try {
            await assert.rejects(
                () =>
                    __testing.assertSafeNewFileParent(`${gzipSource}.gz`, [
                        outsideSafeRoot,
                    ]),
                /Unsafe path outside approved roots/u
            );
        } finally {
            await rm(outsideSafeRoot, { recursive: true, force: true });
        }
        await rm(`${gzipSource}.gz`, { force: true });
        __testing.setGzipPipelineForTests(async () => {
            throw new Error("gzip pipeline failed");
        });
        try {
            await assert.rejects(
                () => __testing.gzipFile(gzipSource, [tempDir]),
                /gzip pipeline failed/u
            );
            await assert.rejects(() => fsPromises.access(`${gzipSource}.gz`));
        } finally {
            __testing.resetGzipPipeline();
        }
        const gzipDeniedRoot = path.join(tempDir, "gzip-denied");
        await mkdir(gzipDeniedRoot);
        const gzipDeniedSource = path.join(gzipDeniedRoot, "source.log");
        await writeFile(gzipDeniedSource, "source", "utf8");
        const originalOpen = fsPromises.open.bind(fsPromises);
        const openMock = mock.method(
            fsPromises,
            "open",
            (
                target: Parameters<typeof fsPromises.open>[0],
                flags?: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                if (String(target) === `${gzipDeniedSource}.gz`) {
                    throw Object.assign(new Error("permission denied"), {
                        code: "EACCES",
                    });
                }
                return originalOpen(target, flags, mode);
            }
        );
        try {
            await assert.rejects(
                () => __testing.gzipFile(gzipDeniedSource, [tempDir]),
                /EACCES|permission denied/u
            );
            await assert.rejects(() => fsPromises.access(`${gzipDeniedSource}.gz`));
        } finally {
            openMock.mock.restore();
        }
        const gzipCloseFailureSource = path.join(tempDir, "gzip-close-source.log");
        await writeFile(gzipCloseFailureSource, "close failure", "utf8");
        const originalCloseFailureOpen = fsPromises.open.bind(fsPromises);
        let threwSourceClose = false;
        let gzipCloseFailureSourceOpenCount = 0;
        const closeFailureOpenMock = mock.method(
            fsPromises,
            "open",
            async (
                target: Parameters<typeof fsPromises.open>[0],
                flags?: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                const handle = await originalCloseFailureOpen(target, flags, mode);
                if (String(target) === gzipCloseFailureSource) {
                    gzipCloseFailureSourceOpenCount += 1;
                }
                if (
                    String(target) === gzipCloseFailureSource &&
                    gzipCloseFailureSourceOpenCount === 1
                ) {
                    const originalClose = handle.close.bind(handle);
                    handle.close = (async () => {
                        await originalClose();
                        if (!threwSourceClose) {
                            threwSourceClose = true;
                            throw new Error("source close failed");
                        }
                    }) as typeof handle.close;
                }
                return handle;
            }
        );
        try {
            await assert.rejects(
                () => __testing.gzipFile(gzipCloseFailureSource, [tempDir]),
                /source close failed/u
            );
            await assert.rejects(() => fsPromises.access(gzipCloseFailureSource));
            const gzipCloseFailureArchive = await readFile(
                `${gzipCloseFailureSource}.gz`
            );
            assert.equal(gzipCloseFailureArchive.byteLength > 0, true);
        } finally {
            closeFailureOpenMock.mock.restore();
            await rm(`${gzipCloseFailureSource}.gz`, { force: true });
        }
        try {
            const unlinkMock = mock.method(fsPromises, "unlink", async () => {
                throw new Error("unlink crashed");
            });
            try {
                await assert.rejects(
                    () => __testing.gzipFile(gzipDeniedSource, [tempDir]),
                    /unlink crashed/u
                );
            } finally {
                unlinkMock.mock.restore();
            }
        } finally {
            await rm(`${gzipDeniedSource}.gz`, { force: true });
        }
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
                stateEntry: { lastRotatedAt: yesterday.toISOString() },
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
                { version: 1, groups: [{ name: "archive-only", archiveOnly: true }] },
                /needs at least one archivePaths/u,
            ],
            [
                {
                    version: 1,
                    groups: [{ name: "archive-paths-only", archivePaths: ["x"] }],
                },
                /needs at least one path pattern/u,
            ],
            [
                { version: 1, groups: [{ name: "bad", paths: ["x"], strategy: "move" }] },
                /unsupported strategy/u,
            ],
            [
                {
                    version: 1,
                    groups: [
                        { name: "cadence", paths: ["x"], daily: true, weekly: true },
                    ],
                },
                /cannot set both daily and weekly rotation/u,
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

    it("runs elevated log rotation through the CLI wrapper", async () => {
        const commands: Array<{
            args: readonly string[];
            env: NodeJS.ProcessEnv;
            file: string;
        }> = [];
        __testing.setElevatedLogRotationExecFileRunner(
            async (
                file: string,
                args: readonly string[] | undefined,
                options: {
                    encoding?: BufferEncoding;
                    env: NodeJS.ProcessEnv;
                    maxBuffer: number;
                    timeout?: number;
                }
            ) => {
                commands.push({ args: args ?? [], env: options.env, file });
                assert.equal(options.encoding, "utf8");
                assert.equal(options.maxBuffer, 16 * 1024 * 1024);
                assert.equal(options.timeout, 5 * 60_000);
                return {
                    stderr: "helper warning",
                    stdout: JSON.stringify({ ok: true }),
                };
            }
        );
        try {
            assert.deepEqual(await runElevatedLogRotationService({ dryRun: false }), {
                result: { ok: true },
                stderr: "helper warning",
            });
            const dryRunConfig = await writeConfig(tempDir, {
                version: 1,
                approvedRoots: [tempDir],
                groups: [],
            });
            await withEnv({ MIRA_LOG_ROTATION_CONFIG: dryRunConfig }, async () => {
                const dryRun = await runElevatedLogRotationService({ dryRun: true });
                assert.equal(dryRun.stderr, "helper warning");
                assert.equal(dryRun.result.ok, true);
            });
            assert.equal(commands.length, 2);
            assert.equal(commands[1]?.args.includes("--dry-run"), true);
            __testing.setElevatedLogRotationExecFileRunner(async () => ({
                stderr: "helper warning",
                stdout: "not json",
            }));
            const malformed = await runElevatedLogRotationService({ dryRun: false });
            assert.equal(malformed.result.ok, false);
            assert.equal(
                malformed.result.error,
                "Failed to parse elevated log rotation JSON"
            );
            assert.match(String(malformed.result.parseError), /not json/u);
            assert.equal(malformed.result.stdout, "not json");
            assert.match(
                malformed.stderr,
                /helper warning\nFailed to parse elevated log rotation JSON: /u
            );
            assert.match(malformed.stderr, /stdout: not json/u);
            __testing.setElevatedLogRotationExecFileRunner(async () => ({
                stderr: "helper warning",
                stdout: "",
            }));
            const emptyOutput = await runElevatedLogRotationService({
                dryRun: false,
            });
            assert.deepEqual(emptyOutput.result, {
                ok: false,
                error: "Elevated log rotation returned empty JSON output",
            });
            assert.equal(
                emptyOutput.stderr,
                "helper warning\nElevated log rotation returned empty JSON output"
            );
            __testing.setElevatedLogRotationExecFileRunner(async () => ({
                stderr: "",
                stdout: "",
            }));
            const emptyOutputWithoutStderr = await runElevatedLogRotationService({
                dryRun: false,
            });
            assert.deepEqual(emptyOutputWithoutStderr.result, {
                ok: false,
                error: "Elevated log rotation returned empty JSON output",
            });
            assert.equal(
                emptyOutputWithoutStderr.stderr,
                "Elevated log rotation returned empty JSON output"
            );
            __testing.setElevatedLogRotationExecFileRunner(async () => ({
                stderr: "",
                stdout: "still not json",
            }));
            const malformedWithoutStderr = await runElevatedLogRotationService({
                dryRun: false,
            });
            assert.equal(malformedWithoutStderr.result.ok, false);
            assert.equal(
                malformedWithoutStderr.result.error,
                "Failed to parse elevated log rotation JSON"
            );
            assert.match(
                String(malformedWithoutStderr.result.parseError),
                /still not json/u
            );
            assert.equal(malformedWithoutStderr.result.stdout, "still not json");
            assert.match(
                malformedWithoutStderr.stderr,
                /^Failed to parse elevated log rotation JSON: /u
            );
            assert.match(malformedWithoutStderr.stderr, /stdout: still not json/u);
            __testing.setElevatedLogRotationExecFileRunner(async () => {
                throw Object.assign(new Error("sudo failed"), {
                    stderr: "helper warning",
                    stdout: JSON.stringify({ ok: false, error: "child failed" }),
                });
            });
            assert.deepEqual(await runElevatedLogRotationService({ dryRun: false }), {
                result: { ok: false, error: "child failed" },
                stderr: "helper warning",
            });
            __testing.setElevatedLogRotationExecFileRunner(async () => {
                throw Object.assign(new Error("sudo failed"), {
                    stderr: "helper warning",
                    stdout: "not json",
                });
            });
            const rejectedMalformed = await runElevatedLogRotationService({
                dryRun: false,
            });
            assert.deepEqual(rejectedMalformed.result, {
                ok: false,
                error: "sudo failed",
                stdout: "not json",
            });
            assert.equal(rejectedMalformed.stderr, "helper warning\nsudo failed");
            __testing.setElevatedLogRotationExecFileRunner(async () => {
                throw new Error("sudo missing");
            });
            assert.deepEqual(await runElevatedLogRotationService({ dryRun: false }), {
                result: { ok: false, error: "sudo missing", stdout: "" },
                stderr: "sudo missing",
            });
            assert.equal(commands[0]?.file, "sudo");
            assert.deepEqual(commands[0]?.args.slice(0, 3), [
                "-n",
                "-E",
                process.execPath,
            ]);
            assert.deepEqual(commands[0]?.args.slice(3, 5), ["--import", "tsx"]);
            const evalIndex = commands[0]?.args.indexOf("--eval") ?? -1;
            assert.equal(commands[0]?.args[evalIndex - 1], "--input-type=module");
            assert.equal(commands[0]?.args[evalIndex + 2], "--");
            assert.match(
                commands[0]?.args[evalIndex + 1] ?? "",
                /services\/logRotation\.ts/u
            );
            assert.equal(commands[0]?.args.includes("--dry-run"), false);
            assert.equal(commands[0]?.env.PATH, process.env.PATH);
            assert.equal(commands[0]?.env.MIRA_GITHUB_TOKEN, undefined);

            const builtArgs = __testing.buildElevatedLogRotationCliArgs(
                path.join(tempDir, "dist/services/logRotation.js")
            );
            const builtEvalIndex = builtArgs.indexOf("--eval");
            assert.equal(builtArgs.includes("tsx"), false);
            assert.equal(builtArgs[builtEvalIndex - 1], "--input-type=module");
            assert.match(builtArgs[builtEvalIndex + 1] ?? "", /logRotation\.js/u);
        } finally {
            __testing.resetElevatedLogRotationExecFileRunner();
        }
    });

    it("runs the log rotation CLI entrypoint", async () => {
        const logPath = path.join(tempDir, "cli.log");
        await writeFile(logPath, "", "utf8");
        const configPath = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [tempDir],
            groups: [
                {
                    name: "cli",
                    paths: [logPath],
                    policy: { maxBytes: 1024 },
                },
            ],
        });

        const { stdout } = await execFileAsync(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "--eval",
                `import { runLogRotationCli } from ${JSON.stringify(pathToFileURL(modulePath).href)}; await runLogRotationCli();`,
                "--",
                "--dry-run",
                "--json",
            ],
            {
                env: {
                    ...process.env,
                    MIRA_DASHBOARD_DB_PATH: suiteDbPath,
                    MIRA_LOG_ROTATION_CONFIG: configPath,
                    MIRA_SUITE_DB_PATH: suiteDbPath,
                },
            }
        );

        assert.match(stdout, /"dryRun":true/u);

        const originalArgv = process.argv;
        const originalConfig = process.env.MIRA_LOG_ROTATION_CONFIG;
        const originalExitCode = process.exitCode;
        const writeMock = mock.method(process.stdout, "write", () => true);
        try {
            process.env.MIRA_LOG_ROTATION_CONFIG = configPath;
            process.argv = [process.execPath, "log-rotation-test", "--dry-run", "--json"];
            process.exitCode = undefined;
            const { runLogRotationCli } = await import(
                `${pathToFileURL(modulePath).href}?cli=${Date.now()}`
            );
            assert.equal(writeMock.mock.callCount(), 0);
            await runLogRotationCli();
            assert.equal(writeMock.mock.callCount(), 1);
            assert.equal(process.exitCode, undefined);

            const unsafeConfigPath = await writeConfig(tempDir, {
                version: 1,
                groups: [{ name: "unsafe", paths: [logPath] }],
            });
            process.env.MIRA_LOG_ROTATION_CONFIG = unsafeConfigPath;
            process.exitCode = undefined;
            await runLogRotationCli();
            assert.equal(process.exitCode, 1);
        } finally {
            process.argv = originalArgv;
            process.exitCode = originalExitCode;
            if (originalConfig === undefined) {
                delete process.env.MIRA_LOG_ROTATION_CONFIG;
            } else {
                process.env.MIRA_LOG_ROTATION_CONFIG = originalConfig;
            }
            writeMock.mock.restore();
        }

        const badConfigPath = await writeConfig(tempDir, { groups: [] });
        await assert.rejects(
            () =>
                execFileAsync(
                    process.execPath,
                    [
                        "--import",
                        "tsx",
                        "--input-type=module",
                        "--eval",
                        `import { runLogRotationCli } from ${JSON.stringify(pathToFileURL(modulePath).href)}; await runLogRotationCli();`,
                    ],
                    {
                        env: {
                            ...process.env,
                            MIRA_DASHBOARD_DB_PATH: suiteDbPath,
                            MIRA_LOG_ROTATION_CONFIG: badConfigPath,
                            MIRA_SUITE_DB_PATH: suiteDbPath,
                        },
                    }
                ),
            /Command failed/u
        );
    });

    it("rotates files, skips excluded entries, and persists SQLite state", async () => {
        const root = path.join(tempDir, "logs");
        await mkdir(root);
        const rotate = path.join(root, "app.log");
        const duplicate = path.join(root, "duplicate.log");
        const compressed = path.join(root, "compressed.log");
        const excluded = path.join(root, "excluded.log");
        const alreadyRotated = path.join(root, "old.log.2026-06-06T00-00-00.000Z");
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

    it("returns a completed summary when state persistence fails", async () => {
        const root = path.join(tempDir, "persist-failure");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        await writeFile(logFile, "large enough", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "persist-failure",
                    paths: [logFile],
                    compress: false,
                    maxSizeMb: 0.000001,
                },
            ],
        });
        __testing.setWriteCacheSuccessForTests(() => {
            throw new Error("cache unavailable");
        });
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, false);
            assert.equal(summary.rotatedFiles, 1);
            assert.match(JSON.stringify(summary.errors), /cache unavailable/u);
        } finally {
            __testing.resetWriteCacheSuccessForTests();
        }
    });

    it("restores renamed logs when replacement creation fails", async () => {
        const root = path.join(tempDir, "rename-restore");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        await writeFile(logFile, "active log", "utf8");
        const open = fsPromises.open.bind(fsPromises);
        mock.method(
            fsPromises,
            "open",
            async (
                filePath: Parameters<typeof fsPromises.open>[0],
                flags: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                if (
                    String(filePath) === logFile &&
                    typeof flags === "number" &&
                    (flags & constants.O_CREAT) !== 0
                ) {
                    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
                }
                return open(filePath, flags, mode);
            }
        );
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "rename",
                    paths: [logFile],
                    strategy: "rename",
                    compress: false,
                    maxSizeMb: 0.000001,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, false);
        assert.equal(summary.rotatedFiles, 0);
        assert.equal(await readFile(logFile, "utf8"), "active log");
        assert.match(JSON.stringify(summary.errors), /disk full/u);
        const archiveNames = await fsPromises.readdir(root);
        assert.deepEqual(
            archiveNames.filter((name) => name.startsWith("app.log.")),
            []
        );
    });

    it("does not restore over a log recreated during rename rotation", async () => {
        const root = path.join(tempDir, "rename-recreated-target");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        await writeFile(logFile, "active log", "utf8");
        const open = fsPromises.open.bind(fsPromises);
        mock.method(
            fsPromises,
            "open",
            async (
                filePath: Parameters<typeof fsPromises.open>[0],
                flags: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                if (
                    String(filePath) === logFile &&
                    typeof flags === "number" &&
                    (flags & constants.O_CREAT) !== 0
                ) {
                    await writeFile(logFile, "new logger line", "utf8");
                    throw Object.assign(new Error("file already exists"), {
                        code: "EEXIST",
                    });
                }
                return open(filePath, flags, mode);
            }
        );
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "rename",
                    paths: [logFile],
                    strategy: "rename",
                    compress: false,
                    maxSizeMb: 0.000001,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.rotatedFiles, 1);
        assert.equal(await readFile(logFile, "utf8"), "new logger line");
        const archiveNames = await fsPromises.readdir(root);
        assert.equal(
            archiveNames.filter((name) => name.startsWith("app.log.")).length,
            1
        );
    });

    it("handles dry-run, empty files, not-due cadence, retention compression, and invalid state", async () => {
        const root = path.join(tempDir, "logs");
        await mkdir(root);
        const empty = path.join(root, "empty.log");
        const daily = path.join(root, "daily.log");
        const archive = path.join(root, "daily.log.2020-01-01T00-00-00.000Z");
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
                    keepDays: 0,
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
        assert.equal(dryRun.compressedFiles, 0);
        assert.equal(dryRun.deletedArchives, 3);
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

    it("deletes expired per-file archives without compressing them first", async () => {
        const root = path.join(tempDir, "retention-delete-first");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        const archive = path.join(root, "app.log.2020-01-01T00-00-00.000Z");
        await writeFile(logFile, "active", "utf8");
        await writeFile(archive, "expired", "utf8");
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await utimes(archive, oldTime, oldTime);
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "retention",
                    paths: [logFile],
                    archivePaths: [path.join(root, "app.log.*")],
                    compress: true,
                    keepDays: 0,
                    maxSizeMb: 100,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.skippedFiles, 1);
        assert.equal(summary.deletedArchives, 1);
        assert.equal(summary.compressedFiles, 0);
        await assert.rejects(() => fsPromises.stat(archive), /ENOENT/u);
        await assert.rejects(() => fsPromises.stat(`${archive}.gz`), /ENOENT/u);
    });

    it("compresses retained managed per-file archives", async () => {
        const root = path.join(tempDir, "retention-managed");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        const archive = path.join(root, "app.log.2026-06-06T00-00-00.000Z");
        await writeFile(logFile, "active", "utf8");
        await writeFile(archive, "retained", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "retention",
                    paths: [logFile],
                    compress: true,
                    keep: 1,
                    maxSizeMb: 100,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.skippedFiles, 1);
        assert.equal(summary.deletedArchives, 0);
        assert.equal(summary.compressedFiles, 1);
        await assert.rejects(() => fsPromises.stat(archive), /ENOENT/u);
        assert.ok(await fsPromises.stat(`${archive}.gz`));
    });

    it("records warnings when retained archive compression fails", async () => {
        const root = path.join(tempDir, "retention-compression-warning");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        const archive = path.join(root, "app.log.2026-06-06T00-00-00.000Z");
        await writeFile(logFile, "active", "utf8");
        await writeFile(archive, "retained", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "retention",
                    paths: [logFile],
                    compress: true,
                    keep: 1,
                    maxSizeMb: 100,
                },
            ],
        });
        __testing.setGzipPipelineForTests(async () => {
            throw new Error("retention gzip unavailable");
        });
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, true);
            assert.equal(summary.compressedFiles, 0);
            assert.match(JSON.stringify(summary.warnings), /retention gzip unavailable/u);
        } finally {
            __testing.resetGzipPipeline();
        }
    });

    it("keeps the newest rotation even when the source log has an old mtime", async () => {
        const root = path.join(tempDir, "old-source-retention");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        const existingArchive = path.join(root, "app.log.2026-01-01T00-00-00.000Z");
        await writeFile(logFile, "rotate old source", "utf8");
        await writeFile(existingArchive, "existing archive", "utf8");
        await utimes(
            logFile,
            new Date("2020-01-01T00:00:00.000Z"),
            new Date("2020-01-01T00:00:00.000Z")
        );
        await utimes(
            existingArchive,
            new Date("2026-01-01T00:00:00.000Z"),
            new Date("2026-01-01T00:00:00.000Z")
        );
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "copytruncate",
                    paths: [logFile],
                    archivePaths: [path.join(root, "app.log.*")],
                    compress: false,
                    keep: 1,
                    maxSizeMb: 0.000001,
                    strategy: "copytruncate",
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.rotatedFiles, 1);
        assert.equal(summary.deletedArchives, 1);
        await assert.rejects(() => fsPromises.stat(existingArchive), /ENOENT/u);
        const state = JSON.parse(
            (
                db
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
                    )
                    .get() as { data_json: string }
            ).data_json
        ) as { files: Record<string, { lastArchive: string }> };
        assert.ok(await fsPromises.stat(state.files[logFile]?.lastArchive ?? ""));
    });

    it("compresses retained per-file archivePaths", async () => {
        const root = path.join(tempDir, "retention-archive-paths");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        const archive = path.join(root, "external.archive");
        await writeFile(logFile, "active", "utf8");
        await writeFile(archive, "retained", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "retention",
                    paths: [logFile],
                    archivePaths: [archive],
                    compress: true,
                    keep: 1,
                    maxSizeMb: 100,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.skippedFiles, 1);
        assert.equal(summary.deletedArchives, 0);
        assert.equal(summary.compressedFiles, 1);
        await assert.rejects(() => fsPromises.stat(archive), /ENOENT/u);
        assert.ok(await fsPromises.stat(`${archive}.gz`));
    });

    it("records warnings when archive-only compression fails", async () => {
        const root = path.join(tempDir, "archive-only-compression-warning");
        await mkdir(root);
        const archive = path.join(root, "app.log.2026-06-06T00-00-00.000Z");
        await writeFile(archive, "retained", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "archive-only",
                    archiveOnly: true,
                    archivePaths: [path.join(root, "app.log.*")],
                    compress: true,
                    keep: 1,
                    paths: [path.join(root, "unused.log")],
                },
            ],
        });
        __testing.setGzipPipelineForTests(async () => {
            throw new Error("archive-only gzip unavailable");
        });
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, true);
            assert.equal(summary.compressedFiles, 0);
            assert.match(
                JSON.stringify(summary.warnings),
                /archive-only gzip unavailable/u
            );
        } finally {
            __testing.resetGzipPipeline();
        }
    });

    it("skips archive-only paths that fail safety or stat checks", async () => {
        const root = path.join(tempDir, "archive-only-list-warning");
        const outside = path.join(tempDir, "archive-only-list-warning-outside");
        await mkdir(root);
        await mkdir(outside);
        const retained = path.join(root, "app.log.2026-06-06T00-00-00.000Z");
        const unsafeArchive = path.join(outside, "unsafe.log.2026-06-06T00-00-00.000Z");
        await writeFile(retained, "retained", "utf8");
        await writeFile(unsafeArchive, "unsafe", "utf8");
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await Promise.all(
            [retained, unsafeArchive].map((file) => utimes(file, oldTime, oldTime))
        );
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "archive-only",
                    archiveOnly: true,
                    archivePaths: [path.join(root, "*.log.*"), unsafeArchive],
                    compress: false,
                    keep: 2,
                    paths: [path.join(root, "unused.log")],
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.checkedFiles, 1);
        assert.match(JSON.stringify(summary.warnings), /Skipping archive-only path/u);
        assert.match(JSON.stringify(summary.warnings), /Unsafe path/u);
    });

    it("continues archive-only retention when per-archive actions fail", async () => {
        const root = path.join(tempDir, "archive-only-action-warning");
        await mkdir(root);
        const retained = path.join(root, "app.log.2026-06-06T00-00-00.000Z");
        const deleted = path.join(root, "app.log.2020-01-01T00-00-00.000Z");
        await writeFile(retained, "retained", "utf8");
        await writeFile(deleted, "deleted", "utf8");
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await Promise.all(
            [retained, deleted].map((file) => utimes(file, oldTime, oldTime))
        );
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "archive-only",
                    archiveOnly: true,
                    archivePaths: [path.join(root, "*.log.*")],
                    compress: true,
                    keep: 1,
                    paths: [path.join(root, "unused.log")],
                },
            ],
        });
        __testing.setArchiveOnlyCompressArchiveIfNeededForTests(async (archive) => {
            throw new Error(`compress failed for ${archive.path}`);
        });
        __testing.setArchiveOnlyUnlinkVerifiedForTests(async (filePath) => {
            throw new Error(`delete failed for ${filePath}`);
        });
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, true);
            assert.equal(summary.compressedFiles, 0);
            assert.equal(summary.deletedArchives, 0);
            assert.match(JSON.stringify(summary.warnings), /compress failed/u);
            assert.match(JSON.stringify(summary.warnings), /delete failed/u);
        } finally {
            __testing.resetArchiveOnlyRetentionRunnersForTests();
        }
    });

    it("records archive-only group errors when archive discovery fails", async () => {
        const root = path.join(tempDir, "archive-only-discovery-error");
        await mkdir(root);
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "archive-only",
                    archiveOnly: true,
                    archivePaths: [path.join(root, "*.log")],
                    keep: 1,
                    paths: [path.join(root, "unused.log")],
                },
            ],
        });

        mock.method(fsPromises, "readdir", async () => {
            throw new Error("archive discovery failed");
        });
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, false);
            assert.match(JSON.stringify(summary.errors), /archive-only/u);
            assert.match(JSON.stringify(summary.errors), /archive discovery failed/u);
        } finally {
            mock.restoreAll();
        }
    });

    it("returns a failed summary when non-dry-run rotation is already locked", async () => {
        const root = path.join(tempDir, "locked-logs");
        await mkdir(root);
        const file = path.join(root, "app.log");
        await writeFile(file, "log", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [{ name: "locked", paths: [file], maxSizeMb: 0 }],
        });
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, `${process.pid}\n`, "utf8");
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, false);
            assert.match(
                (summary.errors[0] as { message?: string } | undefined)?.message ?? "",
                /already running/u
            );
            assert.equal(await readFile(file, "utf8"), "log");
        } finally {
            await rm(lockPath, { force: true });
        }
    });

    it("recovers from stale non-dry-run rotation locks", async () => {
        const root = path.join(tempDir, "stale-lock-logs");
        await mkdir(root);
        const file = path.join(root, "app.log");
        await writeFile(file, "log", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [{ name: "stale-lock", paths: [file], maxSizeMb: 0 }],
        });
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");

        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, true);
            assert.doesNotMatch(JSON.stringify(summary.errors), /already running/u);
        } finally {
            await rm(lockPath, { force: true });
        }
    });

    it("allows only one concurrent caller to reclaim a stale lock", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        const locks: Array<Awaited<ReturnType<typeof __testing.acquireLogRotationLock>>> =
            [];

        try {
            locks.push(
                ...(await Promise.all([
                    __testing.acquireLogRotationLock(false),
                    __testing.acquireLogRotationLock(false),
                ]))
            );

            const acquired = locks.filter((handle) => handle !== null);
            assert.equal(acquired.length, 1);
            assert.equal(locks.filter((handle) => handle === null).length, 1);
        } finally {
            await Promise.all(
                locks.map((handle) =>
                    handle ? handle.close().catch(() => {}) : Promise.resolve()
                )
            );
            await rm(lockPath, { force: true }).catch(() => {});
        }
    });

    it("recovers a stale reclaim directory while reclaiming stale locks", async () => {
        const lockPath = testLockPath(tempDir);
        const reclaimPath = `${lockPath}.reclaim`;
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        await mkdir(reclaimPath);
        const staleTime = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(reclaimPath, staleTime, staleTime);

        const lock = await __testing.acquireLogRotationLock(false);
        try {
            assert.ok(lock);
        } finally {
            await lock?.close().catch(() => {});
            await rm(lockPath, { force: true }).catch(() => {});
            await rm(reclaimPath, { force: true, recursive: true }).catch(() => {});
        }
    });

    it("treats missing reclaim directories as already removable", async () => {
        assert.equal(
            await __testing.removeStaleReclaimDir(path.join(tempDir, "missing.reclaim")),
            true
        );
    });

    it("rethrows unexpected reclaim directory stat failures", async () => {
        const reclaimPath = path.join(tempDir, "denied.reclaim");
        const statError = Object.assign(new Error("stat denied"), { code: "EACCES" });
        const originalStat = fsPromises.stat.bind(fsPromises);
        const statMock = mock.method(fsPromises, "stat", (target: PathLike) => {
            if (String(target) === reclaimPath) {
                throw statError;
            }
            return originalStat(target);
        });
        try {
            await assert.rejects(
                () => __testing.removeStaleReclaimDir(reclaimPath),
                /stat denied/u
            );
        } finally {
            statMock.mock.restore();
        }
    });

    it("returns null when stale lock reacquire loses the final create race", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        const originalOpen = fsPromises.open.bind(fsPromises);
        let createAttempts = 0;
        const openMock = mock.method(
            fsPromises,
            "open",
            (
                target: Parameters<typeof fsPromises.open>[0],
                flags?: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                if (String(target) === lockPath && flags === "wx") {
                    createAttempts += 1;
                    if (createAttempts === 2) {
                        const error = new Error(
                            "lost create race"
                        ) as NodeJS.ErrnoException;
                        error.code = "EEXIST";
                        throw error;
                    }
                }
                return originalOpen(target, flags, mode);
            }
        );
        try {
            assert.equal(await __testing.acquireLogRotationLock(false), null);
        } finally {
            openMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("returns null when stale reclaim directory recreation loses the race", async () => {
        const lockPath = testLockPath(tempDir);
        const reclaimPath = `${lockPath}.reclaim`;
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        await mkdir(reclaimPath);
        const staleTime = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(reclaimPath, staleTime, staleTime);
        const originalMkdir = fsPromises.mkdir.bind(fsPromises);
        const mkdirMock = mock.method(
            fsPromises,
            "mkdir",
            (
                target: Parameters<typeof fsPromises.mkdir>[0],
                options?: Parameters<typeof fsPromises.mkdir>[1]
            ) => {
                if (String(target) === reclaimPath) {
                    const error = new Error("reclaim race") as NodeJS.ErrnoException;
                    error.code = "EEXIST";
                    throw error;
                }
                return originalMkdir(target, options);
            }
        );
        try {
            assert.equal(await __testing.acquireLogRotationLock(false), null);
        } finally {
            mkdirMock.mock.restore();
            await rm(lockPath, { force: true });
            await rm(reclaimPath, { force: true, recursive: true });
        }
    });

    it("rethrows unexpected stale reclaim directory recreation errors", async () => {
        const lockPath = testLockPath(tempDir);
        const reclaimPath = `${lockPath}.reclaim`;
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        await mkdir(reclaimPath);
        const staleTime = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(reclaimPath, staleTime, staleTime);
        const originalMkdir = fsPromises.mkdir.bind(fsPromises);
        let reclaimMkdirAttempts = 0;
        const mkdirMock = mock.method(
            fsPromises,
            "mkdir",
            (
                target: Parameters<typeof fsPromises.mkdir>[0],
                options?: Parameters<typeof fsPromises.mkdir>[1]
            ) => {
                if (String(target) === reclaimPath) {
                    reclaimMkdirAttempts += 1;
                    const error = new Error(
                        "reclaim mkdir denied"
                    ) as NodeJS.ErrnoException;
                    error.code = reclaimMkdirAttempts === 1 ? "EEXIST" : "EACCES";
                    throw error;
                }
                return originalMkdir(target, options);
            }
        );
        try {
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                /reclaim mkdir denied/u
            );
        } finally {
            mkdirMock.mock.restore();
            await rm(lockPath, { force: true });
            await rm(reclaimPath, { force: true, recursive: true });
        }
    });

    it("removes a newly created lock when writing the pid fails", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        const originalOpen = fsPromises.open.bind(fsPromises);
        const writeError = new Error("pid write failed");
        const openMock = mock.method(
            fsPromises,
            "open",
            async (
                target: Parameters<typeof fsPromises.open>[0],
                flags?: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                const handle = await originalOpen(target, flags, mode);
                if (String(target) !== lockPath || flags !== "wx") {
                    return handle;
                }
                return {
                    close: () => handle.close(),
                    writeFile: async () => {
                        await handle.writeFile(`${process.pid}\n`);
                        throw writeError;
                    },
                } as unknown as Awaited<ReturnType<typeof fsPromises.open>>;
            }
        );
        try {
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                writeError
            );
            await assert.rejects(readFile(lockPath, "utf8"), {
                code: "ENOENT",
            });
        } finally {
            openMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("rethrows unexpected errors from stale lock reacquire", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        const originalOpen = fsPromises.open.bind(fsPromises);
        let createAttempts = 0;
        const openMock = mock.method(
            fsPromises,
            "open",
            (
                target: Parameters<typeof fsPromises.open>[0],
                flags?: Parameters<typeof fsPromises.open>[1],
                mode?: Parameters<typeof fsPromises.open>[2]
            ) => {
                if (String(target) === lockPath && flags === "wx") {
                    createAttempts += 1;
                    if (createAttempts === 2) {
                        const error = new Error(
                            "reacquire denied"
                        ) as NodeJS.ErrnoException;
                        error.code = "EACCES";
                        throw error;
                    }
                }
                return originalOpen(target, flags, mode);
            }
        );
        try {
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                /reacquire denied/u
            );
        } finally {
            openMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("rethrows unexpected stale lock reclaim setup errors", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        const originalMkdir = fsPromises.mkdir.bind(fsPromises);
        const mkdirMock = mock.method(
            fsPromises,
            "mkdir",
            (
                target: Parameters<typeof fsPromises.mkdir>[0],
                options?: Parameters<typeof fsPromises.mkdir>[1]
            ) => {
                if (String(target).endsWith(".reclaim")) {
                    const error = new Error(
                        "reclaim mkdir failed"
                    ) as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalMkdir(target, options);
            }
        );
        try {
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                /reclaim mkdir failed/u
            );
        } finally {
            mkdirMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("handles stale lock unlink races and errors", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        const originalUnlink = fsPromises.unlink.bind(fsPromises);
        let unlinkMode: "enoent" | "denied" = "enoent";
        const unlinkMock = mock.method(
            fsPromises,
            "unlink",
            async (target: Parameters<typeof fsPromises.unlink>[0]) => {
                if (String(target) === lockPath) {
                    if (unlinkMode === "enoent") {
                        await originalUnlink(target);
                    }
                    const error = new Error(
                        unlinkMode === "enoent" ? "already gone" : "unlink denied"
                    ) as NodeJS.ErrnoException;
                    error.code = unlinkMode === "enoent" ? "ENOENT" : "EACCES";
                    throw error;
                }
                return originalUnlink(target);
            }
        );
        try {
            const lock = await __testing.acquireLogRotationLock(false);
            assert.ok(lock);
            await lock.close();
            await rm(lockPath, { force: true });

            unlinkMode = "denied";
            await writeFile(lockPath, "not-a-pid\n", "utf8");
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                /unlink denied/u
            );
        } finally {
            unlinkMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("rethrows unexpected stale lock read errors", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "not-a-pid\n", "utf8");
        const originalOpen = fsPromises.open.bind(fsPromises);
        const openMock = mock.method(
            fsPromises,
            "open",
            async (...args: Parameters<typeof fsPromises.open>) => {
                if (String(args[0]) === lockPath && args[1] === "r") {
                    const error = new Error("lock read denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalOpen(...args);
            }
        );
        try {
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                /lock read denied/u
            );
        } finally {
            openMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("treats inaccessible lock PIDs as running", async () => {
        const lockPath = testLockPath(tempDir);
        await mkdir(path.dirname(lockPath), { recursive: true });
        await writeFile(lockPath, "123\n", "utf8");
        const killMock = mock.method(process, "kill", () => {
            const error = new Error("operation not permitted") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
        });
        try {
            assert.equal(await __testing.acquireLogRotationLock(false), null);
        } finally {
            killMock.mock.restore();
            await rm(lockPath, { force: true });
        }
    });

    it("rethrows unexpected log rotation lock acquisition errors", async () => {
        const openMock = mock.method(fsPromises, "open", () => {
            const error = new Error("lock open failed") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
        });
        try {
            await assert.rejects(
                () => __testing.acquireLogRotationLock(false),
                /lock open failed/u
            );
        } finally {
            openMock.mock.restore();
        }
    });

    it("skips archive paths that fail approved-root validation during retention", async () => {
        const root = path.join(tempDir, "logs");
        const archiveRoot = path.join(tempDir, "archives");
        await mkdir(root);
        await mkdir(archiveRoot);
        const file = path.join(root, "app.log");
        const archive = path.join(root, "other.log.2020-01-01T00-00-00.000Z");
        const centralArchive = path.join(archiveRoot, "app.log.2020-01-01T00-00-00.000Z");
        await writeFile(file, "log", "utf8");
        await writeFile(archive, "archive", "utf8");
        await writeFile(centralArchive, "central archive", "utf8");
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
            const archives = await __testing.listArchives(
                file,
                { archivePaths: [centralArchive], archiveRetentionScope: "basename" },
                [root, archiveRoot]
            );
            assert.deepEqual(
                archives.map((entry) => entry.path),
                []
            );
            const parentScopedArchives = await __testing.listArchives(
                file,
                { archivePaths: [centralArchive], archiveRetentionScope: "parent" },
                [root, archiveRoot]
            );
            assert.deepEqual(
                parentScopedArchives.map((entry) => entry.path),
                [centralArchive]
            );
        } finally {
            realpathMock.mock.restore();
        }
    });

    it("keeps basename archive retention scoped to each log directory", async () => {
        const firstRoot = path.join(tempDir, "basename-retention-a");
        const secondRoot = path.join(tempDir, "basename-retention-b");
        await mkdir(firstRoot);
        await mkdir(secondRoot);
        const firstLog = path.join(firstRoot, "app.log");
        const secondLog = path.join(secondRoot, "app.log");
        const firstArchive = path.join(firstRoot, "app.log.1");
        const secondArchive = path.join(secondRoot, "app.log.1");
        await writeFile(firstLog, "first", "utf8");
        await writeFile(secondLog, "second", "utf8");
        await writeFile(firstArchive, "first archive", "utf8");
        await writeFile(secondArchive, "second archive", "utf8");

        const archives = await __testing.listArchives(
            firstLog,
            {
                archivePaths: [
                    path.join(firstRoot, "app.log.*"),
                    path.join(secondRoot, "app.log.*"),
                ],
                archiveRetentionScope: "basename",
            },
            [firstRoot, secondRoot]
        );

        assert.deepEqual(
            archives.map((archive) => archive.path),
            [firstArchive]
        );

        const activeOverlap = await __testing.listArchives(
            firstLog,
            {
                archivePaths: [firstLog, firstArchive],
                archiveRetentionScope: "basename",
            },
            [firstRoot]
        );

        assert.deepEqual(
            activeOverlap.map((archive) => archive.path),
            [firstArchive]
        );
    });

    it("applies archive-only retention scopes and records group/file errors", async () => {
        const root = path.join(tempDir, "logs");
        const outside = path.join(tempDir, "outside");
        await mkdir(root);
        await mkdir(outside);
        const recent = path.join(root, "a.log.2026-06-06T00-00-00.000Z");
        const oldA = path.join(root, "a.log.2020-01-01T00-00-00.000Z");
        const oldAExpired = path.join(root, "a.log.2019-01-01T00-00-00.000Z");
        const oldB = path.join(root, "nested.log.2020-01-01T00-00-00.000Z");
        const unsafe = path.join(outside, "unsafe.log.2020-01-01T00-00-00.000Z");
        const unsafePlain = path.join(outside, "plain.log");
        const target = path.join(root, "target.log");
        const link = path.join(root, "link.log");
        await writeFile(recent, "recent", "utf8");
        await writeFile(oldA, "old a", "utf8");
        await writeFile(oldAExpired, "old a expired", "utf8");
        await writeFile(oldB, "old b", "utf8");
        await writeFile(unsafe, "unsafe", "utf8");
        await writeFile(unsafePlain, "unsafe", "utf8");
        await writeFile(target, "target", "utf8");
        await symlink(target, link);
        const oldTime = new Date("2020-01-01T00:00:00.000Z");
        await Promise.all(
            [oldA, oldAExpired, oldB, unsafe].map((file) =>
                utimes(file, oldTime, oldTime)
            )
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
                },
                {
                    name: "unsafe-archive",
                    archiveOnly: true,
                    archivePaths: [path.join(outside, "*.log.*")],
                    archiveRetentionScope: "parent",
                    keepDays: 0,
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
        assert.equal(summary.groups[0]?.checkedFiles, 3);
        assert.equal(summary.groups[0]?.compressedFiles, 2);
        assert.ok(summary.groups[0]?.deletedArchives);
        assert.ok(
            summary.errors.some((error) => JSON.stringify(error).includes("Unsafe path"))
        );
    });

    it("reports missing literal paths when missingOk is false", async () => {
        const root = path.join(tempDir, "required-logs");
        await mkdir(root);
        const existingLog = path.join(root, "existing.log");
        const missingLog = path.join(root, "missing.log");
        const missingExclude = path.join(root, "missing-exclude.log");
        await writeFile(existingLog, "existing", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "missing-literal-path",
                    paths: [missingLog],
                    missingOk: false,
                },
                {
                    name: "missing-literal-exclude",
                    paths: [existingLog],
                    excludePaths: [missingExclude],
                    missingOk: false,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, false);
        assert.equal(
            summary.errors.filter((error) =>
                JSON.stringify(error).includes("Log rotation path does not exist")
            ).length,
            2
        );
    });

    it("applies top-level exclude paths to every group", async () => {
        const root = path.join(tempDir, "global-excludes");
        await mkdir(root);
        const keptLog = path.join(root, "kept.log");
        const excludedLog = path.join(root, "excluded.log");
        await writeFile(keptLog, "x".repeat(64), "utf8");
        await writeFile(excludedLog, "x".repeat(64), "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            excludePaths: [excludedLog],
            groups: [
                {
                    name: "global-exclude",
                    paths: [path.join(root, "*.log")],
                    maxSizeMb: 0.00001,
                    strategy: "copytruncate",
                    compress: false,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: false, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.rotatedFiles, 1);
        assert.equal(await readFile(keptLog, "utf8"), "");
        assert.equal(await readFile(excludedLog, "utf8"), "x".repeat(64));
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

    it("honors group-specific approved roots during policy execution", async () => {
        const root = path.join(tempDir, "group-root");
        await mkdir(root);
        const logPath = path.join(root, "group.log");
        await writeFile(logPath, "rotate me", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [path.join(tempDir, "global-root")],
            groups: [
                {
                    name: "group-root",
                    approvedRoots: [root],
                    paths: [logPath],
                    maxSizeMb: 0.000001,
                    strategy: "copytruncate",
                    compress: false,
                },
            ],
        });

        const summary = await runLogRotationService({ dryRun: true, config });

        assert.equal(summary.ok, true);
        assert.equal(summary.rotatedFiles, 1);
    });

    it("forwards runtime environment to elevated log rotation", () => {
        const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;
        const originalTimezone = process.env.TZ;
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempDir, "dashboard.sqlite");
        process.env.TZ = "Europe/Oslo";
        try {
            const env = __testing.elevatedLogRotationEnvironment();
            assert.equal(env.MIRA_DASHBOARD_DB_PATH, process.env.MIRA_DASHBOARD_DB_PATH);
            assert.equal(env.TZ, "Europe/Oslo");
        } finally {
            if (originalDbPath === undefined) {
                delete process.env.MIRA_DASHBOARD_DB_PATH;
            } else {
                process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
            }
            if (originalTimezone === undefined) {
                delete process.env.TZ;
            } else {
                process.env.TZ = originalTimezone;
            }
        }
    });

    it("covers copytruncate compression and disappearing safe-path races", async () => {
        const root = path.join(tempDir, "race-logs");
        const archiveRoot = path.join(tempDir, "race-archives");
        await mkdir(root);
        await mkdir(archiveRoot);
        const copyPlain = path.join(root, "copy-plain.log");
        const copyGzip = path.join(root, "copy-gzip.log");
        const vanish = path.join(root, "vanish.log");
        const archiveVanish = path.join(
            archiveRoot,
            "archive.log.2020-01-01T00-00-00.000Z"
        );
        const otherDirArchive = path.join(
            archiveRoot,
            "copy-plain.log.2020-01-01T00-00-00.000Z"
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
                    keepDays: 0,
                },
                {
                    name: "archive-pattern-only",
                    paths: [path.join(root, "missing-pattern.log")],
                    missingOk: true,
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

    it("keeps committed rotated archives when compression fails", async () => {
        const root = path.join(tempDir, "compression-warning");
        await mkdir(root);
        const logFile = path.join(root, "app.log");
        await writeFile(logFile, "compress me", "utf8");
        const config = await writeConfig(tempDir, {
            version: 1,
            approvedRoots: [root],
            groups: [
                {
                    name: "copy-gzip",
                    paths: [logFile],
                    strategy: "copytruncate",
                    compress: true,
                    maxSizeMb: 0.000001,
                },
            ],
        });
        __testing.setGzipPipelineForTests(async () => {
            throw new Error("gzip unavailable");
        });
        try {
            const summary = await runLogRotationService({ dryRun: false, config });

            assert.equal(summary.ok, true);
            assert.equal(summary.rotatedFiles, 1);
            assert.equal(summary.compressedFiles, 0);
            assert.equal(await readFile(logFile, "utf8"), "");
            assert.match(JSON.stringify(summary.warnings), /gzip unavailable/u);

            const rootEntries = await fsPromises.readdir(root);
            const archives = rootEntries.filter((name) => name.startsWith("app.log."));
            assert.equal(archives.length, 1);
            assert.equal(archives[0].endsWith(".gz"), false);
        } finally {
            __testing.resetGzipPipeline();
        }
    });

    it("removes incomplete copytruncate archives and reports cleanup failures", async () => {
        const root = path.join(tempDir, "copytruncate-cleanup");
        await mkdir(root);
        const logPath = path.join(root, "app.log");
        const archivePath = path.join(root, "app.log.2026-06-08T00-00-00.000Z");
        await writeFile(logPath, "pending archive", "utf8");
        const source = await open(logPath, "r+");
        const stat = await source.stat();
        const unlinkMock = mock.method(fsPromises, "unlink", async (target: PathLike) => {
            if (String(target) === archivePath) {
                throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
            }
        });
        const warnMock = mock.method(console, "warn", () => {});
        try {
            await assert.rejects(
                () =>
                    __testing.rotateCopyTruncate(
                        logPath,
                        {
                            handle: {
                                fd: source.fd,
                                truncate: async () => {
                                    throw new Error("truncate failed");
                                },
                            },
                            stat,
                        } as never,
                        archivePath,
                        false,
                        [root]
                    ),
                /truncate failed/u
            );
            assert.equal(unlinkMock.mock.callCount(), 1);
            assert.equal(warnMock.mock.callCount(), 1);
        } finally {
            unlinkMock.mock.restore();
            warnMock.mock.restore();
            await source.close();
            await rm(archivePath, { force: true });
        }
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
