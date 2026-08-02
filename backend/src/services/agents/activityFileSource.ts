import type FS from "node:fs";
import Path from "node:path";

import { isPlainRecord } from "../../../../contracts/runtime.ts";
import { guardedPath } from "../../lib/guardedOps/core.ts";
import {
    readdirGuarded,
    readTextRangeNoFollowGuarded,
    readTextTailNoFollowGuarded,
    statGuarded,
} from "../../lib/guardedOps/read.ts";
import { unknownArray } from "../../lib/values.ts";
import {
    activityContextsMatch,
    findActivityTask,
    getActivityEntryTask,
    getActivityEntryTurnId,
    getCodexResponseItemActivity,
    getTrajectoryActivity,
    isVisibleActivityTool,
    summarizeToolActivity,
} from "./activityParser.ts";
import { getSafeAgentActivityRoots, type ActivityLogRoot } from "./agentPaths.ts";

const STALE_THRESHOLD = 5 * 60_000;
const MAX_ACTIVITY_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVITY_TASK_LOOKBACK_BYTES = 8 * 1024 * 1024;
const ACTIVITY_TASK_LOOKBACK_OVERLAP_BYTES = 64 * 1024;

// Get activity from a JSONL session file
/** Captures the latest observed agent activity label and timestamp. */
export interface ActivityInfo {
    task: string | undefined; // High-level task (from last user message)
    activity: string | undefined; // Current activity (from last tool use)
    modTime: number;
}

/** Describes one activity-bearing JSONL file. */
interface ActivityLogFile {
    name: string;
    path: string;
    mtime: number;
    group: string;
}

/**
 * Builds file metadata for one JSONL log, returning undefined when it cannot be statted.
 * @returns Built file metadata for one JSONL log, returning undefined when it cannot be statted.
 */
function toActivityLogFile(
    root: ActivityLogRoot,
    relativePath: string,
    fullPath: string,
    statFile = statGuarded
): ActivityLogFile | undefined {
    try {
        const mtime = statFile(guardedPath(fullPath)).mtimeMs;
        const group = `${root.directory}:${relativePath
            .replace(/\.trajectory\.jsonl$/u, "")
            .replace(/\.jsonl$/u, "")}`;
        return { name: relativePath, path: fullPath, mtime, group };
    } catch {
        // Ignore files that disappear or become unreadable during scanning.
        return undefined;
    }
}

/**
 * Lists JSONL activity files in a root while preserving paired file grouping.
 * @returns List activity log files result.
 */
function listActivityLogFiles(root: ActivityLogRoot): ActivityLogFile[] {
    const files: ActivityLogFile[] = [];
    const pending = [{ directory: root.directory, relativeDirectory: "", depth: 0 }];
    const maxDepth = root.recursive ? 6 : 0;

    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) {
            continue;
        }

        let entries: FS.Dirent[];
        try {
            entries = readdirGuarded(guardedPath(current.directory), {
                withFileTypes: true,
            });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = Path.join(current.directory, entry.name);
            const relativePath = current.relativeDirectory
                ? Path.join(current.relativeDirectory, entry.name)
                : entry.name;

            if (entry.isDirectory() && root.recursive && current.depth < maxDepth) {
                pending.push({
                    directory: fullPath,
                    relativeDirectory: relativePath,
                    depth: current.depth + 1,
                });
            } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                const file = toActivityLogFile(root, relativePath, fullPath);
                if (file) {
                    files.push(file);
                }
            }
        }
    }

    return files;
}

/**
 * Reads the newest activity marker from agent session files when live Gateway data is unavailable.
 * @param agentId Agent identifier.
 * @returns Read the newest activity marker from agent session files when live Gateway data is unavailable.
 */
