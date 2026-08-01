import type FS from "node:fs";
import Path from "node:path";

import { isPlainRecord } from "../../../../contracts/runtime.ts";
import {
    guardedPath,
    readdirGuarded,
    readTextRangeNoFollowGuarded,
    readTextTailNoFollowGuarded,
    statGuarded,
} from "../../lib/guardedOps.ts";
import { unknownArray } from "../../lib/values.ts";
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
 * Cleans raw prompts/transcript text for dashboard task display.
 * @param text Text value.
 * @returns Clean task text result.
 */
function cleanTaskText(text: string): string {
    return text
        .replaceAll(/[`]{3}json[\s\S]*?[`]{3}/g, "")
        .replaceAll(/[`]{3}[\s\S]*?[`]{3}/g, "")
        .replaceAll(/\[media attached[^\]]*\]/g, "")
        .replaceAll(/Conversation info[^\n]*/g, "")
        .replaceAll(/Sender[^\n]*/g, "")
        .replaceAll(/\n+/g, " ")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 100);
}

/** Performs summarize tool activity. */
/**
 * Normalizes raw tool activity data into an object.
 *
 * @param raw - Raw activity payload.
 * @returns Parsed activity record.
 */
function toolActivityRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return { raw };
        }
    }
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Normalizes the optional nested tool argument payload.
 *
 * @param rawArguments - Raw `arguments` field.
 * @returns Parsed argument record, when valid.
 */
function toolActivityArguments(
    rawArguments: unknown
): Record<string, unknown> | undefined {
    if (typeof rawArguments === "string") {
        try {
            const value = JSON.parse(rawArguments) as unknown;
            return value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : undefined;
        } catch {
            return undefined;
        }
    }
    return rawArguments && typeof rawArguments === "object"
        ? (rawArguments as Record<string, unknown>)
        : undefined;
}

function summarizeToolActivity(toolName: string, raw: unknown): string {
    const normalizedTool = normalizeToolName(toolName);
    const parsed = toolActivityRecord(raw);
    const parsedArguments = toolActivityArguments(parsed.arguments);
    const arguments_ = parsedArguments ?? parsed;

    const nested =
        arguments_.parameters && typeof arguments_.parameters === "object"
            ? (arguments_.parameters as Record<string, unknown>)
            : {};

    const path = (arguments_.path ||
        arguments_.file_path ||
        arguments_.filePath ||
        (Array.isArray(arguments_.paths) ? arguments_.paths[0] : undefined) ||
        (arguments_.input && typeof arguments_.input === "object"
            ? (arguments_.input as Record<string, unknown>).path
            : undefined) ||
        nested.path ||
        nested.file_path ||
        nested.filePath ||
        (Array.isArray(nested.paths) ? nested.paths[0] : undefined)) as
        | string
        | undefined;
    const command = (arguments_.command ||
        arguments_.cmd ||
        nested.command ||
        nested.cmd) as string | undefined;
    const action = (arguments_.action || nested.action) as string | undefined;
    const message = (arguments_.message ||
        arguments_.text ||
        nested.message ||
        nested.text) as string | undefined;
    const url = (arguments_.url || nested.url) as string | undefined;
    const query = (arguments_.query || nested.query) as string | undefined;

    // Fallback: parse partialJson/raw string if present
    let fallbackPath: string | undefined;
    if (!path && typeof parsed.partialJson === "string") {
        try {
            const pj = JSON.parse(parsed.partialJson) as Record<string, unknown>;
            fallbackPath = (pj.path ||
                pj.file_path ||
                pj.filePath ||
                (Array.isArray(pj.paths) ? pj.paths[0] : undefined)) as
                | string
                | undefined;
        } catch {
            const match = parsed.partialJson.match(
                /"(?:path|file_path|filePath)"\s*:\s*"([^"]+)"/
            );
            fallbackPath = match ? match[1] : undefined;
        }
    }

    const resolvedPath = path || fallbackPath;

    if (normalizedTool === "read" && resolvedPath) {
        return `read ${resolvedPath}`;
    }
    if (normalizedTool === "edit" && resolvedPath) {
        return `edit ${resolvedPath}`;
    }
    if (normalizedTool === "write" && resolvedPath) {
        return `write ${resolvedPath}`;
    }
    if (command && ["exec", "exec_command", "bash"].includes(normalizedTool)) {
        return `exec ${command.slice(0, 70)}`;
    }
    if (normalizedTool === "message" && message) {
        return `message ${message.replaceAll(/\s+/g, " ").trim().slice(0, 70)}`;
    }
    if (normalizedTool === "memory_search" && query) {
        return `memory_search ${query.replaceAll(/\s+/g, " ").trim().slice(0, 70)}`;
    }
    if (normalizedTool === "apply_patch") {
        return "edit files";
    }
    if (normalizedTool === "browser" && action) {
        return `browser ${action}${url ? ` ${url}` : ""}`.slice(0, 90);
    }

    if (action) {
        return `${normalizedTool} ${action}`.slice(0, 90);
    }
    if (resolvedPath) {
        return `${normalizedTool} ${resolvedPath}`.slice(0, 90);
    }

    return normalizedTool;
}

