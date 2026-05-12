import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareSafeWriteTargetWithinRoot } from "./safePath.js";

describe("safe path helpers", () => {
    it("prepares first-write targets when the allowed root does not exist yet", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        try {
            const missingRoot = path.join(baseDir, "missing", "workspace");
            const target = path.join(missingRoot, "nested", "note.txt");

            const safeTarget = prepareSafeWriteTargetWithinRoot(target, missingRoot);

            assert.equal(safeTarget, target);
            await writeFile(safeTarget, "created", "utf8");
            assert.equal(await readFile(target, "utf8"), "created");
        } finally {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects write targets through symlinked missing ancestors", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });
            await mkdir(path.join(root, "safe"));
            await symlink(outsideDir, path.join(root, "safe", "escape"));

            const target = path.join(root, "safe", "escape", "note.txt");

            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);
        } finally {
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });
});
