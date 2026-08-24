/* oxlint-disable unicorn/number-literal-case -- File signatures retain wire-format readability. */
import Fs from "node:fs";
import Path from "node:path";

import { workspaceFileLimits } from "../../../contracts/files.ts";
import { redactConfigJsonText } from "../../../shared/configRedaction.ts";
import { WorkspaceFileError } from "../../domains/files/errors.ts";
import type {
    WorkspaceFileDirectorySnapshot,
    WorkspaceFileContentAccess,
    WorkspaceFileLocator,
    WorkspaceFileManifestEntry,
    WorkspaceFileNode,
    WorkspaceFilePreviewKind,
    WorkspaceFileReader,
    WorkspaceFileReadResult,
    WorkspaceFileRootConfiguration,
    WorkspaceFileRootPolicy,
} from "../../domains/files/ports.ts";
import { workspaceFileRevisionForStat } from "./workspaceFileRevision.ts";

const visibleDotNames: ReadonlySet<string> = new Set([
    ".env.example",
    ".environment.example",
]);
const rootIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const childInspectionConcurrency = 12;
const contentSniffBytes = 8192;

export interface DescriptorWorkspaceFileReaderOptions {
    readonly roots: readonly WorkspaceFileRootConfiguration[];
}

interface OpenRoot extends WorkspaceFileRootPolicy {
    readonly device: bigint;
    readonly fd: number;
    readonly manifest?: CompiledManifest;
    readonly ownerId: bigint;
}

interface OpenNode {
    readonly close: () => Promise<void>;
    readonly fd: number;
    readonly root: OpenRoot;
    readonly stat: Fs.BigIntStats;
}

interface CompiledManifest {
    readonly childrenByDirectory: ReadonlyMap<string, readonly string[]>;
    readonly directories: ReadonlySet<string>;
    readonly files: ReadonlyMap<string, WorkspaceFileManifestEntry>;
}

const mimeTypesByExtension: ReadonlyMap<string, string> = new Map([
    [".avif", "image/avif"],
    [".csv", "text/csv"],
    [".gif", "image/gif"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".json", "application/json"],
    [".json5", "application/json"],
    [".md", "text/markdown"],
    [".markdown", "text/markdown"],
    [".mp3", "audio/mpeg"],
    [".ogg", "audio/ogg"],
    [".pdf", "application/pdf"],
    [".png", "image/png"],
    [".txt", "text/plain"],
    [".wav", "audio/wav"],
    [".webp", "image/webp"],
]);
const textExtensions: ReadonlySet<string> = new Set([
    ".bash",
    ".c",
    ".conf",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".log",
    ".lua",
    ".mjs",
    ".php",
    ".properties",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".xml",
    ".yaml",
    ".yml",
    ".zsh",
]);

function abortIfRequested(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new DOMException("Workspace file request was aborted", "AbortError");
    }
}

function runtimeOwnerId(): bigint {
    if (typeof process.getuid !== "function") {
        throw new TypeError("Workspace file reader requires a POSIX runtime owner");
    }
    return BigInt(process.getuid());
}

function requiredRootPath(value: string): string {
    if (
        process.platform !== "linux" ||
        !Path.isAbsolute(value) ||
        value !== Path.normalize(value)
    ) {
        throw new TypeError("Workspace file root must be an absolute Linux path");
    }
    const resolved = Path.resolve(value);
    if (resolved === Path.parse(resolved).root) {
        throw new TypeError("Workspace file root cannot be a filesystem root");
    }
    const canonical = Fs.realpathSync(resolved);
    if (canonical !== resolved || Fs.lstatSync(resolved).isSymbolicLink()) {
        throw new TypeError("Workspace file root must be canonical and non-symbolic");
    }
    return resolved;
}

function isVisibleName(name: string): boolean {
    return !name.startsWith(".") || visibleDotNames.has(name);
}