function getActivityEntryTurnId(entry: unknown): string | undefined {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    const raw = entry as {
        __openclaw?: { mirrorIdentity?: unknown };
        data?: { turnId?: unknown };
        message?: { __openclaw?: { mirrorIdentity?: unknown } };
    };
    if (typeof raw.data?.turnId === "string") {
        return raw.data.turnId;
    }

    let mirrorIdentity: string | undefined;
    if (typeof raw.message?.__openclaw?.mirrorIdentity === "string") {
        mirrorIdentity = raw.message.__openclaw.mirrorIdentity;
    }
    if (typeof raw.__openclaw?.mirrorIdentity === "string") {
        mirrorIdentity = raw.__openclaw.mirrorIdentity;
    }
    return mirrorIdentity ? mirrorIdentity.split(":", 1)[0] || undefined : undefined;
}

/**
 * Returns a canonical un-namespaced tool name for activity filtering and labels.
 * @param toolName Tool name value.
 * @returns a canonical un-namespaced tool name for activity filtering and labels.
 */
function normalizeToolName(toolName: string): string {
    const parts = toolName.split(".");
    const unscoped = toolName.includes(".") ? (parts.at(-1) ?? toolName) : toolName;
    return unscoped.replace(/^mcp__.+?__/, "").toLowerCase();
}

/**
 * Returns whether a tool should be shown as user-facing current activity.
 * @param toolName Tool name value.
 * @returns Whether a tool should be shown as user-facing current activity.
 */
function isVisibleActivityTool(toolName: string): boolean {
    const normalizedToolName = normalizeToolName(toolName);
    return normalizedToolName !== "message";
}

function getTrajectoryToolArguments(data: Record<string, unknown>): unknown {
    return data.arguments ?? data.args ?? data.input ?? data.parameters ?? data;
}

/**
 * Extracts nested tool activity from Codex response-item session logs.
 * @param entry Entry value.
 * @returns Codex response item activity value.
 */
