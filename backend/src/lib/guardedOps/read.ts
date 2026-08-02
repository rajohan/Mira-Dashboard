import * as Fs from "node:fs";

import { JSON5 } from "bun";

import {
    type GuardedPath,
    fsOps,
    fsPromiseOps,
    guardedPathBuffer,
    lstatSync,
    statSync,
} from "./core.ts";

/**
 * Reads a JSON5 text file from a validated path.
 * @returns Read a JSON5 text file from a validated path.
 */
export function readJson5Guarded(path: GuardedPath): unknown {
    return JSON5.parse(fsOps.readFileSync(guardedPathBuffer(path), "utf8"));
}

/**
 * Lists directory entries from a validated path.
 * @returns Readdir guarded result.
 */
export function readdirGuarded(
    path: GuardedPath,
    options: { withFileTypes: true }
): Fs.Dirent[] {
    return fsOps.readdirSync(guardedPathBuffer(path), options);
}

/**
 * Reads a UTF-8 text file from a validated path.
 * @returns Read a UTF-8 text file from a validated path.
 */
export function readTextGuarded(path: GuardedPath): string {
    return fsOps.readFileSync(guardedPathBuffer(path), "utf8");
}

/**
 * Lists directory entries from a validated path without blocking the request thread.
 * @returns Promise resolving to the readdir guarded async result.
 */
export async function readdirGuardedAsync(
    path: GuardedPath,
    options: { withFileTypes: true }
): Promise<Fs.Dirent[]> {
    return Reflect.apply(fsPromiseOps.readdir, Fs.promises, [
        guardedPathBuffer(path),
        options,
    ]) as Promise<Fs.Dirent[]>;
}

/**
 * Stats a validated path without blocking the request thread.
 * @returns Promise resolving to the stat guarded async result.
 */
export async function statGuardedAsync(path: GuardedPath): Promise<Fs.Stats> {
    return Reflect.apply(fsPromiseOps.stat, Fs.promises, [
        guardedPathBuffer(path),
    ]) as Promise<Fs.Stats>;
}

/**
 * Reads UTF-8 text while atomically refusing a symlink at the final path.
 * @returns Read UTF-8 text while atomically refusing a symlink at the final path.
 */
export async function readTextNoFollowGuarded(path: GuardedPath): Promise<string> {
    const file = await openReadNoFollowGuarded(path);
    try {
        return await file.readFile("utf8");
    } finally {
        await file.close();
    }
}

async function readTextRangeFromOpenFile(
    file: Fs.promises.FileHandle,
    startByte: number,
    byteLength: number
): Promise<string> {
    if (byteLength === 0) {
        return "";
    }
    const buffer = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
        const { bytesRead } = await file.read(
            buffer,
            offset,
            byteLength - offset,
            startByte + offset
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
}

/**
 * Reads at most the final `maxBytes` bytes of a UTF-8 file while refusing a
 * final-component symlink.
 * @returns The final bytes decoded as UTF-8 text.
 */
export async function readTextTailNoFollowGuarded(
    path: GuardedPath,
    maxBytes: number
): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError("maxBytes must be a positive safe integer");
    }

    const file = await openReadNoFollowGuarded(path);
    try {
        const { size } = await file.stat();
        const byteLength = Math.min(size, maxBytes);
        const start = Math.max(0, size - byteLength);
        return await readTextRangeFromOpenFile(file, start, byteLength);
    } finally {
        await file.close();
    }
}

/**
 * Reads at most `maxBytes` bytes from a byte offset in a UTF-8 file while
 * refusing a final-component symlink.
 * @returns The selected bytes decoded as UTF-8 text.
 */
export async function readTextRangeNoFollowGuarded(
    path: GuardedPath,
    startByte: number,
    maxBytes: number
): Promise<string> {
    if (!Number.isSafeInteger(startByte) || startByte < 0) {
        throw new TypeError("startByte must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError("maxBytes must be a positive safe integer");
    }

    const file = await openReadNoFollowGuarded(path);
    try {
        const { size } = await file.stat();
        const byteLength = Math.min(Math.max(0, size - startByte), maxBytes);
        return await readTextRangeFromOpenFile(file, startByte, byteLength);
    } finally {
        await file.close();
    }
}

/**
 * Reads bytes from an already-open descriptor so validation and use stay on the same file object.
 * @param fd Fd value.
 * @param byteLength Byte length value.
 * @returns Read bytes from an already-open descriptor so validation and use stay on the same file object.
 */
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

/**
 * Opens a validated path for reading while refusing a final-component symlink.
 * @returns Promise resolving to the open read no follow guarded result.
 */
export async function openReadNoFollowGuarded(
    path: GuardedPath
): Promise<Fs.promises.FileHandle> {
    return Reflect.apply(fsPromiseOps.open, Fs.promises, [
        guardedPathBuffer(path),
        Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW,
    ]);
}

/**
 * Opens a validated path for reading without blocking on special files.
 * @returns Promise resolving to the open read no follow nonblocking guarded result.
 */
export async function openReadNoFollowNonblockingGuarded(
    path: GuardedPath
): Promise<Fs.promises.FileHandle> {
    return Reflect.apply(fsPromiseOps.open, Fs.promises, [
        guardedPathBuffer(path),
        Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK,
    ]);
}
/**
 * Stats a validated path.
 * @returns Stat guarded result.
 */
export function statGuarded(path: GuardedPath): Fs.Stats {
    return statSync(guardedPathBuffer(path));
}

/**
 * Stats a validated path without following the final component.
 * @returns Lstat guarded result.
 */
export function lstatGuarded(path: GuardedPath): Fs.Stats {
    return lstatSync(guardedPathBuffer(path));
}
