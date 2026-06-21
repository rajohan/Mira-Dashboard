import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    guardedPath,
    writeTextNoFollowAnchoredGuarded,
    writeTextNoFollowGuarded,
} from "../src/lib/guardedOps.ts";

const testState = { temporaryRoot: "" };

async function makeFifo(filePath: string): Promise<void> {
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
    await fs.rm(testState.temporaryRoot, { recursive: true, force: true });
});

describe("guarded writes", () => {
    it("rejects symlink destinations", async () => {
        const target = path.join(testState.temporaryRoot, "target.txt");
        const symlink = path.join(testState.temporaryRoot, "link.txt");
        await fs.writeFile(target, "old");
        await fs.symlink(target, symlink);

        await expect(
            writeTextNoFollowGuarded(guardedPath(symlink), "new")
        ).rejects.toThrow();
        await expect(
            writeTextNoFollowAnchoredGuarded(
                guardedPath(testState.temporaryRoot),
                "link.txt",
                "new"
            )
        ).rejects.toThrow();
        await expect(fs.readFile(target, "utf8")).resolves.toBe("old");
    });

    it("rejects special-file destinations", async () => {
        const directFifo = path.join(testState.temporaryRoot, "direct.fifo");
        const anchoredFifo = path.join(testState.temporaryRoot, "anchored.fifo");
        await makeFifo(directFifo);
        await makeFifo(anchoredFifo);

        await expect(
            writeTextNoFollowGuarded(guardedPath(directFifo), "new")
        ).rejects.toThrow();
        await expect(
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

        await expect(fs.readFile(directFile, "utf8")).resolves.toBe("new");
        await expect(fs.readFile(anchoredFile, "utf8")).resolves.toBe("new");
        expect(await modeOf(directFile)).toBe(0o640);
        expect(await modeOf(anchoredFile)).toBe(0o600);
    });
});
