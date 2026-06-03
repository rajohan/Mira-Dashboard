import assert from "node:assert/strict";
import fs from "node:fs";
import {
    chmod,
    link,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
    __testing,
    copyGuarded,
    copyNoFollowGuarded,
    guardedPath,
    mkdirGuarded,
    openReadNoFollowGuarded,
    readdirGuarded,
    readdirGuardedAsync,
    readFromOpenFile,
    readJson5Guarded,
    readTextGuarded,
    readTextNoFollowGuarded,
    spawnGuarded,
    statGuarded,
    statGuardedAsync,
    writeTextGuarded,
    writeTextNoFollowExclusiveGuarded,
    writeTextNoFollowGuarded,
} from "./guardedOps.js";

describe("guarded filesystem helpers", () => {
    it("wraps sync and async filesystem operations behind guarded paths", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-guarded-"));
        try {
            const nested = guardedPath(path.join(baseDir, "nested"));
            mkdirGuarded(nested, { recursive: true });

            const source = guardedPath(path.join(baseDir, "nested", "source.txt"));
            await writeFile(source, "'hello'", "utf8");
            await chmod(source, 0o600);

            assert.equal(readTextGuarded(source), "'hello'");
            assert.equal(readJson5Guarded(source), "hello");
            const sourceStat = await statGuardedAsync(source);
            assert.equal(statGuarded(source).isFile(), true);
            assert.equal(sourceStat.isFile(), true);

            const entries = readdirGuarded(guardedPath(path.join(baseDir, "nested")), {
                withFileTypes: true,
            });
            assert.deepEqual(
                entries.map((entry) => entry.name),
                ["source.txt"]
            );
            const asyncEntries = await readdirGuardedAsync(nested, {
                withFileTypes: true,
            });
            assert.deepEqual(
                asyncEntries.map((entry) => entry.name),
                ["source.txt"]
            );

            const copied = guardedPath(path.join(baseDir, "nested", "copied.txt"));
            copyGuarded(source, copied);
            assert.equal(await readFile(copied, "utf8"), "'hello'");
            const noFollowCopy = guardedPath(
                path.join(baseDir, "nested", "no-follow-copy.txt")
            );
            await copyNoFollowGuarded(source, noFollowCopy);
            assert.equal(await readFile(noFollowCopy, "utf8"), "'hello'");
            const noFollowCopyStat = await stat(noFollowCopy);
            assert.equal(noFollowCopyStat.mode & 0o777, 0o600);

            const opened = await openReadNoFollowGuarded(copied);
            try {
                assert.equal(readFromOpenFile(opened.fd, 7).toString(), "'hello'");
                assert.equal(readFromOpenFile(opened.fd, 20).toString(), "'hello'");
            } finally {
                await opened.close();
            }

            assert.equal(await readTextNoFollowGuarded(copied), "'hello'");

            await writeTextGuarded(copied, "updated");
            assert.equal(await readFile(copied, "utf8"), "updated");

            await writeTextNoFollowGuarded(copied, "no-follow");
            assert.equal(await readFile(copied, "utf8"), "no-follow");
            await chmod(copied, 0o600);
            await writeTextNoFollowGuarded(copied, "preserved");
            assert.equal(await readFile(copied, "utf8"), "preserved");
            const preservedStat = await stat(copied);
            assert.equal(preservedStat.mode & 0o777, 0o600);
            await writeTextNoFollowGuarded(copied, "private", 0o600);
            assert.equal(await readFile(copied, "utf8"), "private");
            const privateStat = await stat(copied);
            assert.equal(privateStat.mode & 0o777, 0o600);

            const exclusive = guardedPath(path.join(baseDir, "nested", "exclusive.txt"));
            await writeTextNoFollowExclusiveGuarded(exclusive, "exclusive", 0o600);
            assert.equal(await readFile(exclusive, "utf8"), "exclusive");
            const exclusiveStat = await stat(exclusive);
            assert.equal(exclusiveStat.mode & 0o777, 0o600);
            await assert.rejects(
                () => writeTextNoFollowExclusiveGuarded(exclusive, "blocked"),
                { code: "EEXIST" }
            );
        } finally {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("refuses symlink targets for no-follow writes", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-guarded-"));
        try {
            const realTarget = path.join(baseDir, "real.txt");
            const linkTarget = guardedPath(path.join(baseDir, "link.txt"));
            const hardLinkTarget = guardedPath(path.join(baseDir, "hardlink.txt"));
            await writeFile(realTarget, "real", "utf8");
            await symlink(realTarget, linkTarget);
            await link(realTarget, hardLinkTarget);

            const originalContent = await readFile(realTarget, "utf8");
            await assert.rejects(() => writeTextNoFollowGuarded(linkTarget, "blocked"));
            await assert.rejects(() =>
                copyNoFollowGuarded(guardedPath(realTarget), linkTarget)
            );
            await assert.rejects(() =>
                copyNoFollowGuarded(linkTarget, guardedPath(realTarget))
            );
            await assert.rejects(
                () => copyNoFollowGuarded(guardedPath(realTarget), hardLinkTarget),
                /Source and destination must differ/u
            );
            assert.equal(await readFile(realTarget, "utf8"), originalContent);

            const otherTarget = path.join(baseDir, "other.txt");
            const hardLinkedDestination = guardedPath(
                path.join(baseDir, "hard-linked-destination.txt")
            );
            await writeFile(otherTarget, "other", "utf8");
            await link(otherTarget, hardLinkedDestination);
            await assert.rejects(
                () => copyNoFollowGuarded(guardedPath(realTarget), hardLinkedDestination),
                /Destination must not be hard-linked/u
            );
            assert.equal(await readFile(otherTarget, "utf8"), "other");

            await assert.rejects(
                () => writeTextNoFollowGuarded(hardLinkedDestination, "blocked"),
                /Destination must not be hard-linked/u
            );
            assert.equal(await readFile(otherTarget, "utf8"), "other");

            const realStat = await stat(realTarget);
            assert.equal(realStat.isFile(), true);
            await assert.rejects(
                () =>
                    copyNoFollowGuarded(
                        guardedPath("/dev/null"),
                        guardedPath(realTarget)
                    ),
                /Source must be a regular file/u
            );
            await assert.rejects(
                () =>
                    copyNoFollowGuarded(
                        guardedPath(realTarget),
                        guardedPath("/dev/null")
                    ),
                /Destination must be a regular file/u
            );
            await assert.rejects(
                () => writeTextNoFollowGuarded(guardedPath("/dev/null"), "blocked"),
                /Destination must be a regular file/u
            );

            __testing.setReadChunkForTest(async () => ({ bytesRead: 0 }));
            try {
                const zeroReadCopy = path.join(baseDir, "zero-read-copy.txt");
                await writeFile(zeroReadCopy, "keep me", "utf8");
                await assert.rejects(
                    () =>
                        copyNoFollowGuarded(
                            guardedPath(realTarget),
                            guardedPath(zeroReadCopy)
                        ),
                    { code: "EIO" }
                );
                assert.equal(await readFile(zeroReadCopy, "utf8"), "keep me");
                const entries = await readdir(baseDir);
                assert.equal(
                    entries.some((entry) => entry.startsWith(".zero-read-copy.txt.")),
                    false
                );
            } finally {
                __testing.setReadChunkForTest();
            }
            const boundedReadCopy = path.join(baseDir, "bounded-read-copy.txt");
            const readLengths: number[] = [];
            __testing.setReadChunkForTest(
                async (file, buffer, offset, length, position) => {
                    readLengths.push(length);
                    return file.read(buffer, offset, length, position);
                }
            );
            try {
                await writeFile(realTarget, Buffer.alloc(64 * 1024 + 7, "x"));
                await copyNoFollowGuarded(
                    guardedPath(realTarget),
                    guardedPath(boundedReadCopy)
                );
                assert.deepEqual(readLengths, [64 * 1024, 7]);
            } finally {
                __testing.setReadChunkForTest();
            }
            const defaultReadCopy = path.join(baseDir, "default-read-copy.txt");
            await writeFile(realTarget, "real", "utf8");
            await copyNoFollowGuarded(
                guardedPath(realTarget),
                guardedPath(defaultReadCopy)
            );
            assert.equal(await readFile(defaultReadCopy, "utf8"), "real");
            await chmod(realTarget, 0o600);
            await chmod(defaultReadCopy, 0o644);
            await copyNoFollowGuarded(
                guardedPath(realTarget),
                guardedPath(defaultReadCopy)
            );
            const copiedStat = await stat(defaultReadCopy);
            assert.equal(copiedStat.mode & 0o777, 0o600);
            __testing.setStatSyncForTest();
            assert.equal(statGuarded(guardedPath(realTarget)).isFile(), true);
        } finally {
            __testing.setReadChunkForTest();
            __testing.setStatSyncForTest();
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("cleans up no-follow temp files when atomic rename fails", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-guarded-"));
        const target = guardedPath(path.join(baseDir, "target.txt"));
        const originalRename = fs.promises.rename;
        try {
            await writeFile(target, "before", "utf8");
            fs.promises.rename = (async () => {
                throw new Error("rename failed");
            }) as typeof fs.promises.rename;

            await assert.rejects(
                () => writeTextNoFollowGuarded(target, "after"),
                /rename failed/u
            );
            assert.equal(await readFile(target, "utf8"), "before");
            const entries = await readdir(baseDir);
            assert.deepEqual(entries, ["target.txt"]);
        } finally {
            fs.promises.rename = originalRename;
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("spawns validated executables with explicit arguments", async () => {
        const child = spawnGuarded(
            process.execPath,
            ["-e", "process.stdout.write('ok')"],
            {
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });

        const exitCode = await new Promise<number | null>((resolve) => {
            child.once("close", resolve);
        });

        assert.equal(exitCode, 0);
        assert.equal(output, "ok");
    });
});
