import { execFile } from "node:child_process";
import {
    constants,
    createReadStream,
    createWriteStream,
    existsSync as fsSyncExists,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

import { db } from "../db.ts";
import { writeCacheSuccess } from "./cacheEntryWriter.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

function dateToISOString(date: Date): string {
    return date.toISOString();
}

async function ignoreRejection(promise: Promise<unknown> | undefined): Promise<void> {
    try {
        await promise;
    } catch {
        // Best-effort cleanup.
    }
}

async function ignoreMissingPath(
    promise: Promise<unknown>,
    onOtherError?: (error: unknown) => void
): Promise<void> {
    try {
        await promise;
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }
        if (onOtherError) {
            onOtherError(error);
            return;
        }
        throw error;
    }
}

const STATE_CACHE_KEY = "log_rotation.state";
const execFileAsync = promisify(execFile);
const BUNDLED_CONFIG_PATH = fileURLToPath(
    new URL("../../config/log-rotation.json", import.meta.url)
);
const CWD_CONFIG_PATH = path.resolve(process.cwd(), "config/log-rotation.json");
const SOURCE_CONFIG_PATH = path.resolve(
    process.cwd(),
    "backend/config/log-rotation.json"
);
const DEFAULT_APPROVED_ROOTS = ["/opt/docker/data"];
const ROTATED_SUFFIX_RE = /\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:\.gz)?$/u;
const ARCHIVE_FAMILY_SUFFIX_RE =
    /(?:\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z|\.\d+)(?:\.gz)?$/u;
const DEFAULT_LOCK_FILE = path.resolve(process.cwd(), "data/log-rotation.lock");
const RECLAIM_DIR_STALE_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 12 * 60 * 60 * 1000;
const ELEVATED_LOG_ROTATION_TIMEOUT_MS = 5 * 60_000;
const ELEVATED_LOG_ROTATION_MAX_BUFFER = 16 * 1024 * 1024;
const LOG_ROTATION_JOB_ID = "ops.log-rotation";
const LOG_ROTATION_FAILURE_OUTPUT_MAX_CHARS = 100_000;
const BUN_EXECUTABLE = process.env.BUN_BINARY || "bun";
const logRotationLockFile = DEFAULT_LOCK_FILE;

type ExecFileRunner = (
    file: string,
    args: readonly string[] | undefined,
    options: {
        encoding?: BufferEncoding;
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        timeout?: number;
    }
) => Promise<{ stderr: string; stdout: string }>;

const elevatedLogRotationExecFileRunner: ExecFileRunner = execFileAsync as ExecFileRunner;
const gzipPipeline = pipeline;
const writeLogRotationCacheSuccess = writeCacheSuccess;

function caughtMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function defaultConfigPath(): string {
    const configured = process.env.MIRA_LOG_ROTATION_CONFIG;
    if (configured?.trim()) {
        return configured;
    }
    if (fsSyncExists(CWD_CONFIG_PATH)) {
        return CWD_CONFIG_PATH;
    }
    if (fsSyncExists(SOURCE_CONFIG_PATH)) {
        return SOURCE_CONFIG_PATH;
    }
    return BUNDLED_CONFIG_PATH;
}

interface LogRotationOptions {
    dryRun: boolean;
    config?: string;
    group?: string | null;
    verbose?: boolean;
}

interface LogRotationState {
    version: number;
    files: Record<
        string,
        { lastRotatedAt?: string; lastSizeBytes?: number; lastArchive?: string }
    >;
    lastRun?: Record<string, unknown>;
}

interface LogRotationPolicy {
    name?: string;
    enabled?: boolean;
    paths?: string[];
    excludePaths?: string[];
    archivePaths?: string[];
    approvedRoots?: string[];
    archiveOnly?: boolean;
    archiveRetentionScope?: "directory" | "basename" | "parent";
    archiveMinAgeMinutes?: number;
    compress?: boolean;
    skipEmpty?: boolean;
    missingOk?: boolean;
    maxSizeMb?: number;
    keep?: number;
    keepDays?: number;
    strategy?: "copytruncate" | "rename";
    daily?: boolean;
    weekly?: boolean;
}

interface VerifiedLogFile {
    handle: fs.FileHandle;
    stat: import("node:fs").Stats;
}

type RetentionArchive = { path: string; mtimeMs: number; compress: boolean };
type RotationResult = { archivePath: string; compressed: boolean; warning?: string };

interface LogRotationConfig {
    version: number;
    approvedRoots?: string[];
    excludePaths?: string[];
    defaults?: LogRotationPolicy;
    groups: LogRotationPolicy[];
}

function byteLimitFromMb(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1024 * 1024 : null;
}

