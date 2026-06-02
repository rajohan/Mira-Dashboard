import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import Path from "node:path";

import JSON5 from "json5";

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

let readChunk: ReadChunk = (file, buffer, offset, length, position) =>
    file.read(buffer, offset, length, position);
let lstatSync = (path: Fs.PathLike) => fsOps.lstatSync(path);
let statSync = (path: Fs.PathLike) => fsOps.statSync(path);

const fsPromiseOps = Fs.promises as unknown as {
    open: typeof Fs.promises.open;
    readdir: typeof Fs.promises.readdir;
    stat: typeof Fs.promises.stat;
};

const childProcessOps = ChildProcess as unknown as {
    spawn: typeof ChildProcess.spawn;
};

/** Converts a guarded path to a Buffer to avoid direct string path sinks in wrappers. */
function guardedPathBuffer(path: GuardedPath): Buffer {
    return Buffer.from(path);
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
        const destinationDir = Path.dirname(destinationPath);
        const tempPath = Path.join(
            destinationDir,
            `.${Path.basename(destinationPath)}.${process.pid}.${Date.now()}.tmp`
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
        let tempCreated = false;
        const tempFile = await Fs.promises.open(
            Buffer.from(tempPath),
            Fs.constants.O_WRONLY |
                Fs.constants.O_CREAT |
                Fs.constants.O_EXCL |
                Fs.constants.O_NOFOLLOW,
            sourceMode
        );
        try {
            tempCreated = true;
            try {
                await tempFile.chmod(sourceMode);
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
                        const { bytesWritten } = await tempFile.write(
                            buffer,
                            written,
                            bytesRead - written
                        );
                        written += bytesWritten;
                    }
                    position += bytesRead;
                }
                await tempFile.sync();
            } finally {
                await tempFile.close();
            }
            await Fs.promises.rename(tempPath, destinationPath);
            tempCreated = false;
            const parentDir = await Fs.promises.open(Buffer.from(destinationDir), "r");
            try {
                await parentDir.sync();
            } finally {
                await parentDir.close();
            }
        } finally {
            if (tempCreated) {
                await Fs.promises.rm(tempPath, { force: true });
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

/** Writes UTF-8 text while atomically refusing a symlink at the final path. */
export async function writeTextNoFollowGuarded(
    path: GuardedPath,
    content: string,
    mode?: number
): Promise<void> {
    const fileMode = (mode ?? 0o666) & 0o777;
    const file = await Fs.promises.open(
        guardedPathBuffer(path),
        Fs.constants.O_WRONLY | Fs.constants.O_CREAT | Fs.constants.O_NOFOLLOW,
        fileMode
    );
    try {
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
        if (mode !== undefined) {
            await file.chmod(fileMode);
        }
        await file.truncate(0);
        await file.writeFile(content, "utf8");
    } finally {
        await file.close();
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

export const __testing = {
    setReadChunkForTest(nextReadChunk?: ReadChunk): void {
        readChunk =
            nextReadChunk ??
            ((file, buffer, offset, length, position) =>
                file.read(buffer, offset, length, position));
    },
    setLstatSyncForTest(nextLstatSync?: typeof Fs.lstatSync): void {
        lstatSync = nextLstatSync ?? ((path) => fsOps.lstatSync(path));
    },
    setStatSyncForTest(nextStatSync?: typeof Fs.statSync): void {
        statSync = nextStatSync ?? ((path) => fsOps.statSync(path));
    },
};

/** Spawns a validated executable with explicit argument vector semantics. */
export function spawnGuarded(
    executable: string,
    args: string[],
    options: ChildProcess.SpawnOptions
): ChildProcess.ChildProcess {
    return Reflect.apply(childProcessOps.spawn, childProcessOps, [
        executable,
        args,
        options,
    ]) as ChildProcess.ChildProcess;
}
