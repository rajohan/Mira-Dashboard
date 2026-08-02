import * as Fs from "node:fs";
import Path from "node:path";

export type GuardedPath = string & { readonly __guardedPath: unique symbol };

/**
 * Marks a previously validated path so filesystem helpers only accept reviewed path values.
 * @param path File or resource path.
 * @returns Guarded path result.
 */
export function guardedPath(path: string): GuardedPath {
    return path as GuardedPath;
}

export const fsOps = Fs as unknown as {
    mkdirSync: typeof Fs.mkdirSync;
    readdirSync: typeof Fs.readdirSync;
    readFileSync: typeof Fs.readFileSync;
    copyFileSync: typeof Fs.copyFileSync;
    lstatSync: typeof Fs.lstatSync;
    statSync: typeof Fs.statSync;
};
export const lstatSync = (path: Fs.PathLike) => fsOps.lstatSync(path);
export const statSync = (path: Fs.PathLike) => fsOps.statSync(path);

export const fsPromiseOps = Fs.promises as unknown as {
    mkdir: typeof Fs.promises.mkdir;
    open: typeof Fs.promises.open;
    readdir: typeof Fs.promises.readdir;
    rename: typeof Fs.promises.rename;
    rm: typeof Fs.promises.rm;
    stat: typeof Fs.promises.stat;
};

/**
 * Converts a guarded path to a Buffer to avoid direct string path sinks in wrappers.
 * @param path Guarded path to convert.
 * @returns Buffer containing the guarded path.
 */
export function guardedPathBuffer(path: GuardedPath): Buffer {
    return Buffer.from(path);
}

export function validateRelativePath(relativePath: string): string[] {
    if (!relativePath || Path.isAbsolute(relativePath) || relativePath.includes("\0")) {
        throw Object.assign(new Error("Invalid relative path"), { code: "EINVAL" });
    }
    const parts = relativePath.split(/[\\/]+/u).filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
        throw Object.assign(new Error("Invalid relative path"), { code: "EINVAL" });
    }
    return parts;
}

export function assertNoSymlinkAncestors(root: string, destinationPath: string): void {
    let currentPath = Path.resolve(root);
    const destinationDirectory = Path.dirname(destinationPath);
    const relativeDirectory = Path.relative(currentPath, destinationDirectory);
    if (relativeDirectory.startsWith("..") || Path.isAbsolute(relativeDirectory)) {
        throw Object.assign(new Error("Invalid relative path"), { code: "EINVAL" });
    }
    if (Fs.lstatSync(currentPath).isSymbolicLink()) {
        throw Object.assign(new Error("Symlinked parent is not allowed"), {
            code: "ELOOP",
        });
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
    ]);
}

export async function openAnchoredParentDirectory(
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