function mergePolicy(defaults: LogRotationPolicy, group: LogRotationPolicy) {
    return {
        compress: true,
        skipEmpty: true,
        missingOk: true,
        maxSizeMb: 10,
        keep: 7,
        strategy: "copytruncate" as const,
        daily: false,
        weekly: false,
        ...defaults,
        ...group,
    };
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function validateConfig(config: LogRotationConfig): void {
    if (!config || typeof config !== "object") {
        throw new Error("Config must be an object");
    }
    if (
        config.defaults !== undefined &&
        (config.defaults === null ||
            typeof config.defaults !== "object" ||
            Array.isArray(config.defaults))
    ) {
        throw new Error("Config defaults must be an object");
    }
    if (config.version !== 1) {
        throw new Error("Config version must be 1");
    }
    if (!Array.isArray(config.groups)) {
        throw new TypeError("Config groups must be an array");
    }
    validateNonEmptyOptionalStringArray(config.approvedRoots, "approvedRoots");
    validateNonEmptyOptionalStringArray(
        config.defaults?.approvedRoots,
        "defaults.approvedRoots"
    );
    validateOptionalStringArray(config.defaults?.paths, "defaults.paths");
    validateOptionalStringArray(config.defaults?.excludePaths, "defaults.excludePaths");
    validateOptionalStringArray(config.defaults?.archivePaths, "defaults.archivePaths");
    validatePolicyTypes(config.defaults, "defaults");
    validateOptionalStringArray(config.excludePaths, "excludePaths");
    validateArchiveRetentionScope(
        config.defaults?.archiveRetentionScope,
        "defaults.archiveRetentionScope"
    );
    if (
        config.defaults?.strategy !== undefined &&
        config.defaults.strategy !== "copytruncate" &&
        config.defaults.strategy !== "rename"
    ) {
        throw new Error("defaults.strategy has unsupported strategy");
    }
    for (const group of config.groups) {
        if (typeof group.name !== "string" || group.name.trim() === "") {
            throw new Error("Every group needs a string name");
        }
        validateNonEmptyOptionalStringArray(
            group.approvedRoots,
            `Group ${group.name} approvedRoots`
        );
        validateOptionalStringArray(group.paths, `Group ${group.name} paths`);
        validateOptionalStringArray(
            group.excludePaths,
            `Group ${group.name} excludePaths`
        );
        validateOptionalStringArray(
            group.archivePaths,
            `Group ${group.name} archivePaths`
        );
        validateArchiveRetentionScope(
            group.archiveRetentionScope,
            `Group ${group.name} archiveRetentionScope`
        );
        validatePolicyTypes(group, `Group ${group.name}`);
        const effectivePolicy = mergePolicy(config.defaults ?? {}, group);
        if (effectivePolicy.daily === true && effectivePolicy.weekly === true) {
            throw new Error(
                `Group ${group.name} cannot set both daily and weekly rotation`
            );
        }
        const hasPaths =
            Array.isArray(effectivePolicy.paths) && effectivePolicy.paths.length > 0;
        const hasArchivePaths =
            Array.isArray(effectivePolicy.archivePaths) &&
            effectivePolicy.archivePaths.length > 0;
        if (effectivePolicy.archiveOnly === true && !hasArchivePaths) {
            throw new Error(
                `Archive-only group ${group.name} needs at least one archivePaths pattern`
            );
        }
        if (effectivePolicy.archiveOnly !== true && !hasPaths) {
            throw new Error(`Group ${group.name} needs at least one path pattern`);
        }
        if (
            effectivePolicy.strategy !== undefined &&
            effectivePolicy.strategy !== "copytruncate" &&
            effectivePolicy.strategy !== "rename"
        ) {
            throw new Error(`Group ${group.name} has unsupported strategy`);
        }
    }
}

function validatePolicyTypes(policy: LogRotationPolicy | undefined, label: string): void {
    if (policy === undefined) return;
    for (const field of [
        "enabled",
        "archiveOnly",
        "daily",
        "weekly",
        "compress",
        "skipEmpty",
        "missingOk",
    ] as const) {
        if (policy[field] !== undefined && typeof policy[field] !== "boolean") {
            throw new TypeError(`${label}.${field} must be a boolean`);
        }
    }
    for (const field of ["maxSizeMb", "keepDays", "archiveMinAgeMinutes"] as const) {
        if (
            policy[field] !== undefined &&
            (typeof policy[field] !== "number" || policy[field] < 0)
        ) {
            throw new TypeError(`${label}.${field} must be a non-negative number`);
        }
    }
    if (
        policy.keep !== undefined &&
        (typeof policy.keep !== "number" ||
            policy.keep < 1 ||
            !Number.isSafeInteger(policy.keep))
    ) {
        throw new TypeError(`${label}.keep must be a positive integer`);
    }
}

function validateOptionalStringArray(value: unknown, fieldName: string): void {
    if (value === undefined) return;
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    ) {
        throw new TypeError(`${fieldName} must be an array of non-empty strings`);
    }
}

function validateNonEmptyOptionalStringArray(value: unknown, fieldName: string): void {
    validateOptionalStringArray(value, fieldName);
    if (Array.isArray(value) && value.length === 0) {
        throw new TypeError(`${fieldName} must include at least one entry`);
    }
}

function validateArchiveRetentionScope(value: unknown, fieldName: string): void {
    if (value === undefined) return;
    if (value !== "directory" && value !== "basename" && value !== "parent") {
        throw new TypeError(`${fieldName} must be directory, basename, or parent`);
    }
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function globPatternSource(pattern: string): string {
    return pattern
        .split(/(\*|\[0-9\])/u)
        .map((part) => {
            if (part === "*") {
                return "[^/]*";
            }
            if (part === "[0-9]") {
                return "[0-9]";
            }
            return escapeRegExp(part);
        })
        .join("");
}

// Static-analysis ReDoS warnings are acknowledged here. These patterns come
// from admin-controlled config, and metacharacters are escaped before the only
// supported glob tokens (`*` and `[0-9]`) are interpolated, avoiding nested
// quantifier constructs.
function globToRegex(pattern: string): RegExp {
    const normalized = pattern.split(path.sep).join("/");
    return new RegExp(`^${globPatternSource(normalized)}$`);
}

function segmentRegex(segment: string): RegExp {
    return new RegExp(`^${globPatternSource(segment)}$`);
}

function isMissingPathError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR"].includes(String(error.code))
    );
}

function isPathExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && String(error.code) === "EEXIST";
}

function hasGlobMeta(pattern: string): boolean {
    return /\*|\[0-9\]/u.test(pattern);
}

async function resolveGlob(
    pattern: string,
    options: { missingOk?: boolean } = {}
): Promise<string[]> {
    const absolutePattern = path.resolve(pattern);
    const segments = absolutePattern.split(path.sep).filter(Boolean);
    let candidates: string[] = [path.sep];

    for (const [index, segment] of segments.entries()) {
        const hasWildcard = hasGlobMeta(segment);
        const isLastSegment = index === segments.length - 1;
        const regex = hasWildcard ? segmentRegex(segment) : null;
        const nextCandidates: string[] = [];

        for (const candidate of candidates) {
            if (hasWildcard) {
                await appendGlobWildcardCandidates({
                    candidate,
                    isLastSegment,
                    nextCandidates,
                    regex,
                });
            } else {
                nextCandidates.push(path.join(candidate, segment));
            }
        }
        candidates = nextCandidates;
        if (candidates.length === 0) break;
    }

    const files: string[] = [];
    for (const candidate of candidates) {
        try {
            const stat = await fs.lstat(candidate);
            if (stat.isFile()) files.push(candidate);
        } catch (error) {
            if (isMissingPathError(error)) {
                continue;
            }
            throw error;
        }
    }
    const regex = globToRegex(absolutePattern);
    const matchedFiles = files.filter((file) =>
        regex.test(file.split(path.sep).join("/"))
    );
    if (
        options.missingOk === false &&
        !hasGlobMeta(pattern) &&
        matchedFiles.length === 0
    ) {
        throw new Error(`Log rotation path does not exist: ${pattern}`);
    }
    return matchedFiles;
}

async function appendGlobWildcardCandidates(options: {
    candidate: string;
    isLastSegment: boolean;
    nextCandidates: string[];
    regex: RegExp | null;
}): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
        entries = await fs.readdir(options.candidate, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }
        throw error;
    }
    for (const entry of entries) {
        if (
            !entry.isSymbolicLink() &&
            options.regex?.test(entry.name) &&
            (options.isLastSegment || entry.isDirectory())
        ) {
            options.nextCandidates.push(path.join(options.candidate, entry.name));
        }
    }
}

