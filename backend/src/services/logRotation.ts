import { constants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { db } from "../db.js";
import { nonEmptyEnvFallback } from "../lib/values.js";
import { writeCacheSuccess } from "./cacheRefresh.js";

const STATE_CACHE_KEY = "log_rotation.state";
const DEFAULT_CONFIG_PATH = nonEmptyEnvFallback(
    "MIRA_LOG_ROTATION_CONFIG",
    path.resolve(process.cwd(), "config/log-rotation.json")
);
const DEFAULT_APPROVED_ROOTS = ["/opt/docker/data"];
const ROTATED_SUFFIX_RE = /\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:\.gz)?$/u;

function caughtMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

interface LogRotationConfig {
    version: number;
    approvedRoots?: string[];
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
    if (config.version !== 1) {
        throw new Error("Config version must be 1");
    }
    if (!Array.isArray(config.groups)) {
        throw new TypeError("Config groups must be an array");
    }
    for (const group of config.groups) {
        if (!group.name || typeof group.name !== "string") {
            throw new Error("Every group needs a string name");
        }
        const hasPaths = Array.isArray(group.paths) && group.paths.length > 0;
        const hasArchivePaths =
            Array.isArray(group.archivePaths) && group.archivePaths.length > 0;
        if (!hasPaths && !hasArchivePaths) {
            throw new Error(
                `Group ${group.name} needs at least one path pattern or archivePaths pattern`
            );
        }
        if (
            group.strategy !== undefined &&
            group.strategy !== "copytruncate" &&
            group.strategy !== "rename"
        ) {
            throw new Error(`Group ${group.name} has unsupported strategy`);
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function globToRegex(pattern: string): RegExp {
    const normalized = pattern.split(path.sep).join("/");
    return new RegExp(`^${normalized.split("*").map(escapeRegExp).join("[^/]*")}$`);
}

function segmentRegex(segment: string): RegExp {
    return new RegExp(`^${segment.split("*").map(escapeRegExp).join(".*")}$`);
}

async function resolveGlob(pattern: string): Promise<string[]> {
    const absolutePattern = path.resolve(pattern);
    const segments = absolutePattern.split(path.sep).filter(Boolean);
    let candidates: string[] = [path.sep];

    for (const [index, segment] of segments.entries()) {
        const hasWildcard = segment.includes("*");
        const isLastSegment = index === segments.length - 1;
        const regex = hasWildcard ? segmentRegex(segment) : null;
        const nextCandidates: string[] = [];

        for (const candidate of candidates) {
            if (!hasWildcard) {
                nextCandidates.push(path.join(candidate, segment));
                continue;
            }
            let entries: Array<import("node:fs").Dirent>;
            try {
                entries = await fs.readdir(candidate, { withFileTypes: true });
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
                ) {
                    continue;
                }
                throw error;
            }
            for (const entry of entries) {
                if (entry.isSymbolicLink() || !regex?.test(entry.name)) continue;
                if (!isLastSegment && !entry.isDirectory()) continue;
                nextCandidates.push(path.join(candidate, entry.name));
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
            if (
                error instanceof Error &&
                "code" in error &&
                ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
            ) {
                continue;
            }
            throw error;
        }
    }
    const regex = globToRegex(absolutePattern);
    return files.filter((file) => regex.test(file.split(path.sep).join("/")));
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
            } catch {
                return null;
            }
        })
    );
    const realRoots = resolvedRoots.filter((root): root is string => root !== null);
    if (realRoots.length === 0) {
        throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
    }
    if (!realRoots.some((root) => isUnderRoot(realFilePath, root))) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
    const lstat = await fs.lstat(filePath);
    if (lstat.isSymbolicLink()) throw new Error(`Refusing symlink path: ${filePath}`);
    if (!lstat.isFile()) throw new Error(`Refusing non-file path: ${filePath}`);
    return true;
}

