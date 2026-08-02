import fs from "node:fs/promises";
import path from "node:path";

import type { LogRotationSummary as LogRotationContractSummary } from "../../../../contracts/logRotation.ts";
import { errorMessage } from "../../lib/errors.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { getProcessReleaseRoot } from "../releases/runtimeReleaseIdentity.ts";
import {
    byteLimitFromMb,
    type LogRotationOptions,
    type LogRotationPolicy,
    loadLogRotationConfig,
    mergePolicy,
    shouldCompressPolicy,
    validateLogRotationConfig,
} from "./config.ts";
import { resolveLogGlob as resolveGlob } from "./globResolver.ts";
import { acquireLogRotationLock, releaseLogRotationLock } from "./lock.ts";
import {
    applyArchiveOnlyRetention,
    applyRetention,
    hasRotatedInCadence,
    rotationCadence,
    type RetentionArchive,
} from "./retention.ts";
import {
    archiveBasePath,
    assertSafePath,
    openVerifiedLogFile,
    rotateCopyTruncate,
    rotateRename,
    type RotationResult,
} from "./safeFiles.ts";
import {
    dateToISOString,
    LOG_ROTATION_STATE_KEY,
    type LogRotationState,
    readLogRotationState,
} from "./state.ts";

function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

const DEFAULT_CONFIG_PATH = path.join(
    getProcessReleaseRoot(),
    "backend/config/log-rotation.json"
);
const DEFAULT_APPROVED_ROOTS = ["/opt/docker/data"];
const ROTATED_SUFFIX_RE = /\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:\.gz)?$/u;
const writeLogRotationCacheSuccess = writeCacheSuccess;

function caughtMessage(error: unknown): string {
    return errorMessage(error, "Log rotation failed");
}

/**
 * Describes why a file should or should not rotate.
 *
 * @param isOverSize - Whether the file exceeds its size threshold.
 * @param isCadenceDue - Whether its configured cadence elapsed.
 * @param cadence - Configured cadence.
 * @returns Rotation decision reason.
 */
