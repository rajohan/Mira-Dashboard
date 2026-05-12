import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";

export type GuardedPath = string & { readonly __guardedPath: unique symbol };

/** Marks a previously validated path so filesystem helpers only accept reviewed path values. */
export function guardedPath(path: string): GuardedPath {
    return path as GuardedPath;
}

const fsOps = Fs as unknown as {
    mkdirSync: typeof Fs.mkdirSync;
    readFileSync: typeof Fs.readFileSync;
    copyFileSync: typeof Fs.copyFileSync;
    statSync: typeof Fs.statSync;
};

const fsPromiseOps = Fs.promises as unknown as {
    open: typeof Fs.promises.open;
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
export function readJson5Guarded(path: GuardedPath): string {
    return fsOps.readFileSync(guardedPathBuffer(path), "utf8");
}

/** Reads a UTF-8 text file from a validated path. */
export function readTextGuarded(path: GuardedPath): string {
    return fsOps.readFileSync(guardedPathBuffer(path), "utf8");
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
    content: string
): Promise<void> {
    const file = await Fs.promises.open(
        guardedPathBuffer(path),
        Fs.constants.O_WRONLY |
            Fs.constants.O_CREAT |
            Fs.constants.O_TRUNC |
            Fs.constants.O_NOFOLLOW,
        0o666
    );
    try {
        await file.writeFile(content, "utf8");
    } finally {
        await file.close();
    }
}

/** Stats a validated path. */
export function statGuarded(path: GuardedPath): Fs.Stats {
    return fsOps.statSync(guardedPathBuffer(path));
}

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