function getCodexResponseItemActivity(entry: unknown): string | undefined {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }

    const record = entry as {
        type?: string;
        payload?: {
            type?: string;
            name?: unknown;
            input?: unknown;
        };
    };
    if (
        record.type !== "response_item" ||
        record.payload?.type !== "custom_tool_call" ||
        typeof record.payload.name !== "string"
    ) {
        return undefined;
    }
    const input = typeof record.payload.input === "string" ? record.payload.input : "";
    if (/tools\.(?:mcp__[^.]+__)?message\s*\(/u.test(input)) {
        return undefined;
    }

    const nestedToolMatch = input.match(/tools\.([a-zA-Z0-9_]+)\s*\(/u);
    const nestedToolName = nestedToolMatch ? nestedToolMatch[1] : undefined;
    const commandMatch = input.match(/(?:\bcmd|["']cmd["'])\s*:\s*(["'`])([\s\S]*?)\1/u);
    if (commandMatch) {
        return summarizeToolActivity("exec", { command: commandMatch[2] });
    }

    if (/tools\.apply_patch\s*\(/u.test(input)) {
        return summarizeToolActivity("apply_patch", {});
    }
    if (/tools\.openclaw_session_status\s*\(/u.test(input)) {
        return "session_status";
    }
    if (/tools\.openclaw_browser\s*\(/u.test(input)) {
        return summarizeToolActivity("browser", { action: "activity" });
    }
    if (nestedToolName === "write_stdin") {
        return "terminal output";
    }
    if (nestedToolName) {
        return summarizeToolActivity(nestedToolName, { raw: input });
    }
    return summarizeToolActivity(record.payload.name, { raw: input });
}

/**
 * Extracts activity details from OpenClaw v4 trajectory events.
 * @param entry Entry value.
 * @returns Trajectory activity value.
 */
function getTrajectoryActivity(entry: unknown): {
    task?: string | undefined;
    activity?: string | undefined;
} {
    if (!entry || typeof entry !== "object") {
        return {};
    }

    const record = entry as {
        type?: string;
        data?: {
            prompt?: unknown;
            name?: unknown;
            arguments?: unknown;
            args?: unknown;
            input?: unknown;
            parameters?: unknown;
        };
    };
    const data = record.data || {};
    if (record.type === "prompt.submitted" && typeof data.prompt === "string") {
        return { task: data.prompt };
    }

    if (
        record.type === "tool.call" &&
        typeof data.name === "string" &&
        isVisibleActivityTool(data.name)
    ) {
        return {
            activity: summarizeToolActivity(data.name, {
                arguments: getTrajectoryToolArguments(data),
            }),
        };
    }

    if (
        record.type === "tool.result" &&
        typeof data.name === "string" &&
        isVisibleActivityTool(data.name)
    ) {
        return {
            activity: summarizeToolActivity(data.name, {
                arguments: getTrajectoryToolArguments(data),
            }),
        };
    }

    return {};
}

interface ActivityEntryTask {
    runId: string | undefined;
    task: string;
    turnId: string | undefined;
}

function getActivityEntryTask(
    entry: unknown,
    trajectoryTask: string | undefined
): ActivityEntryTask | undefined {
    const record = isPlainRecord(entry) ? entry : {};
    const runId = typeof record.runId === "string" ? record.runId : undefined;
    const turnId = getActivityEntryTurnId(entry);
    if (trajectoryTask) {
        const task = cleanTaskText(trajectoryTask);
        return task ? { runId, task, turnId } : undefined;
    }

    const messageValue = record.message ?? entry;
    const message = isPlainRecord(messageValue) ? messageValue : {};
    if (message.role !== "user" || !message.content) {
        return undefined;
    }
    const text = unknownArray(message.content)
        .filter(
            (candidate): candidate is Record<string, unknown> =>
                isPlainRecord(candidate) && candidate.type === "text"
        )
        .map((candidate) => (typeof candidate.text === "string" ? candidate.text : ""))
        .join(" ");
    const taskText = typeof message.content === "string" ? message.content : text;
    const task = cleanTaskText(taskText);
    return task ? { runId, task, turnId } : undefined;
}

function activityContextsMatch(
    firstRunId: string | undefined,
    firstTurnId: string | undefined,
    secondRunId: string | undefined,
    secondTurnId: string | undefined
): boolean {
    const runMatches = !firstRunId || !secondRunId || firstRunId === secondRunId;
    const turnMatches = !firstTurnId || !secondTurnId || firstTurnId === secondTurnId;
    return runMatches && turnMatches;
}

function findActivityTask(
    content: string,
    targetRunId: string | undefined,
    targetTurnId: string | undefined
): ActivityEntryTask | undefined {
    const lines = content.trim().split("\n");
    let fileRunId = targetRunId;
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

            const task = getActivityEntryTask(entry, getTrajectoryActivity(entry).task);
            if (
                task &&
                activityContextsMatch(task.runId, task.turnId, targetRunId, targetTurnId)
            ) {
                return task;
            }
        } catch {
            // Skip malformed or window-truncated lines.
        }
    }
    return undefined;
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