function isValidRootConfiguration(
    configuration: WorkspaceFileRootConfiguration
): boolean {
    // oxlint-disable-next-line typescript/no-misused-spread -- Contract budgets Unicode code points.
    const labelLength = [...configuration.label].length;
    return (
        typeof configuration.id === "string" &&
        rootIdPattern.test(configuration.id) &&
        typeof configuration.label === "string" &&
        labelLength > 0 &&
        labelLength <= 80 &&
        /\S/u.test(configuration.label) &&
        !/[\p{Cc}\p{Cf}]/u.test(configuration.label) &&
        typeof configuration.writable === "boolean"
    );
}

function isValidSegment(segment: string): boolean {
    return (
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("/") &&
        !segment.includes("\\") &&
        !segment.includes("\0") &&
        !/[\p{Cc}\p{Cf}]/u.test(segment) &&
        isVisibleName(segment) &&
        new TextEncoder().encode(segment).byteLength <=
            workspaceFileLimits.maximumFileNameBytes
    );
}

function locatorKey(segments: readonly string[]): string {
    return segments.join("\0");
}

function isManifestEntry(value: unknown): value is WorkspaceFileManifestEntry {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    const maximumSizeBytes = candidate.maximumSizeBytes;
    const segments = candidate.segments;
    return (
        Array.isArray(segments) &&
        segments.length > 0 &&
        segments.length <= 256 &&
        segments.every(
            (segment: unknown) => typeof segment === "string" && isValidSegment(segment)
        ) &&
        (candidate.contentPolicy === "raw" ||
            candidate.contentPolicy === "redacted-config-json") &&
        candidate.uploadContentPolicy === "reject-redaction-sentinel" &&
        typeof candidate.writable === "boolean" &&
        typeof maximumSizeBytes === "number" &&
        Number.isSafeInteger(maximumSizeBytes) &&
        maximumSizeBytes >= 1 &&
        maximumSizeBytes <= workspaceFileLimits.maximumManifestFileBytes
    );
}

function compileManifest(
    configuration: WorkspaceFileRootConfiguration
): CompiledManifest | undefined {
    const manifest: unknown = configuration.manifest;
    if (manifest === undefined) return undefined;
    if (
        !Array.isArray(manifest) ||
        configuration.writable ||
        manifest.length === 0 ||
        manifest.length > workspaceFileLimits.maximumDirectoryEntries
    ) {
        throw new TypeError("Workspace file root manifest is invalid");
    }
    const files = new Map<string, WorkspaceFileManifestEntry>();
    const directories = new Set<string>([""]);
    const mutableChildren = new Map<string, Set<string>>();
    for (const candidate of manifest as readonly unknown[]) {
        if (!isManifestEntry(candidate)) {
            throw new TypeError("Workspace file root manifest is invalid");
        }
        const entry = candidate;
        const fileKey = locatorKey(entry.segments);
        if (files.has(fileKey)) {
            throw new TypeError("Workspace file root manifest is invalid");
        }
        files.set(
            fileKey,
            Object.freeze({
                contentPolicy: entry.contentPolicy,
                maximumSizeBytes: entry.maximumSizeBytes,
                segments: Object.freeze([...entry.segments]),
                uploadContentPolicy: entry.uploadContentPolicy,
                writable: entry.writable,
            })
        );
        for (let index = 0; index < entry.segments.length; index += 1) {
            const parentSegments = entry.segments.slice(0, index);
            const parentKey = locatorKey(parentSegments);
            directories.add(parentKey);
            const children = mutableChildren.get(parentKey) ?? new Set<string>();
            children.add(entry.segments[index]!);
            mutableChildren.set(parentKey, children);
        }
    }
    if ([...files.keys()].some((key) => directories.has(key))) {
        throw new TypeError("Workspace file root manifest is invalid");
    }
    return Object.freeze({
        childrenByDirectory: new Map(
            [...mutableChildren].map(([key, children]) => [
                key,
                Object.freeze([...children].toSorted()),
            ])
        ),
        directories,
        files,
    });
}

function manifestEntry(
    root: OpenRoot,
    segments: readonly string[]
): WorkspaceFileManifestEntry | undefined {
    return root.manifest?.files.get(locatorKey(segments));
}