async function openVerifiedLogFile(
    filePath: string,
    approvedRoots: string[]
): Promise<VerifiedLogFile> {
    const handle = await fs.open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
            throw new Error(`Refusing non-file path: ${filePath}`);
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
        if (!realRoots.some((root) => isUnderRoot(realFilePath, root))) {
            throw new Error(`Unsafe path outside approved roots: ${filePath}`);
        }
        const currentStat = await fs.stat(filePath);
        if (stat.dev !== currentStat.dev || stat.ino !== currentStat.ino) {
            throw new Error(`Unsafe path changed before rotation: ${filePath}`);
        }
        return { handle, stat };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

function archiveBasePath(filePath: string, now: Date): string {
    const stamp = now
        .toISOString()
        .replaceAll(/[:.]/gu, "-")
        .replace(/-\d{3}Z$/u, "Z");
    return `${filePath}.${stamp}`;
}

async function gzipFile(filePath: string): Promise<string> {
    const gzPath = `${filePath}.gz`;
    await pipeline(
        createReadStream(filePath),
        createGzip(),
        createWriteStream(gzPath, { flags: "wx" })
    );
    await fs.unlink(filePath);
    return gzPath;
}

async function rotateCopyTruncate(
    file: VerifiedLogFile,
    archivePath: string,
    compress: boolean
): Promise<string> {
    await pipeline(
        createReadStream("", { fd: file.handle.fd, autoClose: false, start: 0 }),
        createWriteStream(archivePath, { flags: "wx" })
    );
    await file.handle.truncate(0);
    return compress ? gzipFile(archivePath) : archivePath;
}

async function rotateRename(
    filePath: string,
    file: VerifiedLogFile,
    archivePath: string,
    compress: boolean
): Promise<string> {
    await fs.rename(filePath, archivePath);
    await fs.writeFile(filePath, "", { mode: file.stat.mode & 0o777 });
    return compress ? gzipFile(archivePath) : archivePath;
}

function managedArchiveRegexFor(filePath: string): RegExp {
    return new RegExp(
        String.raw`^${escapeRegExp(path.basename(filePath))}\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:\.gz)?$`
    );
}

async function listArchives(
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[]
) {
    const dir = path.dirname(filePath);
    const managedRegex = managedArchiveRegexFor(filePath);
    const archives: Array<{ path: string; mtimeMs: number; compress: boolean }> = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !managedRegex.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const stat = await fs.stat(fullPath);
        archives.push({ path: fullPath, mtimeMs: stat.mtimeMs, compress: false });
    }
    for (const pattern of policy.archivePaths ?? []) {
        for (const archivePath of await resolveGlob(pattern)) {
            if (path.dirname(archivePath) !== dir) continue;
            const safe = await assertSafePath(archivePath, approvedRoots);
            if (!safe) continue;
            const stat = await fs.stat(archivePath);
            archives.push({ path: archivePath, mtimeMs: stat.mtimeMs, compress: true });
        }
    }
    return [...new Map(archives.map((archive) => [archive.path, archive])).values()].sort(
        (a, b) => b.mtimeMs - a.mtimeMs
    );
}

async function compressArchiveIfNeeded(
    archive: { path: string; mtimeMs: number; compress: boolean },
    dryRun: boolean
) {
    if (!archive.compress || archive.path.endsWith(".gz")) {
        return { archive, compressed: false };
    }
    const gzPath = `${archive.path}.gz`;
    if (dryRun) {
        return { archive: { ...archive, path: gzPath }, compressed: true };
    }
    return {
        archive: { ...archive, path: await gzipFile(archive.path) },
        compressed: true,
    };
}

