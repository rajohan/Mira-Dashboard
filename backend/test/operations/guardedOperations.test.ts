import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { copyGuarded, copyNoFollowGuarded } from "../../src/lib/guardedOps/copy.ts";
import { guardedPath, mkdirGuarded } from "../../src/lib/guardedOps/core.ts";
import {
    lstatGuarded,
    openReadNoFollowNonblockingGuarded,
    readdirGuarded,
    readdirGuardedAsync,
    readJson5Guarded,
    readTextGuarded,
    readTextNoFollowGuarded,
    readTextRangeNoFollowGuarded,
    readTextTailNoFollowGuarded,
    statGuarded,
    statGuardedAsync,
} from "../../src/lib/guardedOps/read.ts";
import {
    writeTextGuarded,
    writeTextNoFollowAnchoredGuarded,
    writeTextNoFollowExclusiveGuarded,
    writeTextNoFollowGuarded,
} from "../../src/lib/guardedOps/write.ts";
import { captureRejection } from "../support/rejections.ts";

const testState = { temporaryRoot: "" };

function makeFifo(filePath: string): void {
    const result = Bun.spawnSync(["mkfifo", filePath], {
        stderr: "pipe",
        stdout: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || "mkfifo failed");
    }
}

async function modeOf(filePath: string): Promise<number> {
    const stat = await fs.stat(filePath);
    return stat.mode & 0o777;
}

beforeEach(async () => {
    testState.temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "guarded-ops-test-")
    );
});

afterEach(async () => {
    if (
        path.isAbsolute(testState.temporaryRoot) &&
        testState.temporaryRoot.startsWith(path.join(os.tmpdir(), "guarded-ops-test-"))
    ) {
        await fs.rm(testState.temporaryRoot, { recursive: true, force: true });
    }
    testState.temporaryRoot = "";
});