function manifestAllows(root: OpenRoot, segments: readonly string[]): boolean {
    if (root.manifest === undefined) return true;
    const key = locatorKey(segments);
    return root.manifest.directories.has(key) || root.manifest.files.has(key);
}

function manifestNodeIsSafe(
    root: OpenRoot,
    segments: readonly string[],
    stat: Fs.BigIntStats
): boolean {
    if (stat.dev !== root.device) return false;
    if (root.manifest === undefined) {
        return stat.isDirectory() || (stat.isFile() && stat.nlink === 1n);
    }
    // The canonical root is owner-controlled and rejects all group/other writes.
    // Descendants retain OpenClaw's reviewed 0775/0664 modes, but must stay
    // same-owner, same-device, and never world-writable.
    if (stat.uid !== root.ownerId || (stat.mode & 0o002n) !== 0n) {
        return false;
    }
    const key = locatorKey(segments);
    if (root.manifest.directories.has(key)) return stat.isDirectory();
    const entry = root.manifest.files.get(key);
    return (
        entry !== undefined &&
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.size <= BigInt(entry.maximumSizeBytes)
    );
}

function rootNodeIsSafe(root: OpenRoot, stat: Fs.BigIntStats): boolean {
    return (
        stat.isDirectory() &&
        stat.dev === root.device &&
        stat.uid === root.ownerId &&
        (root.manifest === undefined
            ? (stat.mode & 0o022n) === 0n
            : (stat.mode & 0o777n) === 0o700n)
    );
}

function requiredLocator(
    locator: WorkspaceFileLocator,
    roots: ReadonlyMap<string, OpenRoot>
): OpenRoot {
    const root = roots.get(locator.rootId);
    if (
        root === undefined ||
        locator.segments.length > 256 ||
        locator.segments.some((segment) => !isValidSegment(segment)) ||
        !manifestAllows(root, locator.segments)
    ) {
        throw new WorkspaceFileError("access-denied");
    }
    return root;
}

function anchoredChildPath(fd: number, segment: string): string {
    return `/proc/self/fd/${fd}/${segment}`;
}

function modifiedAtMs(stat: Fs.BigIntStats): number {
    const value = Number(stat.mtimeNs / 1_000_000n);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new WorkspaceFileError("unavailable");
    }
    return value;
}

function numberSize(stat: Fs.BigIntStats): number {
    const value = Number(stat.size);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new WorkspaceFileError("too-large");
    }
    return value;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset + start, length).toString("ascii");
}

function isUtf8Text(bytes: Uint8Array): boolean {
    if (bytes.includes(0)) return false;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

function contentPresentation(
    name: string,
    bytes: Uint8Array,
    sizeBytes: number
): { readonly mimeType: string; readonly previewKind: WorkspaceFilePreviewKind } {
    const extension = Path.extname(name).toLowerCase();
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return { mimeType: "image/png", previewKind: "image" };
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
        return { mimeType: "image/jpeg", previewKind: "image" };
    }
    if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, Math.min(6, bytes.length)))) {
        return { mimeType: "image/gif", previewKind: "image" };
    }
    if (
        bytes.length >= 12 &&
        ascii(bytes, 0, 4) === "RIFF" &&
        ascii(bytes, 8, 4) === "WEBP"
    ) {
        return { mimeType: "image/webp", previewKind: "image" };
    }
    if (ascii(bytes, 0, Math.min(5, bytes.length)) === "%PDF-") {
        return { mimeType: "application/pdf", previewKind: "pdf" };
    }
    if (
        startsWith(bytes, [0x49, 0x44, 0x33]) ||
        (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)
    ) {
        return { mimeType: "audio/mpeg", previewKind: "audio" };
    }
    if (ascii(bytes, 0, Math.min(4, bytes.length)) === "OggS") {
        return { mimeType: "audio/ogg", previewKind: "audio" };
    }
    if (
        bytes.length >= 12 &&
        ascii(bytes, 0, 4) === "RIFF" &&
        ascii(bytes, 8, 4) === "WAVE"
    ) {
        return { mimeType: "audio/wav", previewKind: "audio" };
    }
    if (isUtf8Text(bytes)) {
        const mimeType =
            extension === ".svg" || extension === ".html"
                ? "text/plain"
                : (mimeTypesByExtension.get(extension) ?? "text/plain");
        return {
            mimeType,
            previewKind:
                sizeBytes > workspaceFileLimits.maximumTextPreviewBytes
                    ? "download-only"
                    : "text",
        };
    }
    return { mimeType: "application/octet-stream", previewKind: "download-only" };
}

