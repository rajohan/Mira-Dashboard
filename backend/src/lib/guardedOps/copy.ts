import * as Fs from "node:fs";
import Path from "node:path";

import { type GuardedPath, fsOps, guardedPathBuffer } from "./core.ts";
import { openReadNoFollowGuarded } from "./read.ts";

type ReadChunk = (
    file: Fs.promises.FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
) => Promise<{ bytesRead: number }>;

const readChunk: ReadChunk = (file, buffer, offset, length, position) =>
    file.read(buffer, offset, length, position);

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