describe("guarded writes", () => {
    it("rejects symlink destinations", async () => {
        const target = path.join(testState.temporaryRoot, "target.txt");
        const symlink = path.join(testState.temporaryRoot, "link.txt");
        await fs.writeFile(target, "old");
        await fs.symlink(target, symlink);

        expect(writeTextNoFollowGuarded(guardedPath(symlink), "new")).rejects.toThrow();
        expect(
            writeTextNoFollowAnchoredGuarded(
                guardedPath(testState.temporaryRoot),
                "link.txt",
                "new"
            )
        ).rejects.toThrow();
        expect(fs.readFile(target, "utf8")).resolves.toBe("old");
    });

    it("rejects symlink root directories for anchored writes", async () => {
        const realRoot = path.join(testState.temporaryRoot, "real-root");
        const rootLink = path.join(testState.temporaryRoot, "root-link");
        await fs.mkdir(realRoot);
        await fs.symlink(realRoot, rootLink);

        expect(
            writeTextNoFollowAnchoredGuarded(guardedPath(rootLink), "file.txt", "new")
        ).rejects.toMatchObject({ code: "ELOOP" });
    });

    it("rejects special-file destinations", () => {
        const directFifo = path.join(testState.temporaryRoot, "direct.fifo");
        const anchoredFifo = path.join(testState.temporaryRoot, "anchored.fifo");
        makeFifo(directFifo);
        makeFifo(anchoredFifo);

        expect(
            writeTextNoFollowGuarded(guardedPath(directFifo), "new")
        ).rejects.toThrow();
        expect(
            writeTextNoFollowAnchoredGuarded(
                guardedPath(testState.temporaryRoot),
                "anchored.fifo",
                "new"
            )
        ).rejects.toThrow();
    });

    it("preserves existing destination modes", async () => {
        const directFile = path.join(testState.temporaryRoot, "direct.txt");
        const anchoredFile = path.join(testState.temporaryRoot, "anchored.txt");
        await fs.writeFile(directFile, "old");
        await fs.writeFile(anchoredFile, "old");
        await fs.chmod(directFile, 0o640);
        await fs.chmod(anchoredFile, 0o600);

        await writeTextNoFollowGuarded(guardedPath(directFile), "new");
        await writeTextNoFollowAnchoredGuarded(
            guardedPath(testState.temporaryRoot),
            "anchored.txt",
            "new"
        );

        expect(fs.readFile(directFile, "utf8")).resolves.toBe("new");
        expect(fs.readFile(anchoredFile, "utf8")).resolves.toBe("new");
        expect(await modeOf(directFile)).toBe(0o640);
        expect(await modeOf(anchoredFile)).toBe(0o600);
    });

    it("covers guarded read, copy, and exclusive-create helpers on regular files", async () => {
        const nestedRoot = path.join(testState.temporaryRoot, "nested");
        mkdirGuarded(guardedPath(nestedRoot), { recursive: true });
        const source = path.join(nestedRoot, "source.txt");
        const copied = path.join(nestedRoot, "copied.txt");
        const copiedNoFollow = path.join(nestedRoot, "copied-no-follow.txt");
        const exclusive = path.join(nestedRoot, "exclusive.txt");
        const json5 = path.join(nestedRoot, "config.json5");

        await fs.writeFile(source, "hello guarded ops");
        await fs.chmod(source, 0o640);
        await fs.writeFile(json5, "{ answer: 42, label: 'mira' }\n");

        expect(readTextGuarded(guardedPath(source))).toBe("hello guarded ops");
        expect(readJson5Guarded(guardedPath(json5))).toEqual({
            answer: 42,
            label: "mira",
        });
        expect(
            readdirGuarded(guardedPath(nestedRoot), { withFileTypes: true }).map(
                (entry) => entry.name
            )
        ).toContain("source.txt");
        const asyncEntries = await readdirGuardedAsync(guardedPath(nestedRoot), {
            withFileTypes: true,
        });
        expect(asyncEntries.map((entry) => entry.name)).toContain("config.json5");
        expect(statGuarded(guardedPath(source)).isFile()).toBe(true);
        expect(lstatGuarded(guardedPath(source)).isFile()).toBe(true);
        expect(statGuardedAsync(guardedPath(source))).resolves.toMatchObject({
            size: "hello guarded ops".length,
        });
        expect(readTextNoFollowGuarded(guardedPath(source))).resolves.toBe(
            "hello guarded ops"
        );
        const tail = await readTextTailNoFollowGuarded(guardedPath(source), 7);
        expect(tail).toBe("ded ops");
        expect(await readTextRangeNoFollowGuarded(guardedPath(source), 6, 7)).toBe(
            "guarded"
        );
        expect(await readTextRangeNoFollowGuarded(guardedPath(source), 14, 99)).toBe(
            "ops"
        );
        expect(await readTextRangeNoFollowGuarded(guardedPath(source), 99, 7)).toBe("");
        const invalidStartError = await captureRejection(() =>
            readTextRangeNoFollowGuarded(guardedPath(source), -1, 7)
        );
        expect(invalidStartError).toBeInstanceOf(TypeError);
        expect(invalidStartError).toHaveProperty(
            "message",
            "startByte must be a non-negative safe integer"
        );

        const file = await openReadNoFollowNonblockingGuarded(guardedPath(source));
        try {
            expect(file.readFile("utf8")).resolves.toBe("hello guarded ops");
        } finally {
            await file.close();
        }

        copyGuarded(guardedPath(source), guardedPath(copied));
        expect(readTextGuarded(guardedPath(copied))).toBe("hello guarded ops");

        await copyNoFollowGuarded(guardedPath(source), guardedPath(copiedNoFollow));
        expect(fs.readFile(copiedNoFollow, "utf8")).resolves.toBe("hello guarded ops");
        expect(await modeOf(copiedNoFollow)).toBe(0o640);
        expect(
            copyNoFollowGuarded(guardedPath(source), guardedPath(source))
        ).rejects.toMatchObject({ code: "EINVAL" });

        await writeTextGuarded(guardedPath(copied), "rewritten");
        expect(fs.readFile(copied, "utf8")).resolves.toBe("rewritten");

        await writeTextNoFollowExclusiveGuarded(
            guardedPath(exclusive),
            "exclusive",
            0o600
        );
        expect(fs.readFile(exclusive, "utf8")).resolves.toBe("exclusive");
        expect(await modeOf(exclusive)).toBe(0o600);
        expect(
            writeTextNoFollowExclusiveGuarded(guardedPath(exclusive), "again")
        ).rejects.toMatchObject({ code: "EEXIST" });
    });
});