function isUnderRoot(filePath: string, root: string): boolean {
    const relative = path.relative(root, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertSafePath(
    filePath: string,
    approvedRoots: string[]
): Promise<boolean> {
    let realFilePath: string;
    try {
        realFilePath = await fs.realpath(filePath);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    const resolvedRoots = await Promise.all(
        approvedRoots.map(async (root) => {
            try {
                return await fs.realpath(root);
            } catch (error) {
                if (isMissingPathError(error)) {
                    return null;
                }
                throw error;
            }
        })
    );
    const realRoots = resolvedRoots.filter((root): root is string => root !== null);
    if (realRoots.length === 0) {
        throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
    }
    if (realRoots.every((root) => !isUnderRoot(realFilePath, root))) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
    const lstat = await fs.lstat(filePath);
    if (lstat.isSymbolicLink()) throw new Error(`Refusing symlink path: ${filePath}`);
    if (!lstat.isFile()) throw new Error(`Refusing non-file path: ${filePath}`);
    return true;
}

async function assertSafeNewFileParent(
    filePath: string,
    approvedRoots: string[]
): Promise<void> {
    const parent = await fs.realpath(path.dirname(filePath));
    const resolvedRoots = await Promise.all(
        approvedRoots.map(async (root) => {
            try {
                return await fs.realpath(root);
            } catch {
                return null;
            }
        })
    );
    const realRoots = resolvedRoots.filter((root): root is string => root !== null);
    if (realRoots.length === 0) {
        throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
    }
    if (realRoots.every((root) => !isUnderRoot(parent, root))) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
}

async function openVerifiedLogFile(
    filePath: string,
    approvedRoots: string[]
): Promise<VerifiedLogFile> {
    return openVerifiedFile(filePath, approvedRoots, constants.O_RDWR);
}

async function openVerifiedFile(
    filePath: string,
    approvedRoots: string[],
    flags: number
): Promise<VerifiedLogFile> {
    const handle = await fs.open(filePath, flags | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
            throw new Error(`Refusing non-file path: ${filePath}`);
        }
        if (stat.nlink > 1) {
            throw new Error(`Refusing multi-linked file: ${filePath}`);
        }
        const realFilePath = await fs.realpath(filePath);
        const resolvedRoots = await Promise.all(
            approvedRoots.map(async (root) => {
                try {
                    return await fs.realpath(root);
                } catch {
                    return null;
                }
            })
        );
        const realRoots = resolvedRoots.filter((root): root is string => root !== null);
        if (realRoots.length === 0) {
            throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
        }
        if (realRoots.every((root) => !isUnderRoot(realFilePath, root))) {
            throw new Error(`Unsafe path outside approved roots: ${filePath}`);
        }
        await assertFileIdentity(filePath, stat, approvedRoots);
        return { handle, stat };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function assertFileIdentity(
    filePath: string,
    expected: { dev: number; ino: number },
    approvedRoots: string[]
): Promise<void> {
    const safe = await assertSafePath(filePath, approvedRoots);
    if (!safe) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
    const currentStat = await fs.stat(filePath);
    if (expected.dev !== currentStat.dev || expected.ino !== currentStat.ino) {
        throw new Error(`Unsafe path changed before rotation: ${filePath}`);
    }
    if (currentStat.nlink > 1) {
        throw new Error(`Refusing multi-linked file: ${filePath}`);
    }
}

async function unlinkVerified(filePath: string, approvedRoots: string[]): Promise<void> {
    const file = await openVerifiedFile(filePath, approvedRoots, constants.O_RDONLY);
    const tombstonePath = `${filePath}.delete-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
    try {
        await assertFileIdentity(filePath, file.stat, approvedRoots);
        await assertSafeNewFileParent(tombstonePath, approvedRoots);
        await fs.rename(filePath, tombstonePath);
        await assertFileIdentity(tombstonePath, file.stat, approvedRoots);
        await fs.unlink(tombstonePath);
    } catch (error) {
        await ignoreRejection(fs.rename(tombstonePath, filePath));
        throw error;
    } finally {
        await file.handle.close();
    }
}

const archiveOnlyUnlinkVerified = unlinkVerified;

async function createNoFollowFile(
    filePath: string,
    mode: number,
    owner?: { uid: number; gid: number }
): Promise<fs.FileHandle> {
    const handle = await fs.open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode
    );
    try {
        await handle.chmod(mode);
        if (owner) {
            const created = await handle.stat();
            if (created.uid !== owner.uid || created.gid !== owner.gid) {
                await handle.chown(owner.uid, owner.gid);
            }
        }
        return handle;
    } catch (error) {
        await ignoreRejection(handle.close());
        await ignoreRejection(fs.unlink(filePath));
        throw error;
    }
}

async function gzipFile(filePath: string, approvedRoots: string[]): Promise<string> {
    const source = await openVerifiedFile(filePath, approvedRoots, constants.O_RDONLY);
    const gzPath = `${filePath}.gz`;
    let destination: fs.FileHandle | null = null;
    let sourceRemoved = false;
    try {
        await assertSafeNewFileParent(gzPath, approvedRoots);
        destination = await createNoFollowFile(gzPath, source.stat.mode & 0o777, {
            uid: source.stat.uid,
            gid: source.stat.gid,
        });
        await gzipPipeline(
            createReadStream("", {
                fd: source.handle.fd,
                autoClose: false,
                start: 0,
            }),
            createGzip(),
            createWriteStream("", {
                fd: destination.fd,
                autoClose: false,
                start: 0,
            })
        );
        await assertFileIdentity(filePath, source.stat, approvedRoots);
        await fs.utimes(gzPath, source.stat.atime, source.stat.mtime);
        await destination.close();
        destination = null;
        await unlinkVerified(filePath, approvedRoots);
        sourceRemoved = true;
        await source.handle.close();
        return gzPath;
    } catch (error) {
        await ignoreRejection(destination?.close());
        await ignoreRejection(source.handle.close());
        if (
            !sourceRemoved &&
            !(
                error instanceof Error &&
                "code" in error &&
                String(error.code) === "EEXIST"
            )
        ) {
            await ignoreMissingPath(fs.unlink(gzPath));
        }
        throw error;
    }
}

async function compressRotatedArchive(
    archivePath: string,
    compress: boolean,
    approvedRoots: string[]
): Promise<RotationResult> {
    if (!compress) {
        return { archivePath, compressed: false };
    }
    try {
        return {
            archivePath: await gzipFile(archivePath, approvedRoots),
            compressed: true,
        };
    } catch (error) {
        return {
            archivePath,
            compressed: false,
            warning: `Compression failed for ${archivePath}: ${caughtMessage(error)}`,
        };
    }
}

function archiveBasePath(filePath: string, now: Date): string {
    const stamp = now.toISOString().replaceAll(":", "-");
    return `${filePath}.${stamp}`;
}

async function rotateCopyTruncate(
    filePath: string,
    file: VerifiedLogFile,
    archivePath: string,
    compress: boolean,
    approvedRoots: string[]
): Promise<RotationResult> {
    await assertSafeNewFileParent(archivePath, approvedRoots);
    const destination = await createNoFollowFile(archivePath, file.stat.mode & 0o777, {
        uid: file.stat.uid,
        gid: file.stat.gid,
    });
    let committed = false;
    try {
        await pipeline(
            createReadStream("", { fd: file.handle.fd, autoClose: false, start: 0 }),
            createWriteStream("", { fd: destination.fd, autoClose: false, start: 0 })
        );
        await fs.utimes(archivePath, file.stat.atime, new Date());
        await destination.close();
        await assertFileIdentity(filePath, file.stat, approvedRoots);
        await file.handle.truncate(0);
        committed = true;
        return compressRotatedArchive(archivePath, compress, approvedRoots);
    } catch (error) {
        if (!committed) {
            await ignoreMissingPath(fs.unlink(archivePath), (unlinkError) => {
                console.warn(
                    "[LogRotation] Failed to remove incomplete archive:",
                    unlinkError
                );
            });
        }
        throw error;
    } finally {
        await ignoreRejection(destination.close());
    }
}

async function rotateRename(
    filePath: string,
    file: VerifiedLogFile,
    archivePath: string,
    compress: boolean,
    approvedRoots: string[]
): Promise<RotationResult> {
    await assertFileIdentity(filePath, file.stat, approvedRoots);
    await fs.rename(filePath, archivePath);
    await fs.utimes(archivePath, file.stat.atime, new Date());
    try {
        const replacement = await createNoFollowFile(filePath, file.stat.mode & 0o777, {
            uid: file.stat.uid,
            gid: file.stat.gid,
        });
        await replacement.close();
    } catch (error) {
        if (isPathExistsError(error)) {
            return compressRotatedArchive(archivePath, compress, approvedRoots);
        }
        await ignoreRejection(fs.rename(archivePath, filePath));
        throw error;
    }
    return compressRotatedArchive(archivePath, compress, approvedRoots);
}

function archiveFamilyBasename(archivePath: string): string {
    return path.basename(archivePath).replace(ARCHIVE_FAMILY_SUFFIX_RE, "");
}

function managedArchiveRegexFor(filePath: string): RegExp {
    return new RegExp(
        String.raw`^${escapeRegExp(path.basename(filePath))}\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:\.gz)?$`
    );
}

function archiveMatchesRetentionScope(
    filePath: string,
    archivePath: string,
    policy: LogRotationPolicy
): boolean {
    if (policy.archiveRetentionScope === "basename") {
        const archiveBase = archiveFamilyBasename(archivePath);
        return (
            archiveBase === path.basename(filePath) &&
            path.dirname(archivePath) === path.dirname(filePath)
        );
    }
    if (policy.archiveRetentionScope === "parent") {
        return (
            path.dirname(path.dirname(archivePath)) ===
            path.dirname(path.dirname(filePath))
        );
    }
    return path.dirname(archivePath) === path.dirname(filePath);
}

function isGzipArchivePath(filePath: string): boolean {
    return filePath.endsWith(".gz");
}

async function isSameResolvedPath(
    firstPath: string,
    secondPath: string
): Promise<boolean> {
    if (path.resolve(firstPath) === path.resolve(secondPath)) {
        return true;
    }
    return (await fs.realpath(firstPath)) === (await fs.realpath(secondPath));
}

async function listArchives(
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[],
    simulatedArchives: RetentionArchive[] = []
) {
    const dir = path.dirname(filePath);
    const managedRegex = managedArchiveRegexFor(filePath);
    const archives: RetentionArchive[] = [...simulatedArchives];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && managedRegex.test(entry.name)) {
            const fullPath = path.join(dir, entry.name);
            const stat = await fs.stat(fullPath);
            archives.push({
                path: fullPath,
                mtimeMs: stat.mtimeMs,
                compress: policy.compress !== false && !isGzipArchivePath(fullPath),
            });
        }
    }
    for (const pattern of policy.archivePaths ?? []) {
        for (const archivePath of await resolveGlob(pattern, {
            missingOk: Boolean(policy.missingOk),
        })) {
            if (
                archiveMatchesRetentionScope(filePath, archivePath, policy) &&
                (await assertSafePath(archivePath, approvedRoots)) &&
                !(await isSameResolvedPath(archivePath, filePath))
            ) {
                const stat = await fs.stat(archivePath);
                archives.push({
                    path: archivePath,
                    mtimeMs: stat.mtimeMs,
                    compress: policy.compress !== false,
                });
            }
        }
    }
    const uniqueArchives = new Map<string, RetentionArchive>();
    for (const archive of archives) {
        if (!uniqueArchives.has(archive.path)) {
            uniqueArchives.set(archive.path, archive);
        }
    }
    return uniqueArchives
        .values()
        .toArray()
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function compressArchiveIfNeeded(
    archive: RetentionArchive,
    dryRun: boolean,
    approvedRoots: string[]
): Promise<{ archive: RetentionArchive; compressed: boolean; warning?: string }> {
    if (!archive.compress || archive.path.endsWith(".gz")) {
        return { archive, compressed: false };
    }
    const gzPath = `${archive.path}.gz`;
    if (dryRun) {
        return { archive: { ...archive, path: gzPath }, compressed: true };
    }
    try {
        return {
            archive: { ...archive, path: await gzipFile(archive.path, approvedRoots) },
            compressed: true,
        };
    } catch (error) {
        return {
            archive,
            compressed: false,
            warning: `Compression failed for ${archive.path}: ${caughtMessage(error)}`,
        };
    }
}

const archiveOnlyCompressArchiveIfNeeded = compressArchiveIfNeeded;

function retentionDeleteSet(archives: RetentionArchive[], policy: LogRotationPolicy) {
    const deleteSet = new Map<string, RetentionArchive>();
    if (Number.isSafeInteger(policy.keep) && Number(policy.keep) >= 0) {
        for (const archive of archives.slice(Number(policy.keep))) {
            deleteSet.set(archive.path, archive);
        }
    }
    if (Number.isFinite(Number(policy.keepDays)) && Number(policy.keepDays) >= 0) {
        const cutoff = Date.now() - Number(policy.keepDays) * 24 * 60 * 60 * 1000;
        for (const archive of archives) {
            if (archive.mtimeMs < cutoff) deleteSet.set(archive.path, archive);
        }
    }
    return deleteSet;
}

async function applyRetention(
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[],
    dryRun: boolean,
    simulatedArchives: RetentionArchive[] = []
) {
    const listedArchives = await listArchives(
        filePath,
        policy,
        approvedRoots,
        simulatedArchives
    );
    const deleteSet = retentionDeleteSet(listedArchives, policy);
    const archives: RetentionArchive[] = [];
    const compressed: string[] = [];
    const warnings: string[] = [];
    for (const archive of listedArchives) {
        if (deleteSet.has(archive.path)) {
            archives.push(archive);
            continue;
        }
        const result = await compressArchiveIfNeeded(archive, dryRun, approvedRoots);
        archives.push(result.archive);
        if (result.compressed) compressed.push(result.archive.path);
        if (result.warning) warnings.push(result.warning);
    }
    archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const deleted: string[] = [];
    for (const archive of deleteSet.values()) {
        deleted.push(archive.path);
        if (!dryRun) await unlinkVerified(archive.path, approvedRoots);
    }
    return { deleted, compressed, warnings };
}

function archiveRetentionKey(archivePath: string, policy: LogRotationPolicy): string {
    if (policy.archiveRetentionScope === "basename") {
        const basename = archiveFamilyBasename(archivePath);
        return path.join(path.dirname(archivePath), basename);
    }
    if (policy.archiveRetentionScope === "parent") {
        return path.dirname(path.dirname(archivePath));
    }
    return path.dirname(archivePath);
}

async function listArchiveOnlyArchives(
    policy: LogRotationPolicy,
    approvedRoots: string[]
) {
    const minAgeMs =
        Number.isFinite(Number(policy.archiveMinAgeMinutes)) &&
        Number(policy.archiveMinAgeMinutes) > 0
            ? Number(policy.archiveMinAgeMinutes) * 60 * 1000
            : 0;
    const cutoff = Date.now() - minAgeMs;
    const archives = new Map<
        string,
        { path: string; mtimeMs: number; compress: boolean }
    >();
    const warnings: string[] = [];

    for (const pattern of policy.archivePaths as string[]) {
        for (const archivePath of await resolveGlob(pattern, {
            missingOk: Boolean(policy.missingOk),
        })) {
            try {
                const safe = await assertSafePath(archivePath, approvedRoots);
                if (safe) {
                    const stat = await fs.stat(archivePath);
                    if (stat.mtimeMs <= cutoff) {
                        archives.set(archivePath, {
                            path: archivePath,
                            mtimeMs: stat.mtimeMs,
                            compress: policy.compress !== false,
                        });
                    }
                } else {
                    warnings.push(
                        `Skipping archive-only path ${archivePath}: Unsafe path outside approved roots`
                    );
                }
            } catch (error) {
                warnings.push(
                    `Skipping archive-only path ${archivePath}: ${caughtMessage(error)}`
                );
            }
        }
    }

    return {
        archives: archives
            .values()
            .toArray()
            .sort((a, b) => b.mtimeMs - a.mtimeMs),
        warnings,
    };
}

async function applyArchiveOnlyRetention(
    policy: LogRotationPolicy,
    approvedRoots: string[],
    dryRun: boolean
) {
    const archivesByScope = new Map<string, RetentionArchive[]>();
    const compressed: string[] = [];
    const deleted: string[] = [];
    const warnings: string[] = [];
    let checked = 0;

    const listed = await listArchiveOnlyArchives(policy, approvedRoots);
    warnings.push(...listed.warnings);

    for (const archive of listed.archives) {
        checked += 1;
        const key = archiveRetentionKey(archive.path, policy);
        const scoped = archivesByScope.get(key) || [];
        scoped.push(archive);
        archivesByScope.set(key, scoped);
    }

    for (const archives of archivesByScope.values()) {
        archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const deleteSet = retentionDeleteSet(archives, policy);
        for (const archive of archives) {
            if (!deleteSet.has(archive.path)) {
                try {
                    const result = await archiveOnlyCompressArchiveIfNeeded(
                        archive,
                        dryRun,
                        approvedRoots
                    );
                    if (result.compressed) compressed.push(result.archive.path);
                    if (result.warning) warnings.push(result.warning);
                } catch (error) {
                    warnings.push(
                        `Failed to compress archive-only path ${archive.path}: ${caughtMessage(
                            error
                        )}`
                    );
                }
            }
        }
        for (const archive of deleteSet.values()) {
            if (dryRun) {
                deleted.push(archive.path);
            } else {
                try {
                    await archiveOnlyUnlinkVerified(archive.path, approvedRoots);
                    deleted.push(archive.path);
                } catch (error) {
                    warnings.push(
                        `Failed to delete archive-only path ${archive.path}: ${caughtMessage(
                            error
                        )}`
                    );
                }
            }
        }
    }

    return { checked, compressed, deleted, warnings };
}

function hasRotatedInCadence(
    stateEntry: undefined | { lastRotatedAt?: string },
    cadence: "daily" | "weekly" | null
): boolean {
    if (!cadence || !stateEntry?.lastRotatedAt) return false;
    const lastDate = new Date(stateEntry.lastRotatedAt);
    const last = lastDate.getTime();
    if (!Number.isFinite(last)) return false;
    if (cadence === "daily") {
        const now = new Date();
        return (
            lastDate.getFullYear() === now.getFullYear() &&
            lastDate.getMonth() === now.getMonth() &&
            lastDate.getDate() === now.getDate()
        );
    }
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - last < windowMs;
}

function shouldRotate({
    stat,
    policy,
    stateEntry,
}: {
    stat: { size: number };
    policy: LogRotationPolicy;
    stateEntry: undefined | { lastRotatedAt?: string };
}) {
    const maxBytes = byteLimitFromMb(policy.maxSizeMb);
    const overSize = maxBytes !== null && stat.size >= maxBytes;
    const cadence = policy.weekly ? "weekly" : policy.daily ? "daily" : null;
    const cadenceDue = Boolean(cadence && !hasRotatedInCadence(stateEntry, cadence));
    return {
        rotate: overSize || cadenceDue,
        reason: overSize ? "maxSize" : cadenceDue ? cadence : "notDue",
    };
}

function emptyState(): LogRotationState {
    return { version: 1, files: {} };
}

function readLogRotationState(): LogRotationState {
    const row = db
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(STATE_CACHE_KEY) as undefined | { data_json?: string | null };
    if (!row?.data_json) {
        return emptyState();
    }
    try {
        const parsed = JSON.parse(row.data_json) as Partial<LogRotationState>;
        return {
            version: 1,
            files:
                parsed.files &&
                typeof parsed.files === "object" &&
                !Array.isArray(parsed.files)
                    ? parsed.files
                    : {},
            ...(parsed.lastRun &&
                typeof parsed.lastRun === "object" && {
                    lastRun: parsed.lastRun as Record<string, unknown>,
                }),
        };
    } catch {
        return emptyState();
    }
}

function summarizeGroup(name: string) {
    return {
        name,
        checkedFiles: 0,
        rotatedFiles: 0,
        compressedFiles: 0,
        deletedArchives: 0,
        skippedFiles: 0,
    };
}

function appendRetentionWarnings(
    summary: LogRotationSummary,
    warnings: string[],
    context: { filePath?: string; group?: string }
): void {
    for (const warning of warnings) {
        summary.warnings.push({
            ...context,
            message: warning,
        });
    }
}

function applySkippedRetention(
    summary: LogRotationSummary,
    groupSummary: ReturnType<typeof summarizeGroup>,
    retained: Awaited<ReturnType<typeof applyRetention>>,
    filePath: string
): void {
    groupSummary.deletedArchives += retained.deleted.length;
    summary.deletedArchives += retained.deleted.length;
    groupSummary.compressedFiles += retained.compressed.length;
    summary.compressedFiles += retained.compressed.length;
    appendRetentionWarnings(summary, retained.warnings, { filePath });
    groupSummary.skippedFiles += 1;
    summary.skippedFiles += 1;
}

export interface LogRotationSummary {
    ok: boolean;
    dryRun: boolean;
    startedAt: string;
    finishedAt: string | null;
    checkedGroups: number;
    checkedFiles: number;
    rotatedFiles: number;
    compressedFiles: number;
    deletedArchives: number;
    skippedFiles: number;
    warnings: unknown[];
    errors: unknown[];
    groups: Array<ReturnType<typeof summarizeGroup>>;
    files?: unknown[];
}

export interface ElevatedLogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

async function acquireLogRotationLock(dryRun: boolean) {
    if (dryRun) return null;
    const lockFile = logRotationLockFile;
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const openLock = async () => {
        const handle = await fs.open(lockFile, "wx");
        try {
            await handle.writeFile(`${process.pid}\n`);
            return handle;
        } catch (error) {
            await ignoreRejection(handle.close());
            await ignoreRejection(fs.unlink(lockFile));
            throw error;
        }
    };
    try {
        return await openLock();
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
            return reclaimStaleLogRotationLock(lockFile, openLock);
        }
        throw error;
    }
}

async function reclaimStaleLogRotationLock(
    lockFile: string,
    openLock: () => Promise<fs.FileHandle>
) {
    const reclaimDir = `${lockFile}.reclaim`;
    try {
        await fs.mkdir(reclaimDir);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
            if (!(await removeStaleReclaimDir(reclaimDir))) {
                return null;
            }
            try {
                await fs.mkdir(reclaimDir);
            } catch (reclaimError) {
                if (
                    reclaimError instanceof Error &&
                    "code" in reclaimError &&
                    (reclaimError as NodeJS.ErrnoException).code === "EEXIST"
                ) {
                    return null;
                }
                throw reclaimError;
            }
        } else {
            throw error;
        }
    }
    try {
        let rawPid = "";
        let lockStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
        try {
            const handle = await fs.open(lockFile, "r");
            try {
                lockStat = await handle.stat();
                rawPid = await handle.readFile("utf8");
            } finally {
                await handle.close();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        const pid = Number(rawPid.trim());
        const lockAgeMs = lockStat ? Date.now() - lockStat.mtimeMs : Infinity;
        if (
            Number.isSafeInteger(pid) &&
            pid > 0 &&
            isProcessRunning(pid) &&
            lockAgeMs < LOCK_STALE_MS
        ) {
            return null;
        }
        await ignoreMissingPath(fs.unlink(lockFile));
        try {
            return await openLock();
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                (error as NodeJS.ErrnoException).code === "EEXIST"
            ) {
                return null;
            }
            throw error;
        }
    } finally {
        await ignoreRejection(fs.rmdir(reclaimDir));
    }
}

async function removeStaleReclaimDir(reclaimDir: string): Promise<boolean> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(reclaimDir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return true;
        }
        throw error;
    }
    if (Date.now() - stat.mtimeMs < RECLAIM_DIR_STALE_MS) return false;
    await fs.rm(reclaimDir, { force: true, recursive: true });
    return true;
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EPERM"
        );
    }
}

async function releaseLogRotationLock(handle: fs.FileHandle | null) {
    if (!handle) return;
    const lockFile = logRotationLockFile;
    try {
        const heldStat = await handle.stat();
        const pathStat = await fs.stat(lockFile);
        if (pathStat && pathStat.dev === heldStat.dev && pathStat.ino === heldStat.ino) {
            await fs.unlink(lockFile);
        }
    } finally {
        await handle.close();
    }
}

export async function runLogRotationService(
    options: LogRotationOptions
): Promise<LogRotationSummary> {
    const startedAt = new Date();
    const config = await loadJsonFile<LogRotationConfig>(
        options.config || defaultConfigPath()
    );
    validateConfig(config);
    const groups = config.groups
        .filter((group) => group.enabled ?? config.defaults?.enabled ?? true)
        .filter((group) => !options.group || group.name === options.group);
    const summary: LogRotationSummary = {
        ok: true,
        dryRun: options.dryRun,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        checkedGroups: groups.length,
        checkedFiles: 0,
        rotatedFiles: 0,
        compressedFiles: 0,
        deletedArchives: 0,
        skippedFiles: 0,
        warnings: [],
        errors: [],
        groups: [],
        ...(options.verbose && { files: [] }),
    };
    const lock = await acquireLogRotationLock(options.dryRun);
    if (!options.dryRun && !lock) {
        summary.ok = false;
        summary.errors.push({ message: "Log rotation is already running" });
        summary.finishedAt = dateToISOString(new Date());
        return summary;
    }
    try {
        const state = readLogRotationState();
        const now = new Date();
        const seenFiles = new Set<string>();
        for (const group of groups) {
            const policy = mergePolicy(config.defaults || {}, group);
            policy.excludePaths = [
                ...(config.excludePaths || []),
                ...(policy.excludePaths || []),
            ];
            const effectiveApprovedRoots =
                policy.approvedRoots ?? config.approvedRoots ?? DEFAULT_APPROVED_ROOTS;
            const groupSummary = summarizeGroup(group.name as string);
            summary.groups.push(groupSummary);
            if (policy.archiveOnly) {
                try {
                    const retained = await applyArchiveOnlyRetention(
                        policy,
                        effectiveApprovedRoots,
                        options.dryRun
                    );
                    groupSummary.checkedFiles += retained.checked;
                    summary.checkedFiles += retained.checked;
                    groupSummary.deletedArchives += retained.deleted.length;
                    summary.deletedArchives += retained.deleted.length;
                    groupSummary.compressedFiles += retained.compressed.length;
                    summary.compressedFiles += retained.compressed.length;
                    appendRetentionWarnings(summary, retained.warnings, {
                        group: group.name,
                    });
                } catch (error) {
                    summary.ok = false;
                    summary.errors.push({
                        group: group.name,
                        message: caughtMessage(error),
                    });
                }
                continue;
            }
            const matched = new Set<string>();
            try {
                for (const pattern of policy.paths!) {
                    for (const file of await resolveGlob(pattern, {
                        missingOk: policy.missingOk,
                    })) {
                        matched.add(file);
                    }
                }
                const excluded = new Set<string>();
                for (const pattern of policy.excludePaths) {
                    for (const file of await resolveGlob(pattern, {
                        missingOk: policy.missingOk,
                    })) {
                        excluded.add(file);
                    }
                }
                for (const filePath of [...matched].sort(compareStrings)) {
                    if (
                        !seenFiles.has(filePath) &&
                        !excluded.has(filePath) &&
                        !ROTATED_SUFFIX_RE.test(filePath)
                    ) {
                        seenFiles.add(filePath);
                        groupSummary.checkedFiles += 1;
                        summary.checkedFiles += 1;
                        try {
                            const safe = await assertSafePath(
                                filePath,
                                effectiveApprovedRoots
                            );
                            if (safe) {
                                const stat = await fs.stat(filePath);
                                const retention = async (
                                    simulatedArchives: RetentionArchive[] = []
                                ) =>
                                    applyRetention(
                                        filePath,
                                        policy,
                                        effectiveApprovedRoots,
                                        options.dryRun,
                                        simulatedArchives
                                    );
                                const decision = shouldRotate({
                                    stat,
                                    policy,
                                    stateEntry: state.files[filePath],
                                });
                                if (policy.skipEmpty && stat.size === 0) {
                                    applySkippedRetention(
                                        summary,
                                        groupSummary,
                                        await retention(),
                                        filePath
                                    );
                                } else if (decision.rotate) {
                                    const archivePath = archiveBasePath(filePath, now);
                                    let rotation: RotationResult;
                                    if (options.dryRun) {
                                        const compressed = policy.compress !== false;
                                        rotation = {
                                            archivePath: compressed
                                                ? `${archivePath}.gz`
                                                : archivePath,
                                            compressed,
                                        };
                                    } else {
                                        const verified = await openVerifiedLogFile(
                                            filePath,
                                            effectiveApprovedRoots
                                        );
                                        try {
                                            rotation =
                                                policy.strategy === "rename"
                                                    ? await rotateRename(
                                                          filePath,
                                                          verified,
                                                          archivePath,
                                                          policy.compress !== false,
                                                          effectiveApprovedRoots
                                                      )
                                                    : await rotateCopyTruncate(
                                                          filePath,
                                                          verified,
                                                          archivePath,
                                                          policy.compress !== false,
                                                          effectiveApprovedRoots
                                                      );
                                        } finally {
                                            await verified.handle.close();
                                        }
                                        state.files[filePath] = {
                                            lastRotatedAt: now.toISOString(),
                                            lastSizeBytes: stat.size,
                                            lastArchive: rotation.archivePath,
                                        };
                                    }
                                    groupSummary.rotatedFiles += 1;
                                    summary.rotatedFiles += 1;
                                    if (rotation.compressed) {
                                        groupSummary.compressedFiles += 1;
                                        summary.compressedFiles += 1;
                                    }
                                    if (rotation.warning) {
                                        summary.warnings.push({
                                            filePath,
                                            message: rotation.warning,
                                        });
                                    }
                                    const simulatedArchives = [
                                        {
                                            path: rotation.archivePath,
                                            mtimeMs: now.getTime(),
                                            compress: false,
                                        },
                                    ];
                                    const retained = await retention(simulatedArchives);
                                    groupSummary.deletedArchives +=
                                        retained.deleted.length;
                                    summary.deletedArchives += retained.deleted.length;
                                    groupSummary.compressedFiles +=
                                        retained.compressed.length;
                                    summary.compressedFiles += retained.compressed.length;
                                    appendRetentionWarnings(summary, retained.warnings, {
                                        filePath,
                                    });
                                } else {
                                    applySkippedRetention(
                                        summary,
                                        groupSummary,
                                        await retention(),
                                        filePath
                                    );
                                }
                            }
                        } catch (error) {
                            summary.ok = false;
                            summary.errors.push({
                                filePath,
                                message: caughtMessage(error),
                            });
                        }
                    }
                }
            } catch (error) {
                summary.ok = false;
                summary.errors.push({
                    group: group.name,
                    message: caughtMessage(error),
                });
            }
        }
        summary.finishedAt = dateToISOString(new Date());
        if (!options.dryRun) {
            state.lastRun = {
                ok: summary.ok,
                dryRun: false,
                startedAt: summary.startedAt,
                finishedAt: summary.finishedAt,
                checkedGroups: summary.checkedGroups,
                checkedFiles: summary.checkedFiles,
                rotatedFiles: summary.rotatedFiles,
                compressedFiles: summary.compressedFiles,
                deletedArchives: summary.deletedArchives,
                skippedFiles: summary.skippedFiles,
                warnings: summary.warnings,
                errors: summary.errors,
                groups: summary.groups,
            };
            try {
                writeLogRotationCacheSuccess({
                    key: STATE_CACHE_KEY,
                    data: state,
                    source: "backend",
                    ttl: 90 * 24,
                    ttlUnit: "hours",
                    metadata: { workflow: "Log Rotation - Foundation" },
                });
            } catch (error) {
                summary.ok = false;
                summary.errors.push({
                    message: `Failed to persist log rotation state: ${caughtMessage(error)}`,
                });
            }
        }
    } finally {
        await releaseLogRotationLock(lock);
    }
    return summary;
}

export async function runElevatedLogRotationService(options: {
    dryRun: boolean;
}): Promise<ElevatedLogRotationResult> {
    const modulePath = fileURLToPath(import.meta.url);
    const args = buildElevatedLogRotationCliArgs(modulePath, options);
    let stderr: string;
    let stdout: string;
    try {
        const output = await elevatedLogRotationExecFileRunner("sudo", args, {
            encoding: "utf8",
            env: elevatedLogRotationEnvironment(),
            maxBuffer: ELEVATED_LOG_ROTATION_MAX_BUFFER,
            timeout: ELEVATED_LOG_ROTATION_TIMEOUT_MS,
        });
        stderr = output.stderr;
        stdout = output.stdout;
    } catch (error) {
        const failedOutput = error as { stderr?: unknown; stdout?: unknown };
        stderr = typeof failedOutput.stderr === "string" ? failedOutput.stderr : "";
        stdout = typeof failedOutput.stdout === "string" ? failedOutput.stdout : "";
        const trimmedFailure = stdout.trim();
        if (trimmedFailure) {
            try {
                return {
                    result: JSON.parse(trimmedFailure) as Record<string, unknown>,
                    stderr,
                };
            } catch {
                // Fall through to a structured failure with the captured output.
            }
        }
        const failureMessage = caughtMessage(error);
        return {
            result: { ok: false, error: failureMessage, stdout: trimmedFailure },
            stderr: stderr ? `${stderr}\n${failureMessage}` : failureMessage,
        };
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
        const error = "Elevated log rotation returned empty JSON output";
        return {
            result: { ok: false, error },
            stderr: stderr ? `${stderr}\n${error}` : error,
        };
    }
    try {
        return {
            result: JSON.parse(trimmed) as Record<string, unknown>,
            stderr,
        };
    } catch (error) {
        const parseError = caughtMessage(error);
        const parseContext = `Failed to parse elevated log rotation JSON: ${parseError}; stdout: ${trimmed}`;
        return {
            result: {
                ok: false,
                error: "Failed to parse elevated log rotation JSON",
                parseError,
                stdout: trimmed,
            },
            stderr: stderr ? `${stderr}\n${parseContext}` : parseContext,
        };
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function logRotationFailureMessage(logRotation: ElevatedLogRotationResult): string {
    if (logRotation.stderr.trim()) {
        return logRotation.stderr.trim();
    }
    const result = asRecord(logRotation.result);
    if (typeof result.error === "string" && result.error.trim()) {
        return result.error.trim();
    }
    if (result.ok === false) {
        const details = {
            errors: Array.isArray(result.errors) ? result.errors : [],
            groups: Array.isArray(result.groups) ? result.groups : [],
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
        };
        if (
            details.errors.length > 0 ||
            details.warnings.length > 0 ||
            details.groups.length > 0
        ) {
            return `Log rotation failed: ${JSON.stringify(details)}`;
        }
    }
    return "Log rotation failed";
}

function capLogRotationFailureOutput(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    if (value.length <= LOG_ROTATION_FAILURE_OUTPUT_MAX_CHARS) {
        return value;
    }
    return value.slice(-LOG_ROTATION_FAILURE_OUTPUT_MAX_CHARS);
}

function readLogRotationStateCacheForFailure(): Record<string, unknown> {
    const fallback = { version: 1, files: {} };
    const row = db
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(STATE_CACHE_KEY) as undefined | { data_json?: string | null };
    if (!row?.data_json) {
        return fallback;
    }
    try {
        return { ...fallback, ...asRecord(JSON.parse(row.data_json) as unknown) };
    } catch {
        return fallback;
    }
}

function persistLogRotationScheduledFailure(
    logRotation: ElevatedLogRotationResult,
    message: string
): void {
    const existingState = readLogRotationStateCacheForFailure();
    const structuredLastRun = asRecord(logRotation.result);
    writeLogRotationCacheSuccess({
        key: STATE_CACHE_KEY,
        data: {
            ...existingState,
            version: 1,
            lastRun: {
                ...structuredLastRun,
                ok: false,
                dryRun: false,
                stdout: capLogRotationFailureOutput(structuredLastRun.stdout),
                finishedAt:
                    typeof structuredLastRun.finishedAt === "string"
                        ? structuredLastRun.finishedAt
                        : dateToISOString(new Date()),
                message,
                stderr: capLogRotationFailureOutput(logRotation.stderr),
            },
        },
        source: "backend",
        ttl: 90 * 24,
        ttlUnit: "hours",
        metadata: { workflow: "Log Rotation - Foundation" },
    });
}

/** Registers the scheduled real log rotation job. */
export function registerLogRotationScheduledJobs(): void {
    registerScheduledJobAction(LOG_ROTATION_JOB_ID, async () => {
        const logRotation = await runElevatedLogRotationService({ dryRun: false });
        if (logRotation.result?.ok !== true) {
            const message = logRotationFailureMessage(logRotation);
            persistLogRotationScheduledFailure(logRotation, message);
            throw new Error(message);
        }
        return { logRotation };
    });
    db.exec("BEGIN");
    try {
        removeScheduledJobsNotInAction(LOG_ROTATION_JOB_ID, [LOG_ROTATION_JOB_ID]);
        const existing = getScheduledJob(LOG_ROTATION_JOB_ID);
        upsertScheduledJob({
            id: LOG_ROTATION_JOB_ID,
            name: "Log rotation",
            description:
                "Rotate approved Docker file logs and update log rotation cache.",
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? "daily",
            intervalSeconds: existing?.intervalSeconds ?? 24 * 60 * 60,
            timeOfDay: existing ? existing.timeOfDay : "02:10",
            cronExpression: existing?.cronExpression ?? null,
            actionKey: LOG_ROTATION_JOB_ID,
            actionPayload: { key: STATE_CACHE_KEY },
        });
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Preserve the registration error.
        }
        throw error;
    }
}

function buildElevatedLogRotationCliArgs(
    modulePath: string,
    options: { dryRun?: boolean } = {}
): string[] {
    const importLogRotationCli = [
        `import { runLogRotationCli } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
        "await runLogRotationCli();",
    ].join("\n");
    return [
        "-n",
        "-E",
        BUN_EXECUTABLE,
        "--input-type=module",
        "--eval",
        importLogRotationCli,
        "--",
        "--json",
        ...(options.dryRun ? ["--dry-run"] : []),
    ];
}

function elevatedLogRotationEnvironment(): NodeJS.ProcessEnv {
    const allowed = [
        "PATH",
        "HOME",
        "LANG",
        "NODE_ENV",
        "TZ",
        "MIRA_DASHBOARD_DB_PATH",
        "MIRA_LOG_ROTATION_CONFIG",
    ];
    const env: NodeJS.ProcessEnv = {};
    // Keep sudo -E narrow: only runtime lookup, home/locale, mode, and config path.
    for (const key of allowed) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key];
        }
    }
    return env;
}

export async function runLogRotationCli(): Promise<void> {
    try {
        const summary = await runLogRotationService({
            config: process.env.MIRA_LOG_ROTATION_CONFIG,
            dryRun: process.argv.includes("--dry-run"),
        });
        if (process.argv.includes("--json")) {
            process.stdout.write(`${JSON.stringify(summary)}\n`);
        }
        if (!summary.ok) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(caughtMessage(error));
        process.exitCode = 1;
    }
}
