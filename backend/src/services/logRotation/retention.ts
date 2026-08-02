import fs from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../../lib/errors.ts";
import type { LogRotationPolicy } from "./config.ts";
import {
    escapeRegExp,
    resolveLogGlob as resolveGlob,
} from "./globResolver.ts";
import { assertSafePath, gzipFile, unlinkVerified } from "./safeFiles.ts";

const ARCHIVE_FAMILY_SUFFIX_RE =
    /(?:\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z|\.\d+)(?:\.gz)?$/u;

export type RetentionArchive = {
    path: string;
    mtimeMs: number;
    shouldCompress: boolean;
};

function caughtMessage(error: unknown): string {
    return errorMessage(error, "Log rotation failed");
}

function archiveFamilyBasename(archivePath: string): string {
    return path.basename(archivePath).replace(ARCHIVE_FAMILY_SUFFIX_RE, "");
}

function managedArchiveRegexFor(filePath: string): RegExp {
    return new RegExp(
        String.raw`^${escapeRegExp(path.basename(filePath))}\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:\.gz)?$`
    );
}

function isArchiveMatchRetentionScope(
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

async function sameResolvedPath(
    firstPath: string,
    secondPath: string
): Promise<boolean> {
    if (path.resolve(firstPath) === path.resolve(secondPath)) {
        return true;
    }
    return (await fs.realpath(firstPath)) === (await fs.realpath(secondPath));
}

async function addConfiguredArchiveIfInRetentionScope(
    archives: RetentionArchive[],
    archivePath: string,
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[]
): Promise<void> {
    if (
        !isArchiveMatchRetentionScope(filePath, archivePath, policy) ||
        !(await assertSafePath(archivePath, approvedRoots)) ||
        (await sameResolvedPath(archivePath, filePath))
    ) {
        return;
    }
    const stat = await fs.stat(archivePath);
    archives.push({
        path: archivePath,
        mtimeMs: stat.mtimeMs,
        shouldCompress:
            policy.shouldCompress ?? policy.compress ?? true,
    });
}

async function listArchives(
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[],
    simulatedArchives: RetentionArchive[] = []
): Promise<RetentionArchive[]> {
    const directory = path.dirname(filePath);
    const managedRegex = managedArchiveRegexFor(filePath);
    const archives: RetentionArchive[] = [...simulatedArchives];
    const directoryEntries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of directoryEntries) {
        if (!(entry.isFile() && managedRegex.test(entry.name))) {
            continue;
        }
        const fullPath = path.join(directory, entry.name);
        const stat = await fs.stat(fullPath);
        archives.push({
            path: fullPath,
            mtimeMs: stat.mtimeMs,
            shouldCompress:
                (policy.shouldCompress ?? policy.compress ?? true) &&
                !isGzipArchivePath(fullPath),
        });
    }
    for (const pattern of policy.archivePaths ?? []) {
        const archivePaths = await resolveGlob(pattern, {
            missingOk: Boolean(policy.missingOk),
        });
        for (const archivePath of archivePaths) {
            await addConfiguredArchiveIfInRetentionScope(
                archives,
                archivePath,
                filePath,
                policy,
                approvedRoots
            );
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
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

async function compressArchiveIfNeeded(
    archive: RetentionArchive,
    isDryRun: boolean,
    approvedRoots: string[]
): Promise<{ archive: RetentionArchive; compressed: boolean; warning?: string }> {
    if (!archive.shouldCompress || archive.path.endsWith(".gz")) {
        return { archive, compressed: false };
    }
    const gzPath = `${archive.path}.gz`;
    if (isDryRun) {
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

function retentionDeleteSet(
    archives: RetentionArchive[],
    policy: LogRotationPolicy
): Map<string, RetentionArchive> {
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

export async function applyRetention(
    filePath: string,
    policy: LogRotationPolicy,
    approvedRoots: string[],
    isDryRun: boolean,
    simulatedArchives: RetentionArchive[] = []
): Promise<{ deleted: string[]; compressed: string[]; warnings: string[] }> {
    const listedArchives = await listArchives(
        filePath,
        policy,
        approvedRoots,
        simulatedArchives
    );
    const deleteSet = retentionDeleteSet(listedArchives, policy);
    const compressed: string[] = [];
    const warnings: string[] = [];
    for (const archive of listedArchives) {
        if (deleteSet.has(archive.path)) {
            continue;
        }
        const result = await compressArchiveIfNeeded(
            archive,
            isDryRun,
            approvedRoots
        );
        if (result.compressed) compressed.push(result.archive.path);
        if (result.warning) warnings.push(result.warning);
    }
    const deleted: string[] = [];
    for (const archive of deleteSet.values()) {
        deleted.push(archive.path);
        if (!isDryRun) await unlinkVerified(archive.path, approvedRoots);
    }
    return { deleted, compressed, warnings };
}

function archiveRetentionKey(
    archivePath: string,
    policy: LogRotationPolicy
): string {
    if (policy.archiveRetentionScope === "basename") {
        return path.join(
            path.dirname(archivePath),
            archiveFamilyBasename(archivePath)
        );
    }
    if (policy.archiveRetentionScope === "parent") {
        return path.dirname(path.dirname(archivePath));
    }
    return path.dirname(archivePath);
}

async function listArchiveOnlyArchives(
    policy: LogRotationPolicy,
    approvedRoots: string[]
): Promise<{ archives: RetentionArchive[]; warnings: string[] }> {
    const minAgeMs =
        Number.isFinite(Number(policy.archiveMinAgeMinutes)) &&
        Number(policy.archiveMinAgeMinutes) > 0
            ? Number(policy.archiveMinAgeMinutes) * 60 * 1000
            : 0;
    const cutoff = Date.now() - minAgeMs;
    const archives = new Map<string, RetentionArchive>();
    const warnings: string[] = [];
    for (const pattern of policy.archivePaths as string[]) {
        const archivePaths = await resolveGlob(pattern, {
            missingOk: Boolean(policy.missingOk),
        });
        for (const archivePath of archivePaths) {
            try {
                const safe = await assertSafePath(archivePath, approvedRoots);
                if (safe) {
                    const stat = await fs.stat(archivePath);
                    if (stat.mtimeMs <= cutoff) {
                        archives.set(archivePath, {
                            path: archivePath,
                            mtimeMs: stat.mtimeMs,
                            shouldCompress:
                                policy.shouldCompress ?? policy.compress ?? true,
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
            .toSorted((a, b) => b.mtimeMs - a.mtimeMs),
        warnings,
    };
}

export async function applyArchiveOnlyRetention(
    policy: LogRotationPolicy,
    approvedRoots: string[],
    isDryRun: boolean
): Promise<{
    isChecked: number;
    compressed: string[];
    deleted: string[];
    warnings: string[];
}> {
    const archivesByScope = new Map<string, RetentionArchive[]>();
    const compressed: string[] = [];
    const deleted: string[] = [];
    const warnings: string[] = [];
    let checkedCount = 0;
    const listed = await listArchiveOnlyArchives(policy, approvedRoots);
    warnings.push(...listed.warnings);

    for (const archive of listed.archives) {
        checkedCount += 1;
        const key = archiveRetentionKey(archive.path, policy);
        const scoped = archivesByScope.get(key) || [];
        scoped.push(archive);
        archivesByScope.set(key, scoped);
    }
    for (const archives of archivesByScope.values()) {
        const sortedArchives = archives.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
        const deleteSet = retentionDeleteSet(sortedArchives, policy);
        for (const archive of sortedArchives) {
            if (!deleteSet.has(archive.path)) {
                try {
                    const result = await compressArchiveIfNeeded(
                        archive,
                        isDryRun,
                        approvedRoots
                    );
                    if (result.compressed) compressed.push(result.archive.path);
                    if (result.warning) warnings.push(result.warning);
                } catch (error) {
                    warnings.push(
                        `Failed to shouldCompress archive-only path ${archive.path}: ${caughtMessage(
                            error
                        )}`
                    );
                }
            }
        }
        for (const archive of deleteSet.values()) {
            if (isDryRun) {
                deleted.push(archive.path);
            } else {
                try {
                    await unlinkVerified(archive.path, approvedRoots);
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
    return { isChecked: checkedCount, compressed, deleted, warnings };
}

export function hasRotatedInCadence(
    stateEntry: undefined | { lastRotatedAt?: string },
    cadence: "daily" | "weekly" | undefined
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
    return Date.now() - last < 7 * 24 * 60 * 60 * 1000;
}

export function rotationCadence(
    policy: LogRotationPolicy
): "daily" | "weekly" | undefined {
    if (policy.weekly) {
        return "weekly";
    }
    return policy.daily ? "daily" : undefined;
}