function rotationReason(
    isOverSize: boolean,
    isCadenceDue: boolean,
    cadence: "daily" | "weekly" | undefined
): "daily" | "maxSize" | "notDue" | "weekly" {
    if (isOverSize) {
        return "maxSize";
    }
    if (isCadenceDue) {
        return cadence ?? "notDue";
    }
    return "notDue";
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
    const isOverSize = maxBytes !== undefined && stat.size >= maxBytes;
    const cadence = rotationCadence(policy);
    const isCadenceDue = Boolean(cadence && !hasRotatedInCadence(stateEntry, cadence));
    return {
        rotate: isOverSize || isCadenceDue,
        reason: rotationReason(isOverSize, isCadenceDue, cadence),
    };
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
    summary: MutableLogRotationSummary,
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
    summary: MutableLogRotationSummary,
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

interface MutableLogRotationSummary extends LogRotationContractSummary {
    files?: unknown[];
}

interface ProcessRotationCandidateOptions {
    filePath: string;
    seenFiles: Set<string>;
    excluded: Set<string>;
    summary: MutableLogRotationSummary;
    groupSummary: ReturnType<typeof summarizeGroup>;
    policy: LogRotationPolicy;
    approvedRoots: string[];
    isDryRun: boolean;
    state: LogRotationState;
    now: Date;
}

async function processRotationCandidate({
    filePath,
    seenFiles,
    excluded,
    summary,
    groupSummary,
    policy,
    approvedRoots,
    isDryRun,
    state,
    now,
}: ProcessRotationCandidateOptions): Promise<void> {
    if (
        seenFiles.has(filePath) ||
        excluded.has(filePath) ||
        ROTATED_SUFFIX_RE.test(filePath)
    ) {
        return;
    }

    seenFiles.add(filePath);
    groupSummary.checkedFiles += 1;
    summary.checkedFiles += 1;
    try {
        const safe = await assertSafePath(filePath, approvedRoots);
        if (!safe) {
            return;
        }

        const stat = await fs.stat(filePath);
        const retention = async (simulatedArchives: RetentionArchive[] = []) =>
            applyRetention(filePath, policy, approvedRoots, isDryRun, simulatedArchives);
        const decision = shouldRotate({
            stat,
            policy,
            stateEntry: state.files[filePath],
        });
        if (policy.skipEmpty && stat.size === 0) {
            applySkippedRetention(summary, groupSummary, await retention(), filePath);
        } else if (decision.rotate) {
            const archivePath = archiveBasePath(filePath, now);
            let rotation: RotationResult;
            if (isDryRun) {
                const isCompressed = shouldCompressPolicy(policy);
                rotation = {
                    archivePath: isCompressed ? `${archivePath}.gz` : archivePath,
                    compressed: isCompressed,
                };
            } else {
                const verified = await openVerifiedLogFile(filePath, approvedRoots);
                try {
                    rotation =
                        policy.strategy === "rename"
                            ? await rotateRename(
                                  filePath,
                                  verified,
                                  archivePath,
                                  shouldCompressPolicy(policy),
                                  approvedRoots
                              )
                            : await rotateCopyTruncate(
                                  filePath,
                                  verified,
                                  archivePath,
                                  shouldCompressPolicy(policy),
                                  approvedRoots
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
                    shouldCompress: false,
                },
            ];
            const retained = await retention(simulatedArchives);
            groupSummary.deletedArchives += retained.deleted.length;
            summary.deletedArchives += retained.deleted.length;
            groupSummary.compressedFiles += retained.compressed.length;
            summary.compressedFiles += retained.compressed.length;
            appendRetentionWarnings(summary, retained.warnings, {
                filePath,
            });
        } else {
            applySkippedRetention(summary, groupSummary, await retention(), filePath);
        }
    } catch (error) {
        summary.isOk = false;
        summary.errors.push({
            filePath,
            message: caughtMessage(error),
        });
    }
}

export async function runLogRotationService(
    options: LogRotationOptions
): Promise<MutableLogRotationSummary> {
    const startedAt = new Date();
    const config = await loadLogRotationConfig(options.config || DEFAULT_CONFIG_PATH);
    validateLogRotationConfig(config);
    const groups = config.groups
        .filter((group) => group.enabled ?? config.defaults?.enabled ?? true)
        .filter((group) => !options.group || group.name === options.group);
    const summary: MutableLogRotationSummary = {
        isOk: true,
        isDryRun: options.isDryRun,
        startedAt: startedAt.toISOString(),
        finishedAt: undefined,
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
    const lock = await acquireLogRotationLock(options.isDryRun);
    if (!lock && !options.isDryRun) {
        summary.isOk = false;
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
                        options.isDryRun
                    );
                    groupSummary.checkedFiles += retained.isChecked;
                    summary.checkedFiles += retained.isChecked;
                    groupSummary.deletedArchives += retained.deleted.length;
                    summary.deletedArchives += retained.deleted.length;
                    groupSummary.compressedFiles += retained.compressed.length;
                    summary.compressedFiles += retained.compressed.length;
                    appendRetentionWarnings(summary, retained.warnings, {
                        group: group.name,
                    });
                } catch (error) {
                    summary.isOk = false;
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
                    const files = await resolveGlob(pattern, {
                        missingOk: policy.missingOk,
                    });
                    for (const file of files) {
                        matched.add(file);
                    }
                }
                const excluded = new Set<string>();
                for (const pattern of policy.excludePaths) {
                    const files = await resolveGlob(pattern, {
                        missingOk: policy.missingOk,
                    });
                    for (const file of files) {
                        excluded.add(file);
                    }
                }
                for (const filePath of [...matched].toSorted(compareStrings)) {
                    await processRotationCandidate({
                        filePath,
                        seenFiles,
                        excluded,
                        summary,
                        groupSummary,
                        policy,
                        approvedRoots: effectiveApprovedRoots,
                        isDryRun: options.isDryRun,
                        state,
                        now,
                    });
                }
            } catch (error) {
                summary.isOk = false;
                summary.errors.push({
                    group: group.name,
                    message: caughtMessage(error),
                });
            }
        }
        summary.finishedAt = dateToISOString(new Date());
        if (!options.isDryRun) {
            state.lastRun = {
                isOk: summary.isOk,
                isDryRun: false,
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
                    key: LOG_ROTATION_STATE_KEY,
                    data: state,
                    source: "backend",
                    ttl: 90 * 24,
                    ttlUnit: "hours",
                    metadata: { workflow: "Log Rotation - Foundation" },
                });
            } catch (error) {
                summary.isOk = false;
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