export async function getLatestActivityFromFile(
    agentId: string
): Promise<ActivityInfo | undefined> {
    const roots = getSafeAgentActivityRoots(agentId);
    if (roots.length === 0) {
        return undefined;
    }

    try {
        const files = roots
            .flatMap((root) => listActivityLogFiles(root))
            .toSorted((a, b) => b.mtime - a.mtime);

        if (files.length === 0) {
            return undefined;
        }

        const groups = new Map<string, { files: ActivityLogFile[]; modTime: number }>();
        for (const file of files) {
            const existing = groups.get(file.group);
            if (existing) {
                existing.files.push(file);
                existing.modTime = Math.max(existing.modTime, file.mtime);
            } else {
                groups.set(file.group, { files: [file], modTime: file.mtime });
            }
        }

        const sortedGroups = groups
            .values()
            .toArray()
            .toSorted((a, b) => b.modTime - a.modTime);
        const latestGroup = sortedGroups[0];
        if (!latestGroup) {
            return {
                task: undefined,
                activity: undefined,
                modTime: 0,
            };
        }
        const latestModificationTime = latestGroup.modTime;
        const now = Date.now();

        // If no session file has been modified in 5 minutes, agent is idle.
        if (now - latestModificationTime > STALE_THRESHOLD) {
            return {
                task: undefined,
                activity: undefined,
                modTime: latestModificationTime,
            };
        }

        let pendingTask: string | undefined;
        let pendingTaskTurnId: string | undefined;
        let selectedActivity: string | undefined;
        let isLatestGroup = true;

        const scanActivityFile = async (
            file: ActivityLogFile,
            groupTaskTurnId: string | undefined,
            inheritedTaskTurnId: string | undefined
        ) => {
            if (now - file.mtime > STALE_THRESHOLD) {
                return {
                    task: undefined,
                    taskTurnId: undefined,
                    activity: undefined,
                };
            }

            let content: string;
            try {
                content = await readTextTailNoFollowGuarded(
                    guardedPath(file.path),
                    MAX_ACTIVITY_LOG_TAIL_BYTES
                );
            } catch {
                return {
                    task: undefined,
                    taskTurnId: undefined,
                    activity: undefined,
                };
            }

            const lines = content.trim().split("\n");
            let fileTask: string | undefined;
            let fileTaskRunId: string | undefined;
            let fileTaskTurnId: string | undefined;
            let fileActivity: string | undefined;
            let fileActivityRunId: string | undefined;
            let fileActivityTurnId: string | undefined;
            let fileRunId: string | undefined;

            // Scan from end to find most recent user message and visible tool use.
            for (let index = lines.length - 1; index >= 0; index--) {
                try {
                    const line = lines[index];
                    if (line === undefined) continue;
                    const entry: unknown = JSON.parse(line);
                    const record = isPlainRecord(entry) ? entry : {};
                    const entryRunId =
                        typeof record.runId === "string" ? record.runId : undefined;
                    if (!fileRunId && entryRunId) {
                        fileRunId = entryRunId;
                    }
                    if (fileRunId && !entryRunId) {
                        continue;
                    }
                    if (fileRunId && entryRunId && entryRunId !== fileRunId) {
                        continue;
                    }
                    if (
                        fileRunId &&
                        entryRunId === fileRunId &&
                        record.type === "session.started"
                    ) {
                        break;
                    }

                    const entryTurnId = getActivityEntryTurnId(entry);
                    const trajectoryActivity = getTrajectoryActivity(entry);
                    const entryTask = fileTask
                        ? undefined
                        : getActivityEntryTask(entry, trajectoryActivity.task);
                    if (
                        entryTask &&
                        activityContextsMatch(
                            entryTask.runId,
                            entryTask.turnId,
                            fileActivityRunId,
                            fileActivityTurnId
                        )
                    ) {
                        fileTask = entryTask.task;
                        fileTaskRunId = entryTask.runId;
                        fileTaskTurnId = entryTask.turnId;
                    }
                    const entryActivity =
                        trajectoryActivity.activity ??
                        getCodexResponseItemActivity(entry);
                    if (
                        !fileActivity &&
                        entryActivity &&
                        activityContextsMatch(
                            fileTaskRunId,
                            fileTaskTurnId,
                            entryRunId,
                            entryTurnId
                        )
                    ) {
                        fileActivity = entryActivity;
                        fileActivityRunId = entryRunId;
                        fileActivityTurnId = entryTurnId;
                    }

                    const messageValue = record.message ?? entry;
                    const message = isPlainRecord(messageValue) ? messageValue : {};

                    // First visible tool use from end = current activity.
                    if (
                        !fileActivity &&
                        message.role === "assistant" &&
                        Array.isArray(message.content)
                    ) {
                        const toolCall = unknownArray(message.content)
                            .filter((candidate) => isPlainRecord(candidate))
                            .find(
                                (candidate) =>
                                    candidate.type === "toolCall" &&
                                    typeof candidate.name === "string" &&
                                    isVisibleActivityTool(candidate.name)
                            );
                        const expectedTurnId =
                            fileTaskTurnId || groupTaskTurnId || inheritedTaskTurnId;
                        const canUseToolCall =
                            (!expectedTurnId || entryTurnId === expectedTurnId) &&
                            activityContextsMatch(
                                fileTaskRunId,
                                fileTaskTurnId,
                                entryRunId,
                                entryTurnId
                            );
                        const toolName = toolCall?.name;
                        if (canUseToolCall && typeof toolName === "string") {
                            fileActivity = summarizeToolActivity(toolName, toolCall);
                            fileActivityRunId = entryRunId;
                            fileActivityTurnId = entryTurnId;
                        }
                    }

                    if (fileTask && fileActivity) {
                        break;
                    }
                } catch {
                    // Skip malformed lines
                }
            }

            if (fileActivity && !fileTask) {
                try {
                    const fileSize = statGuarded(guardedPath(file.path)).size;
                    const tailStart = Math.max(0, fileSize - MAX_ACTIVITY_LOG_TAIL_BYTES);
                    if (tailStart > 0) {
                        const lookbackStart = Math.max(
                            0,
                            tailStart - MAX_ACTIVITY_TASK_LOOKBACK_BYTES
                        );
                        const lookbackEnd = Math.min(
                            fileSize,
                            tailStart + ACTIVITY_TASK_LOOKBACK_OVERLAP_BYTES
                        );
                        const earlierContent = await readTextRangeNoFollowGuarded(
                            guardedPath(file.path),
                            lookbackStart,
                            lookbackEnd - lookbackStart
                        );
                        const earlierTask = findActivityTask(
                            earlierContent,
                            fileActivityRunId ?? fileRunId,
                            fileActivityTurnId
                        );
                        if (earlierTask) {
                            fileTask = earlierTask.task;
                            fileTaskTurnId = earlierTask.turnId;
                        }
                    }
                } catch {
                    // Preserve the tail-derived activity when bounded task recovery fails.
                }
            }

            return {
                task: fileTask,
                taskTurnId: fileTaskTurnId,
                activity: fileActivity,
            };
        };

        const scanActivityGroup = async (
            group: { files: ActivityLogFile[]; modTime: number },
            inheritedTaskTurnId: string | undefined
        ) => {
            let groupTask: string | undefined;
            let groupTaskTurnId: string | undefined;
            let groupActivity: string | undefined;

            const sortedFiles = group.files.toSorted((a, b) => b.mtime - a.mtime);
            for (const file of sortedFiles) {
                const {
                    task: fileTask,
                    taskTurnId: fileTaskTurnId,
                    activity: fileActivity,
                } = await scanActivityFile(file, groupTaskTurnId, inheritedTaskTurnId);

                if (fileTask && !groupTask) {
                    groupTask = fileTask;
                    groupTaskTurnId = fileTaskTurnId;
                }

                if (fileActivity && !groupActivity) {
                    groupActivity = fileActivity;
                }

                if (groupTask && groupActivity) {
                    break;
                }
            }

            return {
                task: groupTask,
                taskTurnId: groupTaskTurnId,
                activity: groupActivity,
            };
        };

        for (const group of sortedGroups) {
            if (now - group.modTime <= STALE_THRESHOLD) {
                const {
                    task: groupTask,
                    taskTurnId: groupTaskTurnId,
                    activity: groupActivity,
                } = await scanActivityGroup(group, pendingTaskTurnId);

                if (groupTask && !pendingTask) {
                    pendingTask = groupTask;
                    pendingTaskTurnId = groupTaskTurnId;
                }

                if (isLatestGroup && groupActivity) {
                    selectedActivity = groupActivity;
                }
            }

            if (selectedActivity && pendingTask) {
                break;
            }
            isLatestGroup = false;
        }

        return {
            task: pendingTask,
            activity: selectedActivity,
            modTime: latestModificationTime,
        };
    } catch {
        return undefined;
    }
}

/**
 * Returns the modification time for a session file, or undefined when it cannot be read.
 * @param agentId Agent identifier.
 * @returns the modification time for a session file, or undefined when it cannot be read.
 */
export function getSessionFileModificationTime(agentId: string): number | undefined {
    const roots = getSafeAgentActivityRoots(agentId);
    if (roots.length === 0) {
        return undefined;
    }

    try {
        let latestModificationTime = 0;
        for (const root of roots) {
            for (const file of listActivityLogFiles(root)) {
                latestModificationTime = Math.max(latestModificationTime, file.mtime);
            }
        }
        return latestModificationTime > 0 ? latestModificationTime : undefined;
    } catch {
        return undefined;
    }
}
