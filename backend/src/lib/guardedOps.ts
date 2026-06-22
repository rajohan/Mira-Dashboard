import * as Fs from "node:fs";
import Path from "node:path";

import { JSON5 } from "bun";

export type GuardedPath = string & { readonly __guardedPath: unique symbol };

/** Marks a previously validated path so filesystem helpers only accept reviewed path values. */
export function guardedPath(path: string): GuardedPath {
    return path as GuardedPath;
}

const fsOps = Fs as unknown as {
    mkdirSync: typeof Fs.mkdirSync;
    readdirSync: typeof Fs.readdirSync;
    readFileSync: typeof Fs.readFileSync;
    copyFileSync: typeof Fs.copyFileSync;
    lstatSync: typeof Fs.lstatSync;
    statSync: typeof Fs.statSync;
};

type ReadChunk = (
    file: Fs.promises.FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
) => Promise<{ bytesRead: number }>;

const readChunk: ReadChunk = (file, buffer, offset, length, position) =>
    file.read(buffer, offset, length, position);
const lstatSync = (path: Fs.PathLike) => fsOps.lstatSync(path);
const statSync = (path: Fs.PathLike) => fsOps.statSync(path);

const fsPromiseOps = Fs.promises as unknown as {
    mkdir: typeof Fs.promises.mkdir;
    open: typeof Fs.promises.open;
    readdir: typeof Fs.promises.readdir;
    rename: typeof Fs.promises.rename;
    rm: typeof Fs.promises.rm;
    stat: typeof Fs.promises.stat;
};

/** Converts a guarded path to a Buffer to avoid direct string path sinks in wrappers. */
function guardedPathBuffer(path: GuardedPath): Buffer {
    return Buffer.from(path);
}

function validateRelativePath(relativePath: string): string[] {
    if (!relativePath || Path.isAbsolute(relativePath) || relativePath.includes("\0")) {
        throw Object.assign(new Error("Invalid relative path"), { code: "EINVAL" });
    }
    const parts = relativePath.split(/[\\/]+/u).filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
        throw Object.assign(new Error("Invalid relative path"), { code: "EINVAL" });
    }
    return parts;
}