function extensionPresentation(
    name: string,
    sizeBytes: number
): {
    readonly mimeType?: string;
    readonly previewKind?: WorkspaceFilePreviewKind;
} {
    const extension = Path.extname(name).toLowerCase();
    const mimeType = mimeTypesByExtension.get(extension);
    if (mimeType?.startsWith("image/") === true) {
        return { mimeType, previewKind: "image" };
    }
    if (mimeType?.startsWith("audio/") === true) {
        return { mimeType, previewKind: "audio" };
    }
    if (mimeType === "application/pdf") return { mimeType, previewKind: "pdf" };
    if (mimeType?.startsWith("text/") === true || mimeType === "application/json") {
        return {
            mimeType,
            previewKind:
                sizeBytes > workspaceFileLimits.maximumTextPreviewBytes
                    ? "download-only"
                    : "text",
        };
    }
    if (textExtensions.has(extension)) {
        return {
            mimeType: "text/plain",
            previewKind:
                sizeBytes > workspaceFileLimits.maximumTextPreviewBytes
                    ? "download-only"
                    : "text",
        };
    }
    return {};
}

function classifyOpenFailure(error: unknown): WorkspaceFileError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
        return new WorkspaceFileError("not-found", error);
    }
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
        return new WorkspaceFileError("access-denied", error);
    }
    return new WorkspaceFileError("unavailable", error);
}

async function openLocator(
    locator: WorkspaceFileLocator,
    roots: ReadonlyMap<string, OpenRoot>
): Promise<OpenNode> {
    const root = requiredLocator(locator, roots);
    const rootStat = Fs.fstatSync(root.fd, { bigint: true });
    if (!rootNodeIsSafe(root, rootStat)) {
        throw new WorkspaceFileError("access-denied");
    }
    if (locator.segments.length === 0) {
        return { close: () => Promise.resolve(), fd: root.fd, root, stat: rootStat };
    }
    const handles: Fs.promises.FileHandle[] = [];
    let parentFd = root.fd;
    let finalStat: Fs.BigIntStats | undefined;
    try {
        for (const [index, segment] of locator.segments.entries()) {
            const isFinal = index === locator.segments.length - 1;
            const flags =
                Fs.constants.O_RDONLY |
                Fs.constants.O_NOFOLLOW |
                Fs.constants.O_NONBLOCK |
                (isFinal ? 0 : Fs.constants.O_DIRECTORY);
            const handle = await Fs.promises.open(
                anchoredChildPath(parentFd, segment),
                flags
            );
            handles.push(handle);
            parentFd = handle.fd;
            if (root.manifest !== undefined) {
                const stat = await handle.stat({ bigint: true });
                if (
                    !manifestNodeIsSafe(root, locator.segments.slice(0, index + 1), stat)
                ) {
                    throw new WorkspaceFileError("access-denied");
                }
                finalStat = stat;
            }
        }
        const final = handles.at(-1);
        if (final === undefined) throw new WorkspaceFileError("not-found");
        const stat = finalStat ?? (await final.stat({ bigint: true }));
        if (stat.dev !== root.device) {
            throw new WorkspaceFileError("access-denied");
        }
        if (!manifestNodeIsSafe(root, locator.segments, stat)) {
            throw new WorkspaceFileError("access-denied");
        }
        return {
            close: async () => {
                await Promise.allSettled(
                    handles.toReversed().map((handle) => handle.close())
                );
            },
            fd: final.fd,
            root,
            stat,
        };
    } catch (error) {
        await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
        throw error instanceof WorkspaceFileError ? error : classifyOpenFailure(error);
    }
}