async function applyRetention(
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[],
    dryRun: boolean
) {
    const archives: Array<{ path: string; mtimeMs: number; compress: boolean }> = [];
    const compressed: string[] = [];
    for (const archive of await listArchives(filePath, policy, approvedRoots)) {
        const result = await compressArchiveIfNeeded(archive, dryRun);
        archives.push(result.archive);
        if (result.compressed) compressed.push(result.archive.path);
    }
    archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const deleteSet = new Map<string, { path: string; mtimeMs: number }>();
    if (Number.isInteger(policy.keep) && Number(policy.keep) >= 0) {
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
    const deleted: string[] = [];
    for (const archive of deleteSet.values()) {
        deleted.push(archive.path);
        if (!dryRun) await fs.unlink(archive.path);
    }
    return { deleted, compressed };
}

function archiveRetentionKey(archivePath: string, policy: LogRotationPolicy): string {
    if (policy.archiveRetentionScope === "basename") {
        const basename = path.basename(archivePath).replace(ROTATED_SUFFIX_RE, "");
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

    for (const pattern of policy.archivePaths as string[]) {
        for (const archivePath of await resolveGlob(pattern)) {
            const safe = await assertSafePath(archivePath, approvedRoots);
            if (!safe) continue;
            const stat = await fs.stat(archivePath);
            if (stat.mtimeMs > cutoff) continue;
            archives.set(archivePath, {
                path: archivePath,
                mtimeMs: stat.mtimeMs,
                compress: policy.compress !== false,
            });
        }
    }

    return [...archives.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function applyArchiveOnlyRetention(
    policy: LogRotationPolicy,
    approvedRoots: string[],
    dryRun: boolean
) {
    const archivesByScope = new Map<
        string,
        Array<{ path: string; mtimeMs: number; compress: boolean }>
    >();
    const compressed: string[] = [];
    const deleted: string[] = [];

    for (const archive of await listArchiveOnlyArchives(policy, approvedRoots)) {
        const result = await compressArchiveIfNeeded(archive, dryRun);
        if (result.compressed) compressed.push(result.archive.path);
        const key = archiveRetentionKey(result.archive.path, policy);
        const scoped = archivesByScope.get(key) || [];
        scoped.push(result.archive);
        archivesByScope.set(key, scoped);
    }

    for (const archives of archivesByScope.values()) {
        archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const deleteSet = new Map<string, { path: string; mtimeMs: number }>();
        if (Number.isInteger(policy.keep) && Number(policy.keep) >= 0) {
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
        for (const archive of deleteSet.values()) {
            deleted.push(archive.path);
            if (!dryRun) await fs.unlink(archive.path);
        }
    }

    return { checked: compressed.length + deleted.length, compressed, deleted };
}

function hasRotatedInCadence(
    stateEntry: { lastRotatedAt?: string } | undefined,
    cadence: "daily" | "weekly" | null
): boolean {
    if (!cadence || !stateEntry?.lastRotatedAt) return false;
    const last = new Date(stateEntry.lastRotatedAt).getTime();
    if (!Number.isFinite(last)) return false;
    const windowMs = cadence === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return Date.now() - last < windowMs;
}

function shouldRotate({
    stat,
    policy,
    stateEntry,
}: {
    stat: { size: number };
    policy: LogRotationPolicy;
    stateEntry: { lastRotatedAt?: string } | undefined;
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
        .get(STATE_CACHE_KEY) as { data_json?: string | null } | undefined;
    if (!row?.data_json) {
        return emptyState();
    }
    try {
        const parsed = JSON.parse(row.data_json) as Partial<LogRotationState>;
        return {
            version: parsed.version === 1 ? 1 : 1,
            files:
                parsed.files &&
                typeof parsed.files === "object" &&
                !Array.isArray(parsed.files)
                    ? parsed.files
                    : {},
            ...(parsed.lastRun && typeof parsed.lastRun === "object"
                ? { lastRun: parsed.lastRun as Record<string, unknown> }
                : {}),
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

export async function runLogRotationService(
    options: LogRotationOptions
): Promise<LogRotationSummary> {
    const startedAt = new Date();
    const config = await loadJsonFile<LogRotationConfig>(
        options.config || DEFAULT_CONFIG_PATH
    );
    validateConfig(config);
    const state = readLogRotationState();
    const approvedRoots = config.approvedRoots || DEFAULT_APPROVED_ROOTS;
    const groups = config.groups
        .filter((group) => group.enabled !== false)
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
        ...(options.verbose ? { files: [] } : {}),
    };
    const now = new Date();
    const seenFiles = new Set<string>();
    for (const group of groups) {
        const policy = mergePolicy(config.defaults || {}, group);
        const groupSummary = summarizeGroup(group.name as string);
        summary.groups.push(groupSummary);
        if (policy.archiveOnly) {
            try {
                const retained = await applyArchiveOnlyRetention(
                    policy,
                    approvedRoots,
                    options.dryRun
                );
                groupSummary.checkedFiles += retained.checked;
                summary.checkedFiles += retained.checked;
                groupSummary.deletedArchives += retained.deleted.length;
                summary.deletedArchives += retained.deleted.length;
                groupSummary.compressedFiles += retained.compressed.length;
                summary.compressedFiles += retained.compressed.length;
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
        for (const pattern of group.paths ?? []) {
            for (const file of await resolveGlob(pattern)) matched.add(file);
        }
        const excluded = new Set<string>();
        for (const pattern of group.excludePaths || []) {
            for (const file of await resolveGlob(pattern)) excluded.add(file);
        }
        for (const filePath of [...matched].sort()) {
            if (
                seenFiles.has(filePath) ||
                excluded.has(filePath) ||
                ROTATED_SUFFIX_RE.test(filePath)
            ) {
                continue;
            }
            seenFiles.add(filePath);
            groupSummary.checkedFiles += 1;
            summary.checkedFiles += 1;
            try {
                const safe = await assertSafePath(filePath, approvedRoots);
                if (!safe) continue;
                const stat = await fs.stat(filePath);
                const retention = async () =>
                    applyRetention(filePath, policy, approvedRoots, options.dryRun);
                if (policy.skipEmpty && stat.size === 0) {
                    const retained = await retention();
                    groupSummary.deletedArchives += retained.deleted.length;
                    summary.deletedArchives += retained.deleted.length;
                    groupSummary.compressedFiles += retained.compressed.length;
                    summary.compressedFiles += retained.compressed.length;
                    groupSummary.skippedFiles += 1;
                    summary.skippedFiles += 1;
                    continue;
                }
                const decision = shouldRotate({
                    stat,
                    policy,
                    stateEntry: state.files[filePath],
                });
                if (!decision.rotate) {
                    const retained = await retention();
                    groupSummary.deletedArchives += retained.deleted.length;
                    summary.deletedArchives += retained.deleted.length;
                    groupSummary.compressedFiles += retained.compressed.length;
                    summary.compressedFiles += retained.compressed.length;
                    groupSummary.skippedFiles += 1;
                    summary.skippedFiles += 1;
                    continue;
                }
                const archivePath = archiveBasePath(filePath, now);
                let finalArchive: string;
                if (options.dryRun) {
                    finalArchive = policy.compress ? `${archivePath}.gz` : archivePath;
                } else {
                    const verified = await openVerifiedLogFile(filePath, approvedRoots);
                    try {
                        finalArchive =
                            policy.strategy === "rename"
                                ? await rotateRename(
                                      filePath,
                                      verified,
                                      archivePath,
                                      policy.compress !== false
                                  )
                                : await rotateCopyTruncate(
                                      verified,
                                      archivePath,
                                      policy.compress !== false
                                  );
                    } finally {
                        await verified.handle.close();
                    }
                    state.files[filePath] = {
                        lastRotatedAt: now.toISOString(),
                        lastSizeBytes: stat.size,
                        lastArchive: finalArchive,
                    };
                }
                groupSummary.rotatedFiles += 1;
                summary.rotatedFiles += 1;
                if (policy.compress !== false) {
                    groupSummary.compressedFiles += 1;
                    summary.compressedFiles += 1;
                }
                const retained = await retention();
                groupSummary.deletedArchives += retained.deleted.length;
                summary.deletedArchives += retained.deleted.length;
                groupSummary.compressedFiles += retained.compressed.length;
                summary.compressedFiles += retained.compressed.length;
            } catch (error) {
                summary.ok = false;
                summary.errors.push({
                    filePath,
                    message: caughtMessage(error),
                });
            }
        }
    }
    summary.finishedAt = new Date().toISOString();
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
        writeCacheSuccess({
            key: STATE_CACHE_KEY,
            data: state,
            source: "backend",
            ttl: 90 * 24,
            ttlUnit: "hours",
            metadata: { workflow: "Log Rotation - Foundation" },
        });
    }
    return summary;
}

export const __testing = {
    archiveRetentionKey,
    assertSafePath,
    byteLimitFromMb,
    globToRegex,
    hasRotatedInCadence,
    listArchives,
    mergePolicy,
    openVerifiedLogFile,
    readLogRotationState,
    resolveGlob,
    shouldRotate,
    caughtMessage,
};
