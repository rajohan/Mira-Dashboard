import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
    prepareSafeWriteTargetWithinRoot,
    safePathWithinRoot,
    sanitizeFilename,
} from "./safePath.js";

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

    it("rejects existing symlink write targets", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalLstatSync = fs.lstatSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });
            const target = path.join(root, "note.txt");
            await writeFile(path.join(outsideDir, "note.txt"), "outside", "utf8");
            await symlink(path.join(outsideDir, "note.txt"), target);

            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.lstatSync = ((lstatTarget: fs.PathLike) => {
                if (String(lstatTarget) === target) {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalLstatSync(lstatTarget);
            }) as typeof fs.lstatSync;

            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);
        } finally {
            fs.lstatSync = originalLstatSync;
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("validates read paths and rejects invalid filenames", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(path.join(root, "nested"), { recursive: true });
            await writeFile(path.join(root, "nested", "note.txt"), "ok", "utf8");

            assert.equal(
                safePathWithinRoot("nested/note.txt", root),
                path.join(root, "nested", "note.txt")
            );
            assert.equal(safePathWithinRoot("", root), null);
            assert.equal(safePathWithinRoot("../outside.txt", root), null);
            assert.equal(safePathWithinRoot("bad\0name", root), null);
            assert.equal(safePathWithinRoot("nested/note.txt", "/\0bad-root"), null);

            assert.equal(sanitizeFilename("../note.txt"), "note.txt");
            assert.throws(() => sanitizeFilename(""), /Invalid filename/u);
            assert.throws(() => sanitizeFilename("..\0"), /Invalid filename/u);
        } finally {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects invalid write targets", () => {
        assert.equal(prepareSafeWriteTargetWithinRoot("", "/tmp"), null);
        assert.equal(prepareSafeWriteTargetWithinRoot("bad\0name", "/tmp"), null);
        assert.equal(prepareSafeWriteTargetWithinRoot("/etc/passwd", "/tmp"), null);
    });

    it("rejects write targets when existing or raced parents are not directories", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalMkdirSync = fs.mkdirSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });
            await writeFile(path.join(root, "file-parent"), "not a directory", "utf8");

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "file-parent", "note.txt"),
                    root
                ),
                null
            );

            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "raced-parent"))) {
                    fs.writeFileSync(targetPath, "not a directory");
                    return;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "raced-parent", "note.txt"),
                    root
                ),
                null
            );
        } finally {
            fs.mkdirSync = originalMkdirSync;
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects write targets when filesystem races move parents outside root", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalRealpathSync = fs.realpathSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });

            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "raced-parent"))) {
                    return outsideDir;
                }
                return originalRealpathSync(target);
            }) as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "raced-parent", "note.txt"),
                    root
                ),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("returns null for unexpected filesystem errors while preparing writes", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalRealpathSync = fs.realpathSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });
            const targetParent = path.join(root, "blocked");

            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath === targetParent) {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(targetParent, "note.txt"),
                    root
                ),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("handles root canonicalization and mkdir race edge cases", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalRealpathSync = fs.realpathSync;
        const originalMkdirSync = fs.mkdirSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });

            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (
                    targetPath.startsWith(baseDir) ||
                    targetPath === "/tmp" ||
                    targetPath === "/"
                ) {
                    const error = new Error("root missing") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            assert.equal(safePathWithinRoot("note.txt", root), null);

            fs.realpathSync = originalRealpathSync;
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "existing-parent"))) {
                    originalMkdirSync(target, options);
                    const error = new Error("already exists") as NodeJS.ErrnoException;
                    error.code = "EEXIST";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "existing-parent", "note.txt"),
                    root
                ),
                path.join(root, "existing-parent", "note.txt")
            );

            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "blocked-parent"))) {
                    const error = new Error("blocked") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "blocked-parent", "note.txt"),
                    root
                ),
                null
            );

            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "linked-parent"))) {
                    fs.symlinkSync(outsideDir, targetPath);
                    const error = new Error("already exists") as NodeJS.ErrnoException;
                    error.code = "EEXIST";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "linked-parent", "note.txt"),
                    root
                ),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            fs.mkdirSync = originalMkdirSync;
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("covers exhausted ancestor walks and nested mkdir race failures", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalRealpathSync = fs.realpathSync;
        const originalMkdirSync = fs.mkdirSync;
        try {
            fs.realpathSync = (() => {
                const error = new Error("missing") as NodeJS.ErrnoException;
                error.code = "ENOENT";
                throw error;
            }) as unknown as typeof fs.realpathSync;
            assert.equal(safePathWithinRoot("note.txt", "/"), null);
            assert.equal(
                prepareSafeWriteTargetWithinRoot("/missing/note.txt", "/"),
                null
            );

            fs.realpathSync = originalRealpathSync;
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });

            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "nested"))) {
                    const error = new Error("denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "nested", "note.txt"),
                    root
                ),
                null
            );

            fs.mkdirSync = originalMkdirSync;
            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "moved"))) {
                    return outsideDir;
                }
                return originalRealpathSync(target);
            }) as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "moved", "note.txt"),
                    root
                ),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            fs.mkdirSync = originalMkdirSync;
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("returns null when every ancestor disappears during write validation", () => {
        const originalRealpathSync = fs.realpathSync;
        try {
            const missingRealpath = (target: fs.PathLike) => {
                const error = new Error(
                    `missing ${String(target)}`
                ) as NodeJS.ErrnoException;
                error.code = "ENOENT";
                throw error;
            };
            fs.realpathSync = missingRealpath as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot("/fully/missing/note.txt", "/"),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
        }
    });

    it("returns null when the write ancestor walk reaches filesystem root", () => {
        const originalRealpathSync = fs.realpathSync;
        let rootLookups = 0;
        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath === "/tmp" && rootLookups < 2) {
                    rootLookups += 1;
                    return originalRealpathSync(target);
                }

                const error = new Error(`missing ${targetPath}`) as NodeJS.ErrnoException;
                error.code = "ENOENT";
                throw error;
            }) as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot("/tmp/vanished/note.txt", "/tmp"),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
        }
    });
});