function readPrefix(fd: number, sizeBytes: number): Uint8Array {
    const length = Math.min(sizeBytes, contentSniffBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const count = Fs.readSync(fd, bytes, offset, length - offset, offset);
        if (count === 0) break;
        offset += count;
    }
    return bytes.subarray(0, offset);
}

function readExact(fd: number, sizeBytes: number, signal?: AbortSignal): Uint8Array {
    const bytes = Buffer.alloc(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
        abortIfRequested(signal);
        const count = Fs.readSync(fd, bytes, offset, sizeBytes - offset, offset);
        if (count === 0) break;
        offset += count;
    }
    if (offset !== sizeBytes) throw new WorkspaceFileError("conflict");
    return bytes;
}

function redactManifestJson(bytes: Uint8Array): Uint8Array {
    let content: string;
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
        throw new WorkspaceFileError("unavailable", error);
    }
    const redacted = redactConfigJsonText(content);
    if (redacted === undefined) throw new WorkspaceFileError("unavailable");
    return Buffer.from(redacted, "utf8");
}

function stableManifestBytes(
    locator: WorkspaceFileLocator,
    root: OpenRoot,
    fd: number,
    stat: Fs.BigIntStats,
    signal?: AbortSignal,
    contentAccess: WorkspaceFileContentAccess = "default"
): Uint8Array | undefined {
    const entry = manifestEntry(root, locator.segments);
    if (contentAccess === "reveal-secrets") {
        if (entry?.contentPolicy !== "redacted-config-json") {
            throw new WorkspaceFileError("access-denied");
        }
        return undefined;
    }
    if (entry?.contentPolicy !== "redacted-config-json") return undefined;
    const sizeBytes = numberSize(stat);
    if (sizeBytes > entry.maximumSizeBytes) {
        throw new WorkspaceFileError("too-large");
    }
    const revision = workspaceFileRevisionForStat(root.id, locator.segments, stat);
    const bytes = readExact(fd, sizeBytes, signal);
    const after = Fs.fstatSync(fd, { bigint: true });
    if (
        !manifestNodeIsSafe(root, locator.segments, after) ||
        workspaceFileRevisionForStat(root.id, locator.segments, after) !== revision
    ) {
        throw new WorkspaceFileError("conflict");
    }
    return redactManifestJson(bytes);
}

function nodeFromStat(
    locator: WorkspaceFileLocator,
    name: string,
    root: OpenRoot,
    stat: Fs.BigIntStats,
    presentation: {
        readonly mimeType?: string;
        readonly previewKind?: WorkspaceFilePreviewKind;
        readonly sizeBytes?: number;
    } = {}
): WorkspaceFileNode {
    if (stat.isDirectory()) {
        return {
            kind: "directory",
            locator,
            name,
            revision: workspaceFileRevisionForStat(root.id, locator.segments, stat),
            writable: root.writable,
        };
    }
    const sizeBytes = presentation.sizeBytes ?? numberSize(stat);
    const entry = manifestEntry(root, locator.segments);
    return {
        kind: "file",
        locator,
        ...(presentation.mimeType === undefined
            ? {}
            : { mimeType: presentation.mimeType }),
        ...(presentation.previewKind === undefined
            ? {}
            : { previewKind: presentation.previewKind }),
        modifiedAtMs: modifiedAtMs(stat),
        name,
        ...(entry?.contentPolicy === "redacted-config-json"
            ? { requiresSecretReveal: true }
            : {}),
        revision: workspaceFileRevisionForStat(root.id, locator.segments, stat),
        sizeBytes,
        ...(entry?.uploadContentPolicy === undefined
            ? {}
            : { uploadContentPolicy: entry.uploadContentPolicy }),
        ...(entry === undefined ? {} : { writeMaximumSizeBytes: entry.maximumSizeBytes }),
        writable: entry?.writable ?? root.writable,
    };
}

