import * as Fs from "node:fs";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceFileRootConfiguration } from "../../domains/files/ports.ts";
import { assertReviewedOpenClawFileRoot } from "../files/openClawFileRootConfiguration.ts";
import { chatAttachmentBytesMatchMimeType } from "./inMemoryChatAttachmentStore.ts";

export const openClawLocalHistoryMediaMaximumBytes = 16 * 1024 * 1024;

const maximumLocatorBytes = 16 * 1024;
const maximumLocatorSegments = 256;
const maximumSegmentBytes = 255;
const contentSniffBytes = 8 * 1024;
const textMimeTypesByExtension: ReadonlyMap<string, string> = new Map([
    [".csv", "text/csv"],
    [".json", "application/json"],
    [".md", "text/markdown"],
    [".txt", "text/plain"],
]);
const sniffedPassiveMediaMimeTypes = Object.freeze([
    "audio/aac",
    "audio/flac",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
] as const);

interface OpenRoot {
    readonly device: bigint;
    readonly fd: number;
    readonly inode: bigint;
    readonly ownerId: bigint;
}

interface OpenFile {
    readonly close: () => Promise<void>;
    readonly handle: Fs.promises.FileHandle;
    readonly stat: Fs.BigIntStats;
}

type RequestedByteRange =
    | Readonly<{ end?: number; kind: "from"; start: number }>
    | Readonly<{ kind: "suffix"; length: number }>;

interface SelectedByteRange {
    readonly endExclusive: number;
    readonly start: number;
}

export interface OpenClawLocalHistoryMediaFetchRequest {
    readonly method: "GET" | "HEAD";
    readonly range?: string;
    readonly segments: readonly string[];
    readonly signal: AbortSignal;
}

export interface OpenClawLocalHistoryMediaFetcher {
    readonly dispose: () => void;
    readonly fetch: (request: OpenClawLocalHistoryMediaFetchRequest) => Promise<Response>;
    readonly normalizeLocator: (candidate: string) => readonly string[] | undefined;
}

export interface DescriptorOpenClawLocalHistoryMediaFetcherOptions {
    readonly openClawRoot: WorkspaceFileRootConfiguration;
}

function invalidConfiguration(): TypeError {
    return new TypeError("OpenClaw local media root is invalid");
}

function runtimeOwnerId(): bigint {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw invalidConfiguration();
    }
    return BigInt(process.getuid());
}

