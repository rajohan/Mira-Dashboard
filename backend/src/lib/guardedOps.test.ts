import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
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
        } finally {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("refuses symlink targets for no-follow writes", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-guarded-"));
        try {
            const realTarget = path.join(baseDir, "real.txt");
            const linkTarget = guardedPath(path.join(baseDir, "link.txt"));
            await writeFile(realTarget, "real", "utf8");
            await symlink(realTarget, linkTarget);

            const originalContent = await readFile(realTarget, "utf8");
            await assert.rejects(() => writeTextNoFollowGuarded(linkTarget, "blocked"));
            await assert.rejects(() =>
                copyNoFollowGuarded(guardedPath(realTarget), linkTarget)
            );
            await assert.rejects(() =>
                copyNoFollowGuarded(linkTarget, guardedPath(realTarget))
            );
            assert.equal(await readFile(realTarget, "utf8"), originalContent);
            const realStat = await stat(realTarget);
            assert.equal(realStat.isFile(), true);
        } finally {
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