function openedFilePresentation(
    locator: WorkspaceFileLocator,
    root: OpenRoot,
    fd: number,
    stat: Fs.BigIntStats,
    signal?: AbortSignal,
    contentAccess: WorkspaceFileContentAccess = "default"
): {
    readonly mimeType: string;
    readonly previewKind: WorkspaceFilePreviewKind;
    readonly sizeBytes?: number;
} {
    const fileName = locator.segments.at(-1);
    if (fileName === undefined) throw new WorkspaceFileError("not-file");
    const redacted = stableManifestBytes(locator, root, fd, stat, signal, contentAccess);
    const sourceSizeBytes = numberSize(stat);
    const bytes = redacted ?? readPrefix(fd, sourceSizeBytes);
    const presentationSizeBytes = Math.max(
        sourceSizeBytes,
        redacted?.byteLength ?? sourceSizeBytes
    );
    return {
        ...contentPresentation(fileName, bytes, presentationSizeBytes),
        ...(redacted === undefined ? {} : { sizeBytes: redacted.byteLength }),
    };
}

async function inspectChild(
    parent: WorkspaceFileLocator,
    parentFd: number,
    root: OpenRoot,
    name: string,
    signal?: AbortSignal
): Promise<WorkspaceFileNode | undefined> {
    abortIfRequested(signal);
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            anchoredChildPath(parentFd, name),
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const stat = await handle.stat({ bigint: true });
        const locator = { rootId: root.id, segments: [...parent.segments, name] };
        if (!manifestNodeIsSafe(root, locator.segments, stat)) {
            return undefined;
        }
        let presentation = extensionPresentation(name, numberSize(stat));
        if (
            stat.isFile() &&
            manifestEntry(root, locator.segments)?.contentPolicy ===
                "redacted-config-json"
        ) {
            try {
                presentation = openedFilePresentation(
                    locator,
                    root,
                    handle.fd,
                    stat,
                    signal
                );
            } catch (error) {
                if (
                    !(error instanceof WorkspaceFileError) ||
                    error.reason !== "unavailable"
                ) {
                    throw error;
                }
                // Keep the reviewed file selectable so recent-auth reveal can repair
                // invalid JSON without exposing any raw bytes in the directory list.
            }
        }
        return nodeFromStat(locator, name, root, stat, presentation);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(code ?? "")) {
            return undefined;
        }
        throw classifyOpenFailure(error);
    } finally {
        await handle?.close();
    }
}

async function mapConcurrent<TInput, TOutput>(
    values: readonly TInput[],
    concurrency: number,
    operation: (value: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
    const results: TOutput[] = [];
    results.length = values.length;
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (true) {
                const index = nextIndex;
                nextIndex += 1;
                const value = values[index];
                if (value === undefined) return;
                results[index] = await operation(value);
            }
        }
    );
    await Promise.all(workers);
    return results;
}

async function directoryNames(
    locator: WorkspaceFileLocator,
    root: OpenRoot,
    fd: number,
    signal?: AbortSignal
): Promise<string[]> {
    if (root.manifest !== undefined) {
        return [
            ...(root.manifest.childrenByDirectory.get(locatorKey(locator.segments)) ??
                []),
        ];
    }
    const directory = await Fs.promises.opendir(`/proc/self/fd/${fd}`);
    const names: string[] = [];
    let observed = 0;
    try {
        for await (const entry of directory) {
            abortIfRequested(signal);
            observed += 1;
            if (observed > workspaceFileLimits.maximumDirectoryEntries) {
                throw new WorkspaceFileError("directory-too-large");
            }
            if (entry.isSymbolicLink() || !isValidSegment(entry.name)) continue;
            names.push(entry.name);
        }
    } finally {
        await directory.close().catch(() => {});
    }
    return names;
}

function rootNode(root: OpenRoot, stat: Fs.BigIntStats): WorkspaceFileNode {
    return {
        kind: "directory",
        locator: { rootId: root.id, segments: [] },
        name: root.label,
        revision: workspaceFileRevisionForStat(root.id, [], stat),
        writable: root.writable,
    };
}

