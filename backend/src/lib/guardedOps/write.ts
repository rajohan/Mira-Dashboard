import * as Fs from "node:fs";
import Path from "node:path";

import {
    type GuardedPath,
    assertNoSymlinkAncestors,
    fsPromiseOps,
    guardedPath,
    guardedPathBuffer,
    mkdirGuarded,
    openAnchoredParentDirectory,
    validateRelativePath,
} from "./core.ts";

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
    const destinationPath = Path.join(root, relativePath);
    assertNoSymlinkAncestors(root, destinationPath);
    if (process.platform !== "linux") {
        validateRelativePath(relativePath);
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
    const anchoredDestinationPath = Buffer.from(
        Path.join(parentPath.toString(), basename)
    );
    const temporaryPath = Buffer.from(
        Path.join(parentPath.toString(), `.${basename}.${Bun.randomUUIDv7()}.tmp`)
    );
    let existingMode: number | undefined;
    let shouldApplyMode = options.mode !== undefined;

    try {
        let file: Fs.promises.FileHandle | undefined;
        try {
            file = await Fs.promises.open(
                anchoredDestinationPath,
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
        await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
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
            anchoredDestinationPath,
        ]);
        isTemporaryCreated = false;
        await handles.at(-1)?.sync();
    } finally {
        if (isTemporaryCreated) {
            try {
                await Reflect.apply(fsPromiseOps.rm, Fs.promises, [
                    temporaryPath,
                    { force: true },
                ]);
            } finally {
                await Promise.allSettled(
                    handles.toReversed().map((handle) => handle.close())
                );
            }
        } else {
            await Promise.allSettled(
                handles.toReversed().map((handle) => handle.close())
            );
        }
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