function assertNoSymlinkAncestors(root: string, destinationPath: string): void {
    let currentPath = Path.resolve(root);
    const destinationDirectory = Path.dirname(destinationPath);
    const relativeDirectory = Path.relative(currentPath, destinationDirectory);
    if (relativeDirectory.startsWith("..") || Path.isAbsolute(relativeDirectory)) {
        throw Object.assign(new Error("Invalid relative path"), { code: "EINVAL" });
    }
    for (const part of relativeDirectory.split(Path.sep)) {
        if (!part) continue;
        currentPath = Path.join(currentPath, part);
        try {
            if (Fs.lstatSync(currentPath).isSymbolicLink()) {
                throw Object.assign(new Error("Symlinked parent is not allowed"), {
                    code: "ELOOP",
                });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }
}

function procFdPath(fd: number, child?: string): Buffer {
    return Buffer.from(
        child === undefined
            ? Path.join("/proc/self/fd", String(fd))
            : Path.join("/proc/self/fd", String(fd), child)
    );
}

async function openDirectoryNoFollow(path: Buffer): Promise<Fs.promises.FileHandle> {
    return Reflect.apply(fsPromiseOps.open, Fs.promises, [
        path,
        Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW,
    ]) as Promise<Fs.promises.FileHandle>;
}

async function openAnchoredParentDirectory(
    root: GuardedPath,
    relativePath: string,
    options: { createParents?: boolean } = {}
): Promise<{ basename: string; handles: Fs.promises.FileHandle[]; parentPath: Buffer }> {
    const parts = validateRelativePath(relativePath);
    const basename = parts.at(-1) as string;
    const parentParts = parts.slice(0, -1);
    const handles: Fs.promises.FileHandle[] = [];
    let current = await openDirectoryNoFollow(guardedPathBuffer(root));
    handles.push(current);

    try {
        for (const part of parentParts) {
            const childPath = procFdPath(current.fd, part);
            if (options.createParents) {
                try {
                    await Reflect.apply(fsPromiseOps.mkdir, Fs.promises, [childPath]);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                        throw error;
                    }
                }
            }
            current = await openDirectoryNoFollow(childPath);
            handles.push(current);
        }
        return { basename, handles, parentPath: procFdPath(current.fd) };
    } catch (error) {
        await Promise.allSettled(handles.map((handle) => handle.close()));
        throw error;
    }
}

/** Creates a validated directory tree. */
export function mkdirGuarded(path: GuardedPath, options: { recursive: true }): void {
    fsOps.mkdirSync(guardedPathBuffer(path), options);
}

/** Reads a JSON5 text file from a validated path. */
export function readJson5Guarded(path: GuardedPath): unknown {
    return JSON5.parse(fsOps.readFileSync(guardedPathBuffer(path), "utf8"));
}

/** Lists directory entries from a validated path. */
export function readdirGuarded(
    path: GuardedPath,
    options: { withFileTypes: true }
): Fs.Dirent[] {
    return fsOps.readdirSync(guardedPathBuffer(path), options);
}

/** Reads a UTF-8 text file from a validated path. */
export function readTextGuarded(path: GuardedPath): string {
    return fsOps.readFileSync(guardedPathBuffer(path), "utf8");
}

/** Lists directory entries from a validated path without blocking the request thread. */
export async function readdirGuardedAsync(
    path: GuardedPath,
    options: { withFileTypes: true }
): Promise<Fs.Dirent[]> {
    return Reflect.apply(fsPromiseOps.readdir, Fs.promises, [
        guardedPathBuffer(path),
        options,
    ]) as Promise<Fs.Dirent[]>;
}

/** Stats a validated path without blocking the request thread. */
export async function statGuardedAsync(path: GuardedPath): Promise<Fs.Stats> {
    return Reflect.apply(fsPromiseOps.stat, Fs.promises, [
        guardedPathBuffer(path),
    ]) as Promise<Fs.Stats>;
}

/** Reads UTF-8 text while atomically refusing a symlink at the final path. */
export async function readTextNoFollowGuarded(path: GuardedPath): Promise<string> {
    const file = await openReadNoFollowGuarded(path);
    try {
        return await file.readFile("utf8");
    } finally {
        await file.close();
    }
}

/** Reads bytes from an already-open descriptor so validation and use stay on the same file object. */
export function readFromOpenFile(fd: number, byteLength: number): Buffer {
    const buffer = Buffer.alloc(byteLength);
    let offset = 0;

    while (offset < byteLength) {
        const bytesRead = Fs.readSync(fd, buffer, offset, byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    return offset === byteLength ? buffer : buffer.subarray(0, offset);
}

/** Copies a file between two validated paths. */
export function copyGuarded(source: GuardedPath, destination: GuardedPath): void {
    fsOps.copyFileSync(guardedPathBuffer(source), guardedPathBuffer(destination));
}

/** Copies bytes while atomically refusing final-component symlinks on both paths. */
export async function copyNoFollowGuarded(
    source: GuardedPath,
    destination: GuardedPath
): Promise<void> {
    const sourceFile = await openReadNoFollowGuarded(source);
    try {
        const sourceStat = await sourceFile.stat();
        if (!sourceStat.isFile()) {
            throw Object.assign(new Error("Source must be a regular file"), {
                code: "EINVAL",
            });
        }
        const sourceMode = sourceStat.mode & 0o777;
        const destinationPath = destination as string;
        const destinationDirectory = Path.dirname(destinationPath);
        const temporaryPath = Path.join(
            destinationDirectory,
            `.${Path.basename(destinationPath)}.${Bun.randomUUIDv7()}.tmp`
        );
        let destinationFile: Fs.promises.FileHandle | undefined;
        try {
            destinationFile = await Fs.promises.open(
                guardedPathBuffer(destination),
                Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
            );
            const destinationStat = await destinationFile.stat();
            if (!destinationStat.isFile()) {
                throw Object.assign(new Error("Destination must be a regular file"), {
                    code: "EINVAL",
                });
            }
            if (
                sourceStat.dev === destinationStat.dev &&
                sourceStat.ino === destinationStat.ino
            ) {
                throw Object.assign(new Error("Source and destination must differ"), {
                    code: "EINVAL",
                });
            }
            if (destinationStat.nlink > 1) {
                throw Object.assign(new Error("Destination must not be hard-linked"), {
                    code: "EMLINK",
                });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        } finally {
            await destinationFile?.close();
        }
        let isTemporaryCreated = false;
        const temporaryFile = await Fs.promises.open(
            Buffer.from(temporaryPath),
            Fs.constants.O_WRONLY |
                Fs.constants.O_CREAT |
                Fs.constants.O_EXCL |
                Fs.constants.O_NOFOLLOW,
            sourceMode
        );
        try {
            isTemporaryCreated = true;
            try {
                await temporaryFile.chmod(sourceMode);
                const buffer = Buffer.allocUnsafe(64 * 1024);
                let position = 0;
                while (true) {
                    const remaining = sourceStat.size - position;
                    if (remaining <= 0) {
                        break;
                    }
                    const { bytesRead } = await readChunk(
                        sourceFile,
                        buffer,
                        0,
                        Math.min(buffer.length, remaining),
                        position
                    );
                    if (bytesRead === 0) {
                        throw Object.assign(new Error("Source changed during copy"), {
                            code: "EIO",
                        });
                    }
                    let written = 0;
                    while (written < bytesRead) {
                        const { bytesWritten } = await temporaryFile.write(
                            buffer,
                            written,
                            bytesRead - written
                        );
                        written += bytesWritten;
                    }
                    position += bytesRead;
                }
                await temporaryFile.sync();
            } finally {
                await temporaryFile.close();
            }
            await Fs.promises.rename(temporaryPath, destinationPath);
            isTemporaryCreated = false;
            const parentDirectory = await Fs.promises.open(
                Buffer.from(destinationDirectory),
                "r"
            );
            try {
                await parentDirectory.sync();
            } finally {
                await parentDirectory.close();
            }
        } finally {
            if (isTemporaryCreated) {
                await Fs.promises.rm(temporaryPath, { force: true });
            }
        }
    } finally {
        await sourceFile.close();
    }
}

/** Opens a validated path for reading while refusing a final-component symlink. */
export async function openReadNoFollowGuarded(
    path: GuardedPath
): Promise<Fs.promises.FileHandle> {
    return Reflect.apply(fsPromiseOps.open, Fs.promises, [
        guardedPathBuffer(path),
        Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW,
    ]) as Promise<Fs.promises.FileHandle>;
}

/** Opens a validated path for reading without blocking on special files. */
export async function openReadNoFollowNonblockingGuarded(
    path: GuardedPath
): Promise<Fs.promises.FileHandle> {
    return Reflect.apply(fsPromiseOps.open, Fs.promises, [
        guardedPathBuffer(path),
        Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK,
    ]) as Promise<Fs.promises.FileHandle>;
}

/** Writes UTF-8 text to a validated path. */
export async function writeTextGuarded(
    path: GuardedPath,
    content: string
): Promise<void> {
    const file = await Fs.promises.open(guardedPathBuffer(path), "w");
    try {
        await file.writeFile(content, "utf8");
    } finally {
        await file.close();
    }
}

async function syncParentDirectory(filePath: string): Promise<void> {
    const parentDirectory = await Fs.promises.open(
        Buffer.from(Path.dirname(filePath)),
        "r"
    );
    try {
        await parentDirectory.sync();
    } finally {
        await parentDirectory.close();
    }
}

/** Writes UTF-8 text while atomically refusing a symlink at the final path. */
export async function writeTextNoFollowGuarded(
    path: GuardedPath,
    content: string,
    mode?: number
): Promise<void> {
    let fileMode = (mode ?? 0o666) & 0o777;
    let shouldApplyMode = mode !== undefined;
    const destinationPath = path as string;
    const destinationDirectory = Path.dirname(destinationPath);
    const temporaryPath = Path.join(
        destinationDirectory,
        `.${Path.basename(destinationPath)}.${Bun.randomUUIDv7()}.tmp`
    );
    let file: Fs.promises.FileHandle | undefined;
    try {
        file = await Fs.promises.open(
            guardedPathBuffer(path),
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const destinationStat = await file.stat();
        if (!destinationStat.isFile()) {
            throw Object.assign(new Error("Destination must be a regular file"), {
                code: "EINVAL",
            });
        }
        if (destinationStat.nlink > 1) {
            throw Object.assign(new Error("Destination must not be hard-linked"), {
                code: "EMLINK",
            });
        }
        if (mode === undefined) {
            fileMode = destinationStat.mode & 0o777;
            shouldApplyMode = true;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    } finally {
        await file?.close();
    }

    let isTemporaryCreated = false;
    const temporaryFile = await Fs.promises.open(
        Buffer.from(temporaryPath),
        Fs.constants.O_WRONLY |
            Fs.constants.O_CREAT |
            Fs.constants.O_EXCL |
            Fs.constants.O_NOFOLLOW,
        fileMode
    );
    try {
        isTemporaryCreated = true;
        try {
            if (shouldApplyMode) {
                await temporaryFile.chmod(fileMode);
            }
            await temporaryFile.writeFile(content, "utf8");
            await temporaryFile.sync();
        } finally {
            await temporaryFile.close();
        }
        await Fs.promises.rename(Buffer.from(temporaryPath), guardedPathBuffer(path));
        isTemporaryCreated = false;
        await syncParentDirectory(destinationPath);
    } finally {
        if (isTemporaryCreated) {
            await Fs.promises.rm(temporaryPath, { force: true });
        }
    }
}

/** Writes UTF-8 text through a pinned parent directory descriptor. */
export async function writeTextNoFollowAnchoredGuarded(
    root: GuardedPath,
    relativePath: string,
    content: string,
    options: { createParents?: boolean; mode?: number } = {}
): Promise<void> {
    if (options.createParents) {
        mkdirGuarded(root, { recursive: true });
    }
    if (process.platform !== "linux") {
        validateRelativePath(relativePath);
        const destinationPath = Path.join(root as string, relativePath);
        assertNoSymlinkAncestors(root as string, destinationPath);
        if (options.createParents) {
            const destinationDirectory = Path.dirname(destinationPath);
            mkdirGuarded(guardedPath(destinationDirectory), { recursive: true });
        }
        await writeTextNoFollowGuarded(
            guardedPath(destinationPath),
            content,
            options.mode
        );
        return;
    }

    const { basename, handles, parentPath } = await openAnchoredParentDirectory(
        root,
        relativePath,
        { createParents: options.createParents }
    );
    const destinationPath = Buffer.from(Path.join(parentPath.toString(), basename));
    const temporaryPath = Buffer.from(
        Path.join(parentPath.toString(), `.${basename}.${Bun.randomUUIDv7()}.tmp`)
    );
    let existingMode: number | undefined;
    let shouldApplyMode = options.mode !== undefined;

    try {
        let file: Fs.promises.FileHandle | undefined;
        try {
            file = await Fs.promises.open(
                destinationPath,
                Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
            );
            const existingStat = await file.stat();
            if (!existingStat.isFile()) {
                throw Object.assign(new Error("Destination must be a regular file"), {
                    code: "EINVAL",
                });
            }
            if (existingStat.nlink > 1) {
                throw Object.assign(new Error("Hard-linked files are not supported"), {
                    code: "EMLINK",
                });
            }
            if (options.mode === undefined) {
                existingMode = existingStat.mode;
                shouldApplyMode = true;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        } finally {
            await file?.close();
        }
    } catch (error) {
        await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
        throw error;
    }

    const fileMode = (options.mode ?? existingMode ?? 0o666) & 0o777;
    let isTemporaryCreated = false;
    try {
        const file = await Fs.promises.open(
            temporaryPath,
            Fs.constants.O_WRONLY |
                Fs.constants.O_CREAT |
                Fs.constants.O_EXCL |
                Fs.constants.O_NOFOLLOW,
            fileMode
        );
        isTemporaryCreated = true;
        try {
            if (shouldApplyMode) {
                await file.chmod(fileMode);
            }
            await file.writeFile(content, "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
        await Reflect.apply(fsPromiseOps.rename, Fs.promises, [
            temporaryPath,
            destinationPath,
        ]);
        isTemporaryCreated = false;
        await handles.at(-1)?.sync();
    } finally {
        if (isTemporaryCreated) {
            await Reflect.apply(fsPromiseOps.rm, Fs.promises, [
                temporaryPath,
                { force: true },
            ]);
        }
        await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    }
}

/** Writes UTF-8 text while refusing symlinks and existing final paths. */
export async function writeTextNoFollowExclusiveGuarded(
    path: GuardedPath,
    content: string,
    mode?: number
): Promise<void> {
    const fileMode = (mode ?? 0o666) & 0o777;
    const file = await Fs.promises.open(
        guardedPathBuffer(path),
        Fs.constants.O_WRONLY |
            Fs.constants.O_CREAT |
            Fs.constants.O_EXCL |
            Fs.constants.O_NOFOLLOW,
        fileMode
    );
    try {
        if (mode !== undefined) {
            await file.chmod(fileMode);
        }
        await file.writeFile(content, "utf8");
    } finally {
        await file.close();
    }
}

/** Stats a validated path. */
export function statGuarded(path: GuardedPath): Fs.Stats {
    return statSync(guardedPathBuffer(path));
}

/** Stats a validated path without following the final component. */
export function lstatGuarded(path: GuardedPath): Fs.Stats {
    return lstatSync(guardedPathBuffer(path));
}