function abortIfRequested(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function isSafeRootNode(root: OpenRoot, stat: Fs.BigIntStats): boolean {
    return (
        stat.isDirectory() &&
        stat.dev === root.device &&
        stat.ino === root.inode &&
        stat.uid === root.ownerId &&
        (stat.mode & 0o777n) === 0o700n
    );
}

function isSafeDescendant(
    root: OpenRoot,
    stat: Fs.BigIntStats,
    kind: "directory" | "file"
): boolean {
    return (
        stat.dev === root.device &&
        stat.uid === root.ownerId &&
        // The canonical OpenClaw root is 0700. Its generated descendants may
        // retain OpenClaw's 0775/0664 modes, but must never be world-writable.
        (stat.mode & 0o002n) === 0n &&
        (kind === "directory" ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    );
}

function isStableFileStat(
    root: OpenRoot,
    before: Fs.BigIntStats,
    after: Fs.BigIntStats
): boolean {
    return (
        isSafeDescendant(root, after, "file") &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mode === after.mode &&
        before.nlink === after.nlink &&
        before.uid === after.uid &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
    );
}

function isValidSegment(segment: string): boolean {
    return (
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("/") &&
        !segment.includes("\\") &&
        !/[\p{Cc}\p{Cf}]/u.test(segment) &&
        Buffer.byteLength(segment, "utf8") <= maximumSegmentBytes
    );
}

function frozenSegments(value: string): readonly string[] | undefined {
    if (
        value.length === 0 ||
        Buffer.byteLength(value, "utf8") > maximumLocatorBytes ||
        value.includes("\\") ||
        /[\p{Cc}\p{Cf}]/u.test(value)
    ) {
        return undefined;
    }
    const segments = value.split("/");
    return segments.length > 0 &&
        segments.length <= maximumLocatorSegments &&
        segments.every((segment) => isValidSegment(segment))
        ? Object.freeze(segments)
        : undefined;
}

function localFilePath(candidate: string): string | undefined {
    if (!/^file:/iu.test(candidate)) return candidate;
    try {
        const url = new URL(candidate);
        if (
            url.protocol !== "file:" ||
            url.username !== "" ||
            url.password !== "" ||
            (url.hostname !== "" && url.hostname !== "localhost") ||
            url.search !== "" ||
            url.hash !== ""
        ) {
            return undefined;
        }
        return fileURLToPath(url);
    } catch {
        return undefined;
    }
}

function normalizeLocator(
    candidate: string,
    mediaRootPath: string
): readonly string[] | undefined {
    if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.startsWith("//") ||
        candidate.startsWith(String.raw`\\`) ||
        Buffer.byteLength(candidate, "utf8") > maximumLocatorBytes ||
        /[\p{Cc}\p{Cf}]/u.test(candidate)
    ) {
        return undefined;
    }
    const pathCandidate = localFilePath(candidate);
    if (pathCandidate === undefined) return undefined;
    if (!/^file:/iu.test(candidate) && /^[a-z][a-z0-9+.-]*:/iu.test(pathCandidate)) {
        return undefined;
    }
    if (!Path.isAbsolute(pathCandidate)) return frozenSegments(pathCandidate);
    if (
        pathCandidate
            .split(Path.sep)
            .some((segment) => segment === "." || segment === "..")
    ) {
        return undefined;
    }
    const relative = Path.relative(mediaRootPath, pathCandidate);
    if (
        relative === "" ||
        Path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${Path.sep}`)
    ) {
        return undefined;
    }
    return frozenSegments(relative.split(Path.sep).join("/"));
}

function anchoredChildPath(fd: number, segment: string): string {
    return `/proc/self/fd/${fd}/${segment}`;
}

async function openLocalFile(
    root: OpenRoot,
    segments: readonly string[],
    signal: AbortSignal
): Promise<OpenFile> {
    abortIfRequested(signal);
    if (!isSafeRootNode(root, Fs.fstatSync(root.fd, { bigint: true }))) {
        throw new Error("Local media is unavailable");
    }
    const handles: Fs.promises.FileHandle[] = [];
    try {
        const media = await Fs.promises.open(
            anchoredChildPath(root.fd, "media"),
            Fs.constants.O_RDONLY |
                Fs.constants.O_DIRECTORY |
                Fs.constants.O_NOFOLLOW |
                Fs.constants.O_NONBLOCK
        );
        handles.push(media);
        const mediaStat = await media.stat({ bigint: true });
        if (!isSafeDescendant(root, mediaStat, "directory")) {
            throw new Error("Local media is unavailable");
        }
        let parentFd = media.fd;
        let finalStat: Fs.BigIntStats | undefined;
        for (const [index, segment] of segments.entries()) {
            abortIfRequested(signal);
            const final = index === segments.length - 1;
            const handle = await Fs.promises.open(
                anchoredChildPath(parentFd, segment),
                Fs.constants.O_RDONLY |
                    Fs.constants.O_NOFOLLOW |
                    Fs.constants.O_NONBLOCK |
                    (final ? 0 : Fs.constants.O_DIRECTORY)
            );
            handles.push(handle);
            parentFd = handle.fd;
            const stat = await handle.stat({ bigint: true });
            if (!isSafeDescendant(root, stat, final ? "file" : "directory")) {
                throw new Error("Local media is unavailable");
            }
            if (final) finalStat = stat;
        }
        const final = handles.at(-1);
        if (final === undefined || finalStat === undefined) {
            throw new Error("Local media is unavailable");
        }
        return {
            close: async () => {
                await Promise.allSettled(
                    handles.toReversed().map((handle) => handle.close())
                );
            },
            handle: final,
            stat: finalStat,
        };
    } catch (error) {
        await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
        throw error;
    }
}

function numberSize(stat: Fs.BigIntStats): number | undefined {
    const size = Number(stat.size);
    return Number.isSafeInteger(size) &&
        size >= 0 &&
        size <= openClawLocalHistoryMediaMaximumBytes
        ? size
        : undefined;
}

async function readExact(
    handle: Fs.promises.FileHandle,
    start: number,
    length: number,
    signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
        abortIfRequested(signal);
        const { bytesRead } = await handle.read(
            bytes,
            offset,
            length - offset,
            start + offset
        );
        abortIfRequested(signal);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset !== length) throw new Error("Local media is unavailable");
    return bytes;
}

function readPrefix(
    handle: Fs.promises.FileHandle,
    sizeBytes: number,
    signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
    return readExact(handle, 0, Math.min(sizeBytes, contentSniffBytes), signal);
}

function isUtf8TextPrefix(bytes: Uint8Array): boolean {
    if (bytes.includes(0)) return false;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
        return true;
    } catch {
        return false;
    }
}

function mediaMimeType(name: string, bytes: Uint8Array): string {
    for (const mimeType of sniffedPassiveMediaMimeTypes) {
        if (chatAttachmentBytesMatchMimeType(bytes, mimeType)) return mimeType;
    }
    const textMimeType = textMimeTypesByExtension.get(Path.extname(name).toLowerCase());
    return textMimeType !== undefined && isUtf8TextPrefix(bytes)
        ? textMimeType
        : "application/octet-stream";
}

function requestedByteRange(value: string | undefined): RequestedByteRange | undefined {
    if (value === undefined) return undefined;
    if (value.length > 128) return undefined;
    const from = /^bytes=([0-9]+)-([0-9]*)$/u.exec(value);
    if (from !== null) {
        const start = Number(from[1]);
        const end = from[2] === "" ? undefined : Number(from[2]);
        if (
            Number.isSafeInteger(start) &&
            (end === undefined || (Number.isSafeInteger(end) && end >= start))
        ) {
            return { ...(end === undefined ? {} : { end }), kind: "from", start };
        }
        return undefined;
    }
    const suffix = /^bytes=-([0-9]+)$/u.exec(value);
    if (suffix === null) return undefined;
    const length = Number(suffix[1]);
    return Number.isSafeInteger(length) && length > 0
        ? { kind: "suffix", length }
        : undefined;
}

function selectedByteRange(
    request: RequestedByteRange,
    sizeBytes: number
): SelectedByteRange | undefined {
    if (sizeBytes === 0) return undefined;
    if (request.kind === "suffix") {
        return {
            endExclusive: sizeBytes,
            start: Math.max(0, sizeBytes - request.length),
        };
    }
    if (request.start >= sizeBytes) return undefined;
    return {
        endExclusive: Math.min(sizeBytes, (request.end ?? sizeBytes - 1) + 1),
        start: request.start,
    };
}

function responseHeaders(
    mimeType: string,
    sizeBytes: number,
    selected?: SelectedByteRange
): Headers {
    const headers = new Headers({
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-length": String(
            selected === undefined ? sizeBytes : selected.endExclusive - selected.start
        ),
        "content-type": mimeType,
    });
    if (selected !== undefined) {
        headers.set(
            "content-range",
            `bytes ${selected.start}-${selected.endExclusive - 1}/${sizeBytes}`
        );
    }
    if (mimeType === "application/octet-stream") {
        headers.set("content-disposition", "attachment");
    }
    return headers;
}

function notFoundResponse(): Response {
    return new Response(null, {
        headers: { "cache-control": "no-store" },
        status: 404,
    });
}

function rangeNotSatisfiableResponse(sizeBytes: number): Response {
    return new Response(null, {
        headers: {
            "accept-ranges": "bytes",
            "cache-control": "no-store",
            "content-range": `bytes */${sizeBytes}`,
        },
        status: 416,
    });
}

/**
 * Creates a descriptor-rooted reader for transcript-associated files beneath the
 * explicit reviewed OpenClaw root's fixed `media` directory.
 * @param options Exact reviewed OpenClaw root configuration.
 * @returns Local-history media locator and fetch port.
 */
export function createDescriptorOpenClawLocalHistoryMediaFetcher(
    options: DescriptorOpenClawLocalHistoryMediaFetcherOptions
): OpenClawLocalHistoryMediaFetcher {
    let rootFd: number | undefined;
    try {
        assertReviewedOpenClawFileRoot(options.openClawRoot);
        const ownerId = runtimeOwnerId();
        rootFd = Fs.openSync(
            options.openClawRoot.path,
            Fs.constants.O_RDONLY |
                Fs.constants.O_DIRECTORY |
                Fs.constants.O_NOFOLLOW |
                Fs.constants.O_NONBLOCK
        );
        const stat = Fs.fstatSync(rootFd, { bigint: true });
        const root = {
            device: stat.dev,
            fd: rootFd,
            inode: stat.ino,
            ownerId,
        } satisfies OpenRoot;
        if (!isSafeRootNode(root, stat)) throw invalidConfiguration();
        const mediaRootPath = Path.join(options.openClawRoot.path, "media");
        let disposed = false;
        return Object.freeze<OpenClawLocalHistoryMediaFetcher>({
            dispose() {
                if (disposed) return;
                disposed = true;
                Fs.closeSync(root.fd);
            },
            async fetch(request) {
                if (disposed) return notFoundResponse();
                const segments = Object.freeze([...request.segments]);
                if (
                    (request.method !== "GET" && request.method !== "HEAD") ||
                    segments.length === 0 ||
                    segments.length > maximumLocatorSegments ||
                    Buffer.byteLength(segments.join("/"), "utf8") > maximumLocatorBytes ||
                    !segments.every((segment) => isValidSegment(segment))
                ) {
                    return notFoundResponse();
                }
                const parsedRange = requestedByteRange(request.range);
                try {
                    abortIfRequested(request.signal);
                    const opened = await openLocalFile(root, segments, request.signal);
                    try {
                        const sizeBytes = numberSize(opened.stat);
                        if (sizeBytes === undefined) return notFoundResponse();
                        const prefix = await readPrefix(
                            opened.handle,
                            sizeBytes,
                            request.signal
                        );
                        const mimeType = mediaMimeType(segments.at(-1)!, prefix);
                        const selected =
                            parsedRange === undefined
                                ? undefined
                                : selectedByteRange(parsedRange, sizeBytes);
                        if (parsedRange !== undefined && selected === undefined) {
                            return rangeNotSatisfiableResponse(sizeBytes);
                        }
                        const body =
                            request.method === "HEAD"
                                ? null
                                : await readExact(
                                      opened.handle,
                                      selected?.start ?? 0,
                                      selected === undefined
                                          ? sizeBytes
                                          : selected.endExclusive - selected.start,
                                      request.signal
                                  );
                        abortIfRequested(request.signal);
                        const after = await opened.handle.stat({ bigint: true });
                        abortIfRequested(request.signal);
                        if (!isStableFileStat(root, opened.stat, after)) {
                            return notFoundResponse();
                        }
                        return new Response(body, {
                            headers: responseHeaders(mimeType, sizeBytes, selected),
                            status: selected === undefined ? 200 : 206,
                        });
                    } finally {
                        await opened.close();
                    }
                } catch (error) {
                    if (isAbortError(error)) {
                        throw new DOMException("The operation was aborted", "AbortError");
                    }
                    return notFoundResponse();
                }
            },
            normalizeLocator(candidate) {
                return normalizeLocator(candidate, mediaRootPath);
            },
        });
    } catch {
        if (rootFd !== undefined) Fs.closeSync(rootFd);
        throw invalidConfiguration();
    }
}