/**
 * Creates a Linux descriptor-rooted workspace reader. Every segment is opened with
 * `O_NOFOLLOW`; special files, hard links, cross-device mounts, and hidden segments fail closed.
 * @param options Reviewed named roots available to the web reader.
 * @returns Descriptor-anchored read-only workspace adapter.
 */
export function createDescriptorWorkspaceFileReader(
    options: DescriptorWorkspaceFileReaderOptions
): WorkspaceFileReader {
    const ownerId = runtimeOwnerId();
    if (
        options.roots.length === 0 ||
        options.roots.length > workspaceFileLimits.maximumConfiguredRoots
    ) {
        throw new TypeError("Workspace file root count is invalid");
    }
    const roots = new Map<string, OpenRoot>();
    try {
        for (const configuration of options.roots) {
            if (!isValidRootConfiguration(configuration)) {
                throw new TypeError("Workspace file root metadata is invalid");
            }
            const manifest = compileManifest(configuration);
            if (roots.has(configuration.id)) {
                throw new TypeError("Workspace file root ids must be unique");
            }
            const rootPath = requiredRootPath(configuration.path);
            const fd = Fs.openSync(
                rootPath,
                Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
            );
            const stat = Fs.fstatSync(fd, { bigint: true });
            const root = {
                device: stat.dev,
                fd,
                id: configuration.id,
                label: configuration.label,
                ...(manifest === undefined ? {} : { manifest }),
                ownerId,
                writable: configuration.writable,
            } satisfies OpenRoot;
            if (!rootNodeIsSafe(root, stat)) {
                Fs.closeSync(fd);
                throw new TypeError("Workspace file root owner or mode is invalid");
            }
            roots.set(configuration.id, root);
        }
    } catch (error) {
        for (const root of roots.values()) Fs.closeSync(root.fd);
        throw error;
    }
    let disposed = false;
    const requireAvailable = () => {
        if (disposed) throw new WorkspaceFileError("unavailable");
    };
    return Object.freeze<WorkspaceFileReader>({
        async describe(locator, signal, contentAccess = "default") {
            requireAvailable();
            abortIfRequested(signal);
            const opened = await openLocator(locator, roots);
            try {
                const name = locator.segments.at(-1) ?? opened.root.label;
                if (opened.stat.isDirectory()) {
                    return nodeFromStat(locator, name, opened.root, opened.stat);
                }
                return nodeFromStat(
                    locator,
                    name,
                    opened.root,
                    opened.stat,
                    openedFilePresentation(
                        locator,
                        opened.root,
                        opened.fd,
                        opened.stat,
                        signal,
                        contentAccess
                    )
                );
            } finally {
                await opened.close();
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const root of roots.values()) Fs.closeSync(root.fd);
            roots.clear();
        },
        async list(locator, signal): Promise<WorkspaceFileDirectorySnapshot> {
            requireAvailable();
            abortIfRequested(signal);
            const opened = await openLocator(locator, roots);
            try {
                if (!opened.stat.isDirectory()) {
                    throw new WorkspaceFileError("not-file");
                }
                const beforeRevision = workspaceFileRevisionForStat(
                    opened.root.id,
                    locator.segments,
                    opened.stat
                );
                const names = await directoryNames(
                    locator,
                    opened.root,
                    opened.fd,
                    signal
                );
                const inspected = await mapConcurrent(
                    names,
                    childInspectionConcurrency,
                    (name) => inspectChild(locator, opened.fd, opened.root, name, signal)
                );
                const after = Fs.fstatSync(opened.fd, { bigint: true });
                if (
                    workspaceFileRevisionForStat(
                        opened.root.id,
                        locator.segments,
                        after
                    ) !== beforeRevision
                ) {
                    throw new WorkspaceFileError("conflict");
                }
                const entries = inspected
                    .filter((entry): entry is WorkspaceFileNode => entry !== undefined)
                    .toSorted((left, right) => {
                        if (left.kind !== right.kind) {
                            return left.kind === "directory" ? -1 : 1;
                        }
                        return left.name.localeCompare(right.name);
                    });
                const directory =
                    locator.segments.length === 0
                        ? rootNode(opened.root, after)
                        : nodeFromStat(
                              locator,
                              locator.segments.at(-1)!,
                              opened.root,
                              after
                          );
                return { directory: { ...directory, kind: "directory" }, entries };
            } finally {
                await opened.close();
            }
        },
        async read(
            locator,
            expectedRevision,
            range,
            signal,
            contentAccess = "default"
        ): Promise<WorkspaceFileReadResult> {
            requireAvailable();
            abortIfRequested(signal);
            const opened = await openLocator(locator, roots);
            try {
                if (!opened.stat.isFile() || opened.stat.nlink !== 1n) {
                    throw new WorkspaceFileError("not-file");
                }
                const revision = workspaceFileRevisionForStat(
                    opened.root.id,
                    locator.segments,
                    opened.stat
                );
                if (revision !== expectedRevision) {
                    throw new WorkspaceFileError("conflict");
                }
                const redactedBytes = stableManifestBytes(
                    locator,
                    opened.root,
                    opened.fd,
                    opened.stat,
                    signal,
                    contentAccess
                );
                const sourceSizeBytes = numberSize(opened.stat);
                const sizeBytes = redactedBytes?.byteLength ?? sourceSizeBytes;
                const presentationSizeBytes = Math.max(sourceSizeBytes, sizeBytes);
                if (sizeBytes > workspaceFileLimits.maximumDownloadBytes) {
                    throw new WorkspaceFileError("too-large");
                }
                const start = range?.start ?? 0;
                const endExclusive = range?.endExclusive ?? sizeBytes;
                if (
                    !Number.isSafeInteger(start) ||
                    !Number.isSafeInteger(endExclusive) ||
                    start < 0 ||
                    (range === undefined && sizeBytes === 0
                        ? endExclusive !== 0 || start !== 0
                        : endExclusive <= start) ||
                    endExclusive > sizeBytes
                ) {
                    throw new WorkspaceFileError("invalid-input");
                }
                const length = endExclusive - start;
                let bytes: Uint8Array;
                let offset: number;
                if (redactedBytes === undefined) {
                    bytes = Buffer.alloc(length);
                    offset = 0;
                    while (offset < length) {
                        abortIfRequested(signal);
                        const count = Fs.readSync(
                            opened.fd,
                            bytes,
                            offset,
                            length - offset,
                            start + offset
                        );
                        if (count === 0) break;
                        offset += count;
                    }
                } else {
                    bytes = redactedBytes.slice(start, endExclusive);
                    offset = bytes.byteLength;
                }
                const after = Fs.fstatSync(opened.fd, { bigint: true });
                if (
                    offset !== length ||
                    workspaceFileRevisionForStat(
                        opened.root.id,
                        locator.segments,
                        after
                    ) !== revision
                ) {
                    throw new WorkspaceFileError("conflict");
                }
                const fileName = locator.segments.at(-1);
                if (fileName === undefined) throw new WorkspaceFileError("not-file");
                let prefix: Uint8Array;
                if (start === 0) {
                    prefix = bytes.subarray(0, Math.min(bytes.length, contentSniffBytes));
                } else if (redactedBytes === undefined) {
                    prefix = readPrefix(opened.fd, sizeBytes);
                } else {
                    prefix = redactedBytes.subarray(
                        0,
                        Math.min(redactedBytes.length, contentSniffBytes)
                    );
                }
                const presentation = contentPresentation(
                    fileName,
                    prefix,
                    presentationSizeBytes
                );
                return {
                    bytes,
                    fileName,
                    ...presentation,
                    revision,
                    sizeBytes,
                };
            } finally {
                await opened.close();
            }
        },
        roots() {
            requireAvailable();
            return [...roots.values()].map(({ id, label, writable }) => ({
                id,
                label,
                writable,
            }));
        },
    });
}
