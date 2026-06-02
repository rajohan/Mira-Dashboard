import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

    it("does not create a missing root for rejected write targets", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        try {
            const missingRoot = path.join(baseDir, "missing", "workspace");
            const outsideTarget = path.join(baseDir, "outside", "note.txt");

            assert.equal(
                prepareSafeWriteTargetWithinRoot(outsideTarget, missingRoot),
                null
            );
            await assert.rejects(stat(missingRoot), { code: "ENOENT" });
        } finally {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects unsafe races while creating a missing root", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const root = path.join(baseDir, "missing", "workspace");
        const target = path.join(root, "note.txt");
        const originalRealpathSync = fs.realpathSync;
        const originalStatSync = fs.statSync;
        const originalFstatSync = fs.fstatSync;
        const originalMkdirSync = fs.mkdirSync;

        try {
            fs.realpathSync = ((targetPath: fs.PathLike) => {
                const value = targetPath.toString();
                if (value === baseDir) {
                    return `${baseDir}-elsewhere`;
                }
                return originalRealpathSync(targetPath);
            }) as typeof fs.realpathSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.realpathSync = originalRealpathSync;
            fs.statSync = ((targetPath: fs.PathLike) => {
                if (targetPath.toString() === baseDir) {
                    return { isDirectory: () => false } as fs.Stats;
                }
                return originalStatSync(targetPath);
            }) as typeof fs.statSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.statSync = originalStatSync;
            fs.mkdirSync = ((
                targetPath: fs.PathLike,
                options?: fs.MakeDirectoryOptions
            ) => {
                if (targetPath.toString().endsWith(`${path.sep}missing`)) {
                    const error = new Error("mkdir failed") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalMkdirSync(targetPath, options);
            }) as typeof fs.mkdirSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.mkdirSync = originalMkdirSync;
            fs.fstatSync = ((fd: number) => {
                return {
                    ...originalFstatSync(fd),
                    dev: 0,
                    ino: 0,
                } as fs.Stats;
            }) as typeof fs.fstatSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.fstatSync = originalFstatSync;
            fs.statSync = ((targetPath: fs.PathLike) => {
                if (targetPath.toString() === baseDir) {
                    return {
                        ...originalStatSync(targetPath),
                        dev: 0,
                        ino: 0,
                    } as fs.Stats;
                }
                return originalStatSync(targetPath);
            }) as typeof fs.statSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.statSync = originalStatSync;
            let mkdirAttempted = false;
            fs.mkdirSync = ((
                targetPath: fs.PathLike,
                options?: fs.MakeDirectoryOptions
            ) => {
                mkdirAttempted = true;
                return originalMkdirSync(targetPath, options);
            }) as typeof fs.mkdirSync;
            fs.statSync = ((targetPath: fs.PathLike) => {
                if (mkdirAttempted && targetPath.toString() === baseDir) {
                    return {
                        ...originalStatSync(targetPath),
                        dev: 0,
                        ino: 0,
                    } as fs.Stats;
                }
                return originalStatSync(targetPath);
            }) as typeof fs.statSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.statSync = originalStatSync;
            fs.mkdirSync = originalMkdirSync;
            let resolvedMissing = false;
            fs.realpathSync = ((targetPath: fs.PathLike) => {
                const value = targetPath.toString();
                if (value.endsWith(`${path.sep}missing`) && !resolvedMissing) {
                    resolvedMissing = true;
                    return `${value}-elsewhere`;
                }
                return originalRealpathSync(targetPath);
            }) as typeof fs.realpathSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            await mkdir(root, { recursive: true });
            let rootRealpathCalls = 0;
            fs.realpathSync = ((targetPath: fs.PathLike) => {
                const value = targetPath.toString();
                if (value === root && ++rootRealpathCalls === 3) {
                    return `${baseDir}-outside`;
                }
                return originalRealpathSync(targetPath);
            }) as typeof fs.realpathSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            const existingTarget = path.join(root, "existing.txt");
            await writeFile(existingTarget, "existing", "utf8");
            let targetCanonicalized = false;
            fs.realpathSync = ((targetPath: fs.PathLike) => {
                const value = targetPath.toString();
                if (value === existingTarget) {
                    targetCanonicalized = true;
                }
                if (value === root && targetCanonicalized) {
                    return `${baseDir}-outside`;
                }
                return originalRealpathSync(targetPath);
            }) as typeof fs.realpathSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(existingTarget, root), null);
        } finally {
            fs.realpathSync = originalRealpathSync;
            fs.statSync = originalStatSync;
            fs.fstatSync = originalFstatSync;
            fs.mkdirSync = originalMkdirSync;
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

            const insideTarget = path.join(root, "inside-link.txt");
            await writeFile(path.join(root, "inside-real.txt"), "inside", "utf8");
            await symlink(path.join(root, "inside-real.txt"), insideTarget);
            assert.equal(prepareSafeWriteTargetWithinRoot(insideTarget, root), null);

            await rm(target, { force: true });
            await writeFile(target, "regular", "utf8");
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
            assert.equal(
                safePathWithinRoot("nested/note.txt", `${root}${path.sep}`),
                path.join(root, "nested", "note.txt")
            );
            assert.equal(safePathWithinRoot("", root), null);
            assert.equal(safePathWithinRoot("../outside.txt", root), null);
            assert.equal(safePathWithinRoot("bad\0name", root), null);
            assert.equal(safePathWithinRoot("nested/note.txt", "/\0bad-root"), null);
            assert.equal(safePathWithinRoot("tmp", "/"), null);
            assert.equal(
                prepareSafeWriteTargetWithinRoot("/tmp/mira-safe-root-check.txt", "/"),
                null
            );

            assert.equal(sanitizeFilename("../note.txt"), "note.txt");
            assert.throws(() => sanitizeFilename(""), /Invalid filename/u);
            assert.throws(() => sanitizeFilename(".."), /Invalid filename/u);
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
        const originalRealpathSync = fs.realpathSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });
            await writeFile(path.join(root, "file-parent"), "not a directory", "utf8");

            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("file-parent", "note.txt"))) {
                    const error = new Error("missing target") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "file-parent", "note.txt"),
                    root
                ),
                null
            );

            fs.realpathSync = originalRealpathSync;
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (path.basename(targetPath) === "raced-parent") {
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
            fs.realpathSync = originalRealpathSync;
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

    it("rejects write targets when the existing ancestor resolves outside root", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalRealpathSync = fs.realpathSync;
        let escapedParentResolved = false;
        let escapedParentCalls = 0;
        try {
            const root = path.join(baseDir, "workspace");
            const escapedParent = path.join(root, "escaped");
            await mkdir(escapedParent, { recursive: true });

            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (path.resolve(targetPath) === escapedParent) {
                    escapedParentCalls += 1;
                    if (escapedParentCalls === 1) {
                        return originalRealpathSync(target);
                    }
                    escapedParentResolved = true;
                    return outsideDir;
                }
                return originalRealpathSync(target);
            }) as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(escapedParent, "note.txt"),
                    root
                ),
                null
            );
            assert.equal(escapedParentResolved, true);
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("rejects write targets when the root resolves elsewhere after creation", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalRealpathSync = fs.realpathSync;
        try {
            const root = path.join(baseDir, "workspace");
            const target = path.join(root, "note.txt");

            fs.realpathSync = ((realpathTarget: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(realpathTarget)
                    ? realpathTarget.toString("utf8")
                    : String(realpathTarget);
                if (targetPath === root && fs.existsSync(root)) {
                    return outsideDir;
                }
                return originalRealpathSync(realpathTarget);
            }) as unknown as typeof fs.realpathSync;

            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);
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
                if (path.basename(targetPath) === "existing-parent") {
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
                if (path.basename(targetPath) === "blocked-parent") {
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
                if (path.basename(targetPath) === "linked-parent") {
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

    it("rejects missing children with path-based checks on non-Linux platforms", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            const target = path.join(baseDir, "root", "nested", "file.txt");
            assert.equal(prepareSafeWriteTargetWithinRoot(target, baseDir), null);
        } finally {
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("accepts existing non-Linux child directories during path-based creation", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        const originalMkdirSync = fs.mkdirSync;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            await mkdir(path.join(baseDir, "root", "nested"), { recursive: true });
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                originalMkdirSync(target, options);
                throw Object.assign(new Error("already exists"), { code: "EEXIST" });
            }) as typeof fs.mkdirSync;
            const target = path.join(baseDir, "root", "nested", "file.txt");
            assert.equal(prepareSafeWriteTargetWithinRoot(target, baseDir), target);
        } finally {
            fs.mkdirSync = originalMkdirSync;
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects non-Linux child creation when path checks mismatch", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        const originalRealpathSync = fs.realpathSync;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(`${path.sep}nested`)) {
                    return path.join(baseDir, "elsewhere");
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(baseDir, "root", "nested", "file.txt"),
                    baseDir
                ),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects non-Linux child creation when the parent changes before mkdir", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        const originalRealpathSync = fs.realpathSync;
        const originalMkdirSync = fs.mkdirSync;
        let shouldSwapRootParent = false;
        let nestedMkdirCalled = false;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (shouldSwapRootParent && targetPath === path.join(baseDir, "root")) {
                    return outsideDir;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (path.basename(targetPath) === "root") {
                    shouldSwapRootParent = true;
                }
                if (path.basename(targetPath) === "nested") {
                    nestedMkdirCalled = true;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(baseDir, "root", "nested", "file.txt"),
                    baseDir
                ),
                null
            );
            assert.equal(nestedMkdirCalled, false);
        } finally {
            fs.realpathSync = originalRealpathSync;
            fs.mkdirSync = originalMkdirSync;
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
            await rm(baseDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("rejects non-Linux child creation when the parent is not a directory", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const rootDir = path.join(baseDir, "root");
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        const originalStatSync = fs.statSync;
        let rootStatCalls = 0;
        try {
            await mkdir(rootDir);
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            fs.statSync = ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                const stat = originalStatSync(target, options);
                if (targetPath === rootDir && ++rootStatCalls === 2) {
                    return {
                        ...stat,
                        isDirectory: () => false,
                    };
                }
                return stat;
            }) as typeof fs.statSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(rootDir, "nested", "file.txt"),
                    baseDir
                ),
                null
            );
            assert.equal(rootStatCalls, 2);
        } finally {
            fs.statSync = originalStatSync;
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("refuses to create missing non-Linux child directories", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        const originalMkdirSync = fs.mkdirSync;
        let mkdirCalled = false;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            await mkdir(path.join(baseDir, "root"), { recursive: true });
            fs.mkdirSync = (() => {
                mkdirCalled = true;
                throw Object.assign(new Error("mkdir should not run"), {
                    code: "EACCES",
                });
            }) as typeof fs.mkdirSync;
            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(baseDir, "root", "nested", "file.txt"),
                    baseDir
                ),
                null
            );
            assert.equal(mkdirCalled, false);
        } finally {
            fs.mkdirSync = originalMkdirSync;
            if (originalPlatform) {
                Object.defineProperty(process, "platform", originalPlatform);
            }
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("covers exhausted ancestor walks and nested mkdir race failures", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const outsideDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-safe-path-outside-")
        );
        const originalRealpathSync = fs.realpathSync;
        const originalMkdirSync = fs.mkdirSync;
        const originalStatSync = fs.statSync;
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
                if (path.basename(targetPath) === "nested") {
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
            fs.realpathSync = originalRealpathSync;
            fs.statSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "stat-raced"))) {
                    return {
                        ...originalStatSync(root),
                        isDirectory: () => false,
                    };
                }
                return originalStatSync(target);
            }) as typeof fs.statSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "stat-raced", "note.txt"),
                    root
                ),
                null
            );

            fs.statSync = originalStatSync;
            fs.mkdirSync(path.join(root, "escaping-ancestor"));
            fs.realpathSync = ((target: fs.PathLike) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath.endsWith(path.join("workspace", "escaping-ancestor"))) {
                    return outsideDir;
                }
                if (targetPath.endsWith(path.join("workspace", "moved"))) {
                    return outsideDir;
                }
                return originalRealpathSync(target);
            }) as unknown as typeof fs.realpathSync;

            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "escaping-ancestor", "child", "note.txt"),
                    root
                ),
                null
            );

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
            fs.statSync = originalStatSync;
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

    it("returns null when final target and ancestor walks hit unexpected errors", async () => {
        const baseDir = await mkdtemp(path.join(os.tmpdir(), "mira-safe-path-"));
        const originalRealpathSync = fs.realpathSync;
        try {
            const root = path.join(baseDir, "workspace");
            await mkdir(root, { recursive: true });
            const target = path.join(root, "blocked.txt");

            fs.realpathSync = ((lookup: fs.PathLike) => {
                const lookupPath = Buffer.isBuffer(lookup)
                    ? lookup.toString("utf8")
                    : String(lookup);
                if (lookupPath === target) {
                    const error = new Error("target denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpathSync(lookup);
            }) as typeof fs.realpathSync;
            assert.equal(prepareSafeWriteTargetWithinRoot(target, root), null);

            fs.realpathSync = ((lookup: fs.PathLike) => {
                const lookupPath = Buffer.isBuffer(lookup)
                    ? lookup.toString("utf8")
                    : String(lookup);
                if (lookupPath === root) {
                    return originalRealpathSync(lookup);
                }
                const error = new Error(`missing ${lookupPath}`) as NodeJS.ErrnoException;
                error.code = "ENOENT";
                throw error;
            }) as typeof fs.realpathSync;
            assert.equal(
                prepareSafeWriteTargetWithinRoot(
                    path.join(root, "gone", "note.txt"),
                    root
                ),
                null
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(baseDir, { recursive: true, force: true });
        }
    });
});
