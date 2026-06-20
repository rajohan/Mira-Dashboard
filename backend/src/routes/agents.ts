import express from "express";
import FS from "fs";
import JSON5 from "json5";
import os from "os";
import Path from "path";

import { database } from "../database.ts";
import gateway from "../gateway.ts";
import { asyncRoute } from "../lib/errors.ts";
import {
    guardedPath,
    mkdirGuarded,
    readdirGuarded,
    readTextNoFollowGuarded,
    statGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.ts";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.ts";

function defaultOpenclawRoot(): string {
    return Path.join(process.cwd(), "data", "openclaw");
}

function resolveOpenclawRoot(): string {
    const configuredRoot =
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim();
    if (configuredRoot) {
        const resolved = Path.resolve(configuredRoot);
        return Path.isAbsolute(configuredRoot) && Path.parse(resolved).root !== resolved
            ? resolved
            : defaultOpenclawRoot();
    }

    const rawHomeDirectory = process.env.HOME?.trim() || os.homedir().trim();
    const homeDirectory = Path.resolve(rawHomeDirectory);
    if (
        rawHomeDirectory.length === 0 ||
        !Path.isAbsolute(rawHomeDirectory) ||
        Path.parse(homeDirectory).root === homeDirectory
    ) {
        return defaultOpenclawRoot();
    }
    return Path.join(homeDirectory, ".openclaw");
}

const prepareAgentMetadataDirectoryForWrite = prepareSafeWriteTargetWithinRoot;
const hasProcfsAvailabilityProbe = (): boolean =>
    process.platform === "linux" && FS.existsSync("/proc/self/fd");

function getOpenclawRoot(): string {
    return resolveOpenclawRoot();
}

function getAgentsDirectory(): string {
    return Path.join(getOpenclawRoot(), "agents");
}

export function isProcfsAvailable(): boolean {
    return hasProcfsAvailabilityProbe();
}

function mkdirChildFromVerifiedParent(parent: string, childName: string): void {
    if (!isValidAgentId(childName)) {
        throw Object.assign(new Error("Invalid child directory name"), {
            code: "EINVAL",
        });
    }

    if (!isProcfsAvailable()) {
        throw Object.assign(
            new Error("Verified child directory creation is not supported"),
            { code: "ENOTSUP" }
        );
    }

    const parentFd = FS.openSync(
        Buffer.from(parent),
        FS.constants.O_DIRECTORY | FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
    );
    try {
        const fdPath = Path.join("/proc/self/fd", String(parentFd), childName);
        try {
            FS.mkdirSync(Buffer.from(fdPath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
    } finally {
        FS.closeSync(parentFd);
    }
}

function realExistingChildDirectoryFromVerifiedParent(
    parent: string,
    childName: string
): string {
    if (!isValidAgentId(childName)) {
        throw Object.assign(new Error("Invalid child directory name"), {
            code: "EINVAL",
        });
    }

    const childPath = Path.join(parent, childName);
    const parentFd = FS.openSync(
        Buffer.from(parent),
        FS.constants.O_DIRECTORY | FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
    );
    try {
        const openedParentStat = FS.fstatSync(parentFd);
        const realParent = FS.realpathSync(parent);
        const realParentStat = FS.statSync(realParent);
        if (
            openedParentStat.dev !== realParentStat.dev ||
            openedParentStat.ino !== realParentStat.ino
        ) {
            throw Object.assign(new Error("Parent path validation failed"), {
                code: "EACCES",
            });
        }
        const realChild = FS.realpathSync(childPath);
        if (!FS.statSync(realChild).isDirectory()) {
            throw Object.assign(new Error("Child directory is not a directory"), {
                code: "ENOTDIR",
            });
        }
        return realChild;
    } finally {
        FS.closeSync(parentFd);
    }
}

/** Matches agent ids that are safe to use as path segments. */
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9._-]+$/u;

/** Returns whether an agent id is safe for filesystem-backed agent metadata paths. */
export function isValidAgentId(id: string): boolean {
    return (
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 64 &&
        id !== "." &&
        id !== ".." &&
        SAFE_AGENT_ID_RE.test(id)
    );
}

/** Returns the first Express route param value regardless of scalar/array shape. */
function getRouteParameter(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] || "" : value || "";
}

function getRealAgentsDirectory(): string | null {
    try {
        return FS.realpathSync(getAgentsDirectory());
    } catch {
        return null;
    }
}

function ensureRealAgentsDirectory(): string | null {
    try {
        const agentsDirectory = getAgentsDirectory();
        const realAgentsDirectory = FS.realpathSync(agentsDirectory);
        const agentsDirectoryStat = FS.statSync(realAgentsDirectory);
        if (!agentsDirectoryStat.isDirectory()) {
            return null;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return null;
        }
        mkdirGuarded(guardedPath(getAgentsDirectory()), { recursive: true });
    }

    return getRealAgentsDirectory();
}

/** Returns the canonical sessions directory for a validated agent id. */
function getSafeAgentSessionsDirectory(agentId: string): string | null {
    if (!isValidAgentId(agentId)) {
        return null;
    }

    const agentsDirectory = getAgentsDirectory();
    const sessionsDirectory = safePathWithinRoot(
        Path.join(agentId, "sessions"),
        agentsDirectory
    );
    if (!sessionsDirectory) {
        return null;
    }

    try {
        const realAgentsDirectory = getRealAgentsDirectory();
        if (!realAgentsDirectory) {
            return null;
        }
        const expectedSessionsDirectory = Path.join(agentsDirectory, agentId, "sessions");
        const canonicalExpectedSessionsDirectory = Path.join(
            realAgentsDirectory,
            agentId,
            "sessions"
        );
        const realExpectedSessionsDirectory = FS.realpathSync(expectedSessionsDirectory);
        const realSessionsDirectory = FS.realpathSync(sessionsDirectory);
        return realSessionsDirectory === realExpectedSessionsDirectory &&
            realExpectedSessionsDirectory === canonicalExpectedSessionsDirectory
            ? realSessionsDirectory
            : null;
    } catch {
        return null;
    }
}

/** Returns activity log roots for an agent, including Codex-native rollout logs. */
function getSafeAgentActivityRoots(agentId: string): ActivityLogRoot[] {
    if (!isValidAgentId(agentId)) {
        return [];
    }

    const roots = [
        { relative: Path.join(agentId, "sessions"), recursive: false },
        {
            relative: Path.join(agentId, "agent", "codex-home", "sessions"),
            recursive: true,
        },
    ];

    const realAgentsDirectory = getRealAgentsDirectory();
    if (!realAgentsDirectory) {
        return [];
    }
    return roots.flatMap((root) => {
        const rootDirectory = safePathWithinRoot(root.relative, getAgentsDirectory());
        if (!rootDirectory) {
            return [];
        }

        try {
            const expected = Path.join(realAgentsDirectory, root.relative);
            const realRootDirectory = FS.realpathSync(rootDirectory);
            return realRootDirectory === expected
                ? [{ directory: realRootDirectory, recursive: root.recursive }]
                : [];
        } catch {
            return [];
        }
    });
}

// Activity thresholds (in milliseconds)
const ACTIVE_THRESHOLD = 20_000; // < 20s = active (tool/activity)
const THINKING_THRESHOLD = 60_000; // 20s-60s = thinking, 60s+ = idle
const STALE_THRESHOLD = 5 * 60_000; // 5 minutes - ignore data older than this
const TASK_IDLE_TIMEOUT_MS = 30 * 60_000;

/** Defines per-agent dashboard metadata such as current task and task history. */
interface AgentMetadata {
    currentTask?: string;
    updatedAt?: string;
}

/** Represents one configured OpenClaw agent entry from agents.yml. */
interface AgentConfig {
    id: string;
    default?: boolean;
    model?: {
        primary?: string;
        fallbacks?: string[];
    };
    subagents?: {
        allowAgents?: string[];
    };
}

/** Represents the parsed agents.yml payload keyed by agent id. */
interface AgentsConfig {
    defaults: {
        model?: {
            primary?: string;
            fallbacks?: string[];
        };
        models?: Record<string, { alias?: string }>;
    };
    list: AgentConfig[];
}

/** Captures lightweight session file metadata used to infer agent activity. */
interface SessionInfo {
    key?: string;
    sessionId?: string;
    updatedAt?: number;
    channel?: string;
    displayName?: string;
    label?: string;
}

/** Summarizes dashboard-facing status, activity, and metadata for one agent. */
interface AgentStatus {
    id: string;
    status: "active" | "thinking" | "idle" | "offline";
    model: string;
    currentTask: string | null;
    currentActivity: string | null;
    lastActivity: string | null;
    sessionKey: string | null;
    channel: string | null;
}

/** Records an archived current-task value with timing metadata. */
interface AgentTaskHistoryItem {
    id: number;
    agentId: string;
    task: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
}

/** Normalizes Gateway session data needed to map live sessions back to agents. */
interface GatewaySessionSummary {
    key: string;
    model?: string;
    status?: string | null;
    updatedAt?: number | null;
    startedAt?: string | number | null;
    endedAt?: string | number | null;
    runId?: string | null;
    activeRunId?: string | null;
    currentRunId?: string | null;
    isRunning?: boolean | null;
    running?: boolean | null;
}

/** Performs to display model name. */
function toDisplayModelName(model: string): string {
    if (!model) {
        return "unknown";
    }

    const slashIndex = model.indexOf("/");
    return slashIndex === -1 ? model : model.slice(slashIndex + 1);
}

/** Performs resolve configured model name. */
function resolveConfiguredModelName(
    configuredModel: string | undefined,
    config: AgentsConfig
): string {
    if (!configuredModel) {
        return "unknown";
    }

    const configured = configuredModel.trim();
    if (!configured) {
        return "unknown";
    }
    const aliases = config.defaults?.models || {};
    const matchedEntry = Object.entries(aliases).find(
        ([, value]) => value?.alias === configured
    );

    if (matchedEntry) {
        return toDisplayModelName(matchedEntry[0]);
    }

    return toDisplayModelName(configured);
}

/** Returns Gateway sessions for agent keys, preferring live Gateway data and falling back to cached files on failure. */
async function getGatewaySessionsForAgents(): Promise<GatewaySessionSummary[]> {
    const cached: GatewaySessionSummary[] = (() => {
        try {
            return gateway
                .getSessions()
                .filter(
                    (session) => typeof session.key === "string" && session.key.length > 0
                )
                .map((session) => ({
                    key: session.key,
                    model:
                        typeof session.model === "string"
                            ? session.model.trim() || undefined
                            : undefined,
                    status: session.status,
                    updatedAt: session.updatedAt,
                    startedAt: session.startedAt,
                    endedAt: session.endedAt,
                    runId: session.runId,
                    activeRunId: session.activeRunId,
                    currentRunId: session.currentRunId,
                    isRunning: session.isRunning,
                    running: session.running,
                }));
        } catch {
            return [];
        }
    })();

    try {
        const result = (await gateway.request("sessions.list", {})) as {
            sessions?: Array<{
                key?: string;
                model?: string;
                status?: string | null;
                updatedAt?: number | null;
                startedAt?: number | null;
                endedAt?: number | null;
                runId?: string | null;
                activeRunId?: string | null;
                currentRunId?: string | null;
                isRunning?: boolean | null;
                running?: boolean | null;
            }>;
        };

        if (Array.isArray(result.sessions)) {
            return result.sessions
                .filter(
                    (session) => typeof session.key === "string" && session.key.length > 0
                )
                .map((session) => ({
                    key: session.key as string,
                    model:
                        typeof session.model === "string"
                            ? session.model.trim() || undefined
                            : undefined,
                    status: session.status,
                    updatedAt: session.updatedAt,
                    startedAt: session.startedAt,
                    endedAt: session.endedAt,
                    runId: session.runId,
                    activeRunId: session.activeRunId,
                    currentRunId: session.currentRunId,
                    isRunning: session.isRunning,
                    running: session.running,
                }));
        }
    } catch {
        // Fall back to cached sessions below
    }
    return cached;
}

/** Returns a millisecond timestamp for Gateway values that may already be numeric or ISO strings. */
function toTimestamp(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** Performs now iso. */
function nowIso(): string {
    const now = new Date();
    return now.toISOString();
}

function timestampToIso(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString();
}

/** Performs close stale active tasks. */
function closeStaleActiveTasks(): void {
    const cutoff = timestampToIso(Date.now() - TASK_IDLE_TIMEOUT_MS);
    database
        .prepare(
            `UPDATE agent_task_history
         SET status = 'completed_auto', completed_at = ?, last_activity_at = ?
         WHERE status = 'active' AND last_activity_at < ?`
        )
        .run(nowIso(), nowIso(), cutoff);
}

/** Finds the most recent non-finished task in agent history for active-task inference. */
function getActiveHistoryTask(agentId: string): AgentTaskHistoryItem | null {
    const row = database
        .prepare(
            `SELECT id, agent_id, task, status, started_at, completed_at, last_activity_at
         FROM agent_task_history
         WHERE agent_id = ? AND status = 'active'
         ORDER BY started_at DESC
         LIMIT 1`
        )
        .get(agentId) as
        | undefined
        | {
              id: number;
              agent_id: string;
              task: string;
              status: string;
              started_at: string;
              completed_at: string | null;
              last_activity_at: string;
          };

    if (!row) {
        return null;
    }

    return {
        id: row.id,
        agentId: row.agent_id,
        task: row.task,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        lastActivityAt: row.last_activity_at,
    };
}

/** Returns recently completed task-history entries for dashboard display. */
function getLatestCompletedTasks(limit = 8): AgentTaskHistoryItem[] {
    const rows = database
        .prepare(
            `SELECT id, agent_id, task, status, started_at, completed_at, last_activity_at
         FROM agent_task_history
         WHERE status != 'active' AND completed_at IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT ?`
        )
        .all(limit) as Array<{
        id: number;
        agent_id: string;
        task: string;
        status: string;
        started_at: string;
        completed_at: string | null;
        last_activity_at: string;
    }>;

    return rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        task: row.task,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        lastActivityAt: row.last_activity_at,
    }));
}

/** Parses agents.yml into dashboard agent records while tolerating empty or malformed input. */
function parseAgentsConfig(): AgentsConfig | null {
    const configPath = Path.join(getOpenclawRoot(), "openclaw.json");

    try {
        if (!FS.existsSync(configPath)) {
            return null;
        }

        const configStat = FS.lstatSync(configPath);
        if (configStat.isSymbolicLink() || configStat.nlink > 1) {
            return null;
        }
        const realRoot = FS.realpathSync(getOpenclawRoot());
        const realPath = FS.realpathSync(configPath);
        if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${Path.sep}`)) {
            return null;
        }

        const fd = FS.openSync(
            Buffer.from(realPath),
            FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
        );
        let content: string;
        try {
            content = FS.readFileSync(fd, "utf8");
        } finally {
            FS.closeSync(fd);
        }
        const parsed = JSON5.parse(content) as { agents?: AgentsConfig };

        if (parsed.agents && Array.isArray(parsed.agents.list)) {
            return parsed.agents;
        }
        return null;
    } catch (error) {
        console.error(
            `[Agents] Failed to parse OpenClaw config ${configPath}:`,
            (error as Error).message
        );
        return null;
    }
}

// Read agent metadata file for current task
/** Reads metadata.json for an agent using validated file access. */
async function getAgentMetadata(agentId: string): Promise<AgentMetadata | null> {
    const sessionsDirectory = getSafeAgentSessionsDirectory(agentId);
    if (!sessionsDirectory) {
        return null;
    }

    try {
        const content = await readTextNoFollowGuarded(
            guardedPath(Path.join(sessionsDirectory, "metadata.json"))
        );
        return JSON5.parse(content) as AgentMetadata;
    } catch {
        return null;
    }
}

// Get sessions from agent's sessions.json file
/** Loads cached session summaries from the agent sessions directory. */
async function getAgentSessionsFromFiles(agentId: string): Promise<SessionInfo[]> {
    const sessionsDirectory = getSafeAgentSessionsDirectory(agentId);
    if (!sessionsDirectory) {
        return [];
    }

    try {
        const content = await readTextNoFollowGuarded(
            guardedPath(Path.join(sessionsDirectory, "sessions.json"))
        );
        const sessions = JSON5.parse(content);
        return Array.isArray(sessions) ? sessions : [];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        console.error(
            "[Agents] Failed to read agent sessions.json:",
            (error as Error).message
        );
        return [];
    }
}

// Get activity from a JSONL session file
/** Captures the latest observed agent activity label and timestamp. */
interface ActivityInfo {
    task: string | null; // High-level task (from last user message)
    activity: string | null; // Current activity (from last tool use)
    modTime: number;
}

/** Describes one activity log root to scan for an agent. */
interface ActivityLogRoot {
    directory: string;
    recursive: boolean;
}

/** Describes one activity-bearing JSONL file. */
interface ActivityLogFile {
    name: string;
    path: string;
    mtime: number;
    group: string;
}

/** Builds file metadata for one JSONL log, returning null when it cannot be statted. */
function toActivityLogFile(
    root: ActivityLogRoot,
    relativePath: string,
    fullPath: string,
    statFile = statGuarded
): ActivityLogFile | null {
    try {
        const mtime = statFile(guardedPath(fullPath)).mtimeMs;
        const group = `${root.directory}:${relativePath
            .replace(/\.trajectory\.jsonl$/u, "")
            .replace(/\.jsonl$/u, "")}`;
        return { name: relativePath, path: fullPath, mtime, group };
    } catch {
        // Ignore files that disappear or become unreadable during scanning.
        return null;
    }
}

/** Lists JSONL activity files in a root while preserving paired file grouping. */
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

/** Cleans raw prompts/transcript text for dashboard task display. */
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
function summarizeToolActivity(toolName: string, raw: unknown): string {
    const normalizedTool = normalizeToolName(toolName);

    const parsed =
        typeof raw === "string"
            ? (() => {
                  try {
                      return JSON.parse(raw) as Record<string, unknown>;
                  } catch {
                      return { raw } as Record<string, unknown>;
                  }
              })()
            : raw && typeof raw === "object"
              ? (raw as Record<string, unknown>)
              : {};

    const arguments_ =
        parsed.arguments && typeof parsed.arguments === "object"
            ? (parsed.arguments as Record<string, unknown>)
            : parsed;

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
    if (["exec", "exec_command", "bash"].includes(normalizedTool) && command) {
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

/** Returns a canonical un-namespaced tool name for activity filtering and labels. */
function normalizeToolName(toolName: string): string {
    const parts = toolName.split(".");
    const unscoped = toolName.includes(".") ? parts[parts.length - 1] : toolName;
    return unscoped.replace(/^mcp__.+?__/, "").toLowerCase();
}

/** Returns whether a tool should be shown as user-facing current activity. */
function isVisibleActivityTool(toolName: string): boolean {
    const normalizedToolName = normalizeToolName(toolName);
    return normalizedToolName !== "message";
}

function getTrajectoryToolArguments(data: Record<string, unknown>): unknown {
    return data.arguments ?? data.args ?? data.input ?? data.parameters ?? data;
}

/** Extracts nested tool activity from Codex response-item session logs. */
function getCodexResponseItemActivity(entry: unknown): string | null {
    if (!entry || typeof entry !== "object") {
        return null;
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
        return null;
    }
    const input = typeof record.payload.input === "string" ? record.payload.input : "";
    if (/tools\.(?:mcp__[^.]+__)?message\s*\(/u.test(input)) {
        return null;
    }

    const nestedToolMatch = input.match(/tools\.([a-zA-Z0-9_]+)\s*\(/u);
    const nestedToolName = nestedToolMatch ? nestedToolMatch[1] : null;
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

/** Extracts activity details from OpenClaw v4 trajectory events. */
function getTrajectoryActivity(entry: unknown): {
    task?: string | null;
    activity?: string | null;
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
                arguments: getTrajectoryToolArguments(data as Record<string, unknown>),
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
                arguments: getTrajectoryToolArguments(data as Record<string, unknown>),
            }),
        };
    }

    return {};
}

/** Reads the newest activity marker from agent session files when live Gateway data is unavailable. */
async function getLatestActivityFromFile(agentId: string): Promise<ActivityInfo | null> {
    const roots = getSafeAgentActivityRoots(agentId);
    if (roots.length === 0) {
        return null;
    }

    try {
        const files = roots
            .flatMap((root) => listActivityLogFiles(root))
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) {
            return null;
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
            .sort((a, b) => b.modTime - a.modTime);
        const latestGroup = sortedGroups[0];
        const latestModificationTime = latestGroup.modTime;
        const now = Date.now();

        // If no session file has been modified in 5 minutes, agent is idle.
        if (now - latestModificationTime > STALE_THRESHOLD) {
            return { task: null, activity: null, modTime: latestModificationTime };
        }

        const getEntryTurnId = (entry: unknown): string | null => {
            if (!entry || typeof entry !== "object") return null;
            const raw = entry as {
                __openclaw?: { mirrorIdentity?: unknown };
                message?: { __openclaw?: { mirrorIdentity?: unknown } };
                data?: { turnId?: unknown };
            };
            if (typeof raw.data?.turnId === "string") return raw.data.turnId;

            const mirrorIdentity =
                typeof raw.__openclaw?.mirrorIdentity === "string"
                    ? raw.__openclaw.mirrorIdentity
                    : typeof raw.message?.__openclaw?.mirrorIdentity === "string"
                      ? raw.message.__openclaw.mirrorIdentity
                      : null;
            return mirrorIdentity ? mirrorIdentity.split(":", 1)[0] || null : null;
        };

        let pendingTask: string | null = null;
        let pendingTaskTurnId: string | null = null;
        let selectedActivity: string | null = null;
        let isLatestGroup = true;

        const scanActivityFile = async (
            file: ActivityLogFile,
            groupTaskTurnId: string | null,
            pendingTaskTurnId: string | null
        ) => {
            if (now - file.mtime > STALE_THRESHOLD) {
                return {
                    task: null,
                    taskTurnId: null,
                    activity: null,
                };
            }

            let content: string;
            try {
                content = await readTextNoFollowGuarded(guardedPath(file.path));
            } catch {
                return {
                    task: null,
                    taskTurnId: null,
                    activity: null,
                };
            }

            const lines = content.trim().split("\n");
            let fileTask: string | null = null;
            let fileTaskTurnId: string | null = null;
            let fileActivity: string | null = null;
            let fileRunId: string | null = null;

            // Scan from end to find most recent user message and visible tool use.
            for (let index = lines.length - 1; index >= 0; index--) {
                try {
                    const entry = JSON.parse(lines[index]);
                    const record = entry as { runId?: unknown; type?: string };
                    const entryRunId =
                        typeof record.runId === "string" ? record.runId : null;
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

                    const entryTurnId = getEntryTurnId(entry);
                    const trajectoryActivity = getTrajectoryActivity(entry);
                    if (!fileTask && trajectoryActivity.task) {
                        fileTask = cleanTaskText(trajectoryActivity.task);
                        fileTaskTurnId = entryTurnId;
                    }
                    if (!fileActivity && trajectoryActivity.activity) {
                        fileActivity = trajectoryActivity.activity;
                    }

                    const codexActivity = getCodexResponseItemActivity(entry);
                    if (!fileActivity && codexActivity) {
                        fileActivity = codexActivity;
                    }

                    const message = entry.message || entry;

                    // First user message from end = current task
                    if (message.role === "user" && message.content && !fileTask) {
                        const text =
                            typeof message.content === "string"
                                ? message.content
                                : Array.isArray(message.content)
                                  ? message.content
                                        .filter(
                                            (c: { type?: string }) => c.type === "text"
                                        )
                                        .map((c: { text?: string }) => c.text)
                                        .join(" ")
                                  : String(message.content);

                        // Clean metadata and extract actual message
                        fileTask = cleanTaskText(text) || null;
                        fileTaskTurnId = entryTurnId;
                    }

                    // First visible tool use from end = current activity.
                    if (
                        message.role === "assistant" &&
                        Array.isArray(message.content) &&
                        !fileActivity
                    ) {
                        const toolCall = message.content.find(
                            (c: { type?: string; name?: string }) =>
                                c.type === "toolCall" &&
                                typeof c.name === "string" &&
                                isVisibleActivityTool(c.name)
                        ) as
                            | undefined
                            | {
                                  name?: string;
                                  arguments?: unknown;
                                  partialJson?: string;
                                  [key: string]: unknown;
                              };
                        const expectedTurnId =
                            fileTaskTurnId || groupTaskTurnId || pendingTaskTurnId;
                        const canUseToolCall =
                            !expectedTurnId || entryTurnId === expectedTurnId;
                        if (toolCall?.name && canUseToolCall) {
                            fileActivity = summarizeToolActivity(toolCall.name, toolCall);
                        }
                    }

                    if (fileTask && fileActivity) {
                        break;
                    }
                } catch {
                    // Skip malformed lines
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
            pendingTaskTurnId: string | null
        ) => {
            let groupTask: string | null = null;
            let groupTaskTurnId: string | null = null;
            let groupActivity: string | null = null;

            const sortedFiles = group.files.sort((a, b) => b.mtime - a.mtime);
            for (const file of sortedFiles) {
                const {
                    task: fileTask,
                    taskTurnId: fileTaskTurnId,
                    activity: fileActivity,
                } = await scanActivityFile(file, groupTaskTurnId, pendingTaskTurnId);

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
        return null;
    }
}

/** Returns the modification time for a session file, or null when it cannot be read. */
function getSessionFileModificationTime(agentId: string): number | null {
    const roots = getSafeAgentActivityRoots(agentId);
    if (roots.length === 0) {
        return null;
    }

    try {
        let latestModificationTime = 0;
        for (const root of roots) {
            for (const file of listActivityLogFiles(root)) {
                latestModificationTime = Math.max(latestModificationTime, file.mtime);
            }
        }
        return latestModificationTime > 0 ? latestModificationTime : null;
    } catch {
        return null;
    }
}

/** Infers the source channel encoded in an OpenClaw session key. */
function getChannelFromSessionKey(sessionKey: string): string | null {
    const parts = sessionKey.split(":");
    if (parts[0] === "channel") {
        return parts[1] || null;
    }
    return null;
}

/** Performs determine status. */
function determineStatus(
    lastModificationTime: number | null
): "active" | "thinking" | "idle" {
    if (!lastModificationTime) return "idle";

    const now = Date.now();
    const elapsed = now - lastModificationTime;

    if (elapsed < ACTIVE_THRESHOLD) {
        return "active";
    }
    if (elapsed < THINKING_THRESHOLD) {
        return "thinking";
    }
    return "idle";
}

/** Performs find best session for agent. */
function findBestSessionForAgent(
    agentId: string,
    sessions: GatewaySessionSummary[]
): GatewaySessionSummary | undefined {
    const prefix = `agent:${agentId.toLowerCase()}:`;
    const matches = sessions.filter((session) =>
        session.key.toLowerCase().startsWith(prefix)
    );

    if (matches.length === 0) {
        return undefined;
    }

    const preferredKinds = [
        ":main",
        ":discord:",
        ":telegram:",
        ":signal:",
        ":whatsapp:",
        ":slack:",
        ":imessage:",
        ":line:",
        ":irc:",
        ":googlechat:",
        ":channel:",
    ];

    return matches.sort((a, b) => {
        const timeA = toTimestamp(a.updatedAt) || 0;
        const timeB = toTimestamp(b.updatedAt) || 0;
        const keyA = a.key.toLowerCase();
        const keyB = b.key.toLowerCase();
        const preferredA = Number(preferredKinds.some((part) => keyA.includes(part)));
        const preferredB = Number(preferredKinds.some((part) => keyB.includes(part)));

        if (preferredA !== preferredB) {
            return preferredB - preferredA;
        }

        return timeB - timeA;
    })[0];
}

/** Finds a Gateway session by key using OpenClaw's case-insensitive session-key semantics. */
function findSessionByKey(
    sessions: GatewaySessionSummary[],
    sessionKey: string
): GatewaySessionSummary | undefined {
    const normalizedKey = sessionKey.toLowerCase();
    return sessions.find((session) => session.key.toLowerCase() === normalizedKey);
}

/** Returns whether Gateway reports a session as currently running. */
function isGatewaySessionRunning(session: GatewaySessionSummary | undefined): boolean {
    if (!session || toTimestamp(session.endedAt)) {
        return false;
    }

    return (
        session.running === true ||
        session.isRunning === true ||
        session.status === "running" ||
        Boolean(session.activeRunId || session.currentRunId)
    );
}

/** Applies live Gateway session state to a dashboard agent status. */
function applyGatewaySessionStatus(
    status: AgentStatus,
    session: GatewaySessionSummary | undefined
): void {
    if (!session) {
        return;
    }
    status.sessionKey ||= session.key;
    status.channel = getChannelFromSessionKey(session.key);

    const updatedAt = toTimestamp(session.updatedAt);
    if (
        updatedAt &&
        (!status.lastActivity || updatedAt > Date.parse(status.lastActivity))
    ) {
        status.lastActivity = timestampToIso(updatedAt);
    }

    if (isGatewaySessionRunning(session)) {
        status.status = status.currentActivity ? "active" : "thinking";
    }
}

/** Builds one dashboard agent status by combining config, metadata, sessions, and activity hints. */
async function getAgentStatus(agentId: string): Promise<AgentStatus> {
    // Current task priority: active history task -> metadata -> inferred activity
    const activeTask = getActiveHistoryTask(agentId);
    const metadata = await getAgentMetadata(agentId);

    // Get sessions from agent's sessions.json file
    const fileSessions = await getAgentSessionsFromFiles(agentId);

    // Find most recent session
    let latestSession: SessionInfo | null = null;
    let latestTime = 0;

    for (const session of fileSessions) {
        const sessionTime = session.updatedAt || 0;
        if (sessionTime > latestTime) {
            latestTime = sessionTime;
            latestSession = session;
        }
    }

    // Get activity from JSONL file
    const activity = await getLatestActivityFromFile(agentId);

    // Determine status from file modification time
    const fileModificationTime =
        activity?.modTime || getSessionFileModificationTime(agentId);
    const status = determineStatus(fileModificationTime);

    const sessionKey = latestSession?.key || null;
    const channel = sessionKey ? getChannelFromSessionKey(sessionKey) : null;
    const effectiveModificationTime = fileModificationTime || 0;

    const currentTask =
        activeTask?.task || metadata?.currentTask || activity?.task || null;

    return {
        id: agentId,
        status,
        model: "unknown", // Will be filled from config
        currentTask,
        currentActivity: activity?.activity || null,
        lastActivity:
            effectiveModificationTime > 0
                ? timestampToIso(effectiveModificationTime)
                : null,
        sessionKey,
        channel,
    };
}

/** Builds all dashboard agent statuses for a parsed agent config. */
async function buildAgentStatuses(config: AgentsConfig): Promise<AgentStatus[]> {
    const defaultModel = config.defaults?.model?.primary || "unknown";
    const sessions = await getGatewaySessionsForAgents();

    return Promise.all(
        config.list.map(async (agent) => {
            const status = await getAgentStatus(agent.id);
            const configuredModel = resolveConfiguredModelName(
                agent.model?.primary || defaultModel,
                config
            );
            const sessionFromKey = status.sessionKey
                ? findSessionByKey(sessions, status.sessionKey)
                : undefined;
            const matchingSession =
                sessionFromKey || findBestSessionForAgent(agent.id, sessions);
            if (!sessionFromKey && matchingSession) {
                status.sessionKey = matchingSession.key;
            }
            applyGatewaySessionStatus(status, matchingSession);
            const rawSessionModel = normalizeGatewaySessionModel(matchingSession?.model);
            const sessionModel = rawSessionModel
                ? toDisplayModelName(rawSessionModel)
                : undefined;
            status.model =
                sessionModel && sessionModel !== configuredModel
                    ? sessionModel
                    : configuredModel;
            return status;
        })
    );
}

/** Builds one dashboard agent status when the id exists in config. */
async function buildSingleAgentStatus(
    agentId: string,
    config: AgentsConfig
): Promise<AgentStatus | null> {
    const agentConfig = config.list.find((agent) => agent.id === agentId);
    if (!agentConfig) {
        return null;
    }

    const status = await getAgentStatus(agentId);
    const sessions = await getGatewaySessionsForAgents();
    const configuredModel = resolveConfiguredModelName(
        agentConfig.model?.primary || config.defaults?.model?.primary,
        config
    );
    const sessionFromKey = status.sessionKey
        ? findSessionByKey(sessions, status.sessionKey)
        : undefined;
    const matchingSession = sessionFromKey || findBestSessionForAgent(agentId, sessions);
    if (!sessionFromKey && matchingSession) {
        status.sessionKey = matchingSession.key;
    }
    applyGatewaySessionStatus(status, matchingSession);
    const rawSessionModel = normalizeGatewaySessionModel(matchingSession?.model);
    const sessionModel = rawSessionModel
        ? toDisplayModelName(rawSessionModel)
        : undefined;
    status.model =
        sessionModel && sessionModel !== configuredModel ? sessionModel : configuredModel;

    return status;
}

function normalizeGatewaySessionModel(model: string | undefined): string | undefined {
    if (!model || model.toLowerCase() === "unknown") {
        return undefined;
    }
    return model;
}

/** Registers agents API routes. */
export default function agentsRoutes(app: express.Application): void {
    app.use("/api/agents/:id/metadata", express.json());

    // Get agent configuration
    app.get(
        "/api/agents/config",
        asyncRoute(
            async (_request, response) => {
                const config = parseAgentsConfig();
                if (!config) {
                    response.status(404).json({ error: "Agent configuration not found" });
                    return;
                }

                response.json(config);
            },
            { fallback: "Agent config failed", logLabel: "[Agents] Config error:" }
        )
    );

    // Get all agents with status
    app.get(
        "/api/agents/status",
        asyncRoute(
            async (_request, response) => {
                closeStaleActiveTasks();
                const config = parseAgentsConfig();
                if (!config) {
                    response.status(404).json({ error: "Agent configuration not found" });
                    return;
                }
                const agents = await buildAgentStatuses(config);
                response.json({ agents, timestamp: Date.now() });
            },
            { fallback: "Agent status failed", logLabel: "[Agents] Status error:" }
        )
    );

    // Get single agent status
    app.get(
        "/api/agents/:id/status",
        asyncRoute(
            async (request, response) => {
                const agentId = getRouteParameter(request.params.id);
                if (!isValidAgentId(agentId)) {
                    response.status(400).json({ error: "Invalid agent ID" });
                    return;
                }
                closeStaleActiveTasks();
                const config = parseAgentsConfig();
                if (!config) {
                    response.status(404).json({ error: "Agent configuration not found" });
                    return;
                }

                const status = await buildSingleAgentStatus(agentId, config);
                if (!status) {
                    response.status(404).json({ error: `Agent '${agentId}' not found` });
                    return;
                }

                response.json(status);
            },
            { fallback: "Agent status failed", logLabel: "[Agents] Status error:" }
        )
    );

    // Latest completed tasks across agents
    app.get(
        "/api/agents/tasks/history",
        asyncRoute(
            async (request, response) => {
                const limit = Math.max(1, Math.min(20, Number(request.query.limit) || 8));
                closeStaleActiveTasks();
                const tasks = getLatestCompletedTasks(limit);
                response.json({ tasks, timestamp: Date.now() });
            },
            {
                fallback: "Agent task history failed",
                logLabel: "[Agents] Task history error:",
            }
        )
    );

    // Update agent metadata (current task)
    app.put(
        "/api/agents/:id/metadata",
        asyncRoute(
            async (request, response) => {
                const agentId = getRouteParameter(request.params.id);
                if (!isValidAgentId(agentId)) {
                    response.status(400).json({ error: "Invalid agent ID" });
                    return;
                }

                const body = request.body as null | { currentTask?: unknown };
                const currentTask =
                    body && typeof body === "object" ? body.currentTask : undefined;

                if (typeof currentTask !== "string" || currentTask.trim().length === 0) {
                    response.status(400).json({ error: "Provide currentTask" });
                    return;
                }
                const metadataPath = safePathWithinRoot(
                    Path.join(agentId, "sessions", "metadata.json"),
                    getAgentsDirectory()
                );
                if (!metadataPath) {
                    response.status(400).json({ error: "Invalid agent ID" });
                    return;
                }
                const metadataDirectory = Path.dirname(metadataPath as string);

                const realAgentsDirectory = ensureRealAgentsDirectory();
                if (!realAgentsDirectory) {
                    response.status(400).json({ error: "Invalid agent metadata path" });
                    return;
                }
                const agentsDirectory = getAgentsDirectory();
                const expectedSessionsDirectory = Path.join(
                    agentsDirectory,
                    agentId,
                    "sessions"
                );
                const canonicalExpectedSessionsDirectory = Path.join(
                    realAgentsDirectory,
                    agentId,
                    "sessions"
                );
                const safeSessionsDirectory = prepareAgentMetadataDirectoryForWrite(
                    expectedSessionsDirectory,
                    agentsDirectory
                );
                if (safeSessionsDirectory !== canonicalExpectedSessionsDirectory) {
                    response.status(400).json({ error: "Invalid agent metadata path" });
                    return;
                }
                const expectedSessionsParent = Path.dirname(safeSessionsDirectory);
                let realExpectedSessionsParent: string;
                try {
                    mkdirChildFromVerifiedParent(realAgentsDirectory, agentId);
                    realExpectedSessionsParent = FS.realpathSync(expectedSessionsParent);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOTSUP") {
                        realExpectedSessionsParent =
                            realExistingChildDirectoryFromVerifiedParent(
                                realAgentsDirectory,
                                agentId
                            );
                    } else {
                        throw error;
                    }
                }
                if (
                    realExpectedSessionsParent !==
                        Path.dirname(canonicalExpectedSessionsDirectory) ||
                    !FS.statSync(realExpectedSessionsParent).isDirectory()
                ) {
                    response.status(400).json({ error: "Invalid agent metadata path" });
                    return;
                }
                let realExpectedSessionsDirectory: string;
                try {
                    mkdirChildFromVerifiedParent(realExpectedSessionsParent, "sessions");
                    realExpectedSessionsDirectory = FS.realpathSync(
                        expectedSessionsDirectory
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOTSUP") {
                        realExpectedSessionsDirectory =
                            realExistingChildDirectoryFromVerifiedParent(
                                realExpectedSessionsParent,
                                "sessions"
                            );
                    } else {
                        throw error;
                    }
                }
                const realMetadataDirectory = FS.realpathSync(metadataDirectory);
                if (
                    realMetadataDirectory !== realExpectedSessionsDirectory ||
                    realExpectedSessionsDirectory !==
                        canonicalExpectedSessionsDirectory ||
                    !FS.statSync(realExpectedSessionsDirectory).isDirectory() ||
                    !FS.statSync(realMetadataDirectory).isDirectory()
                ) {
                    response.status(400).json({ error: "Invalid agent metadata path" });
                    return;
                }

                const safeMetadataPath = Path.join(
                    realMetadataDirectory,
                    "metadata.json"
                );

                // Read existing metadata or create new (atomic read, no existsSync check)
                let metadata: AgentMetadata = {};
                try {
                    // lgtm[js/path-injection] safeMetadataPath is re-canonicalized after mkdir and remains under AGENTS_DIR.
                    const metadataText = await readTextNoFollowGuarded(
                        guardedPath(safeMetadataPath)
                    );
                    let parsedMetadata: unknown;
                    try {
                        parsedMetadata = JSON5.parse(metadataText) as unknown;
                    } catch (parseError) {
                        console.warn(
                            `[Agents] Ignoring malformed metadata for ${agentId} at ${safeMetadataPath}:`,
                            (parseError as Error).message
                        );
                        parsedMetadata = {};
                    }
                    metadata =
                        parsedMetadata &&
                        typeof parsedMetadata === "object" &&
                        !Array.isArray(parsedMetadata)
                            ? (parsedMetadata as AgentMetadata)
                            : {};
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }
                }

                const safeTask = currentTask.trim().slice(0, 100);
                const ts = nowIso();

                if (safeTask && safeTask.length > 0) {
                    metadata.currentTask = safeTask;
                }

                metadata.updatedAt = ts;

                const latestMetadataDirectory = FS.realpathSync(metadataDirectory);
                if (latestMetadataDirectory !== realExpectedSessionsDirectory) {
                    response.status(400).json({ error: "Invalid agent metadata path" });
                    return;
                }

                // Write back using O_NOFOLLOW so a swapped final metadata.json symlink is rejected at open time.
                await writeTextNoFollowGuarded(
                    guardedPath(Path.join(latestMetadataDirectory, "metadata.json")),
                    JSON.stringify(metadata, null, 2)
                );

                try {
                    // Auto history handling on task changes after metadata is durably written.
                    if (safeTask && safeTask.length > 0) {
                        const currentActive = getActiveHistoryTask(agentId);
                        if (!currentActive) {
                            database
                                .prepare(
                                    `INSERT INTO agent_task_history (agent_id, task, status, started_at, last_activity_at)
                             VALUES (?, ?, 'active', ?, ?)`
                                )
                                .run(agentId, safeTask, ts, ts);
                        } else if (currentActive.task === safeTask) {
                            database
                                .prepare(
                                    `UPDATE agent_task_history SET last_activity_at = ? WHERE id = ?`
                                )
                                .run(ts, currentActive.id);
                        } else {
                            database
                                .prepare(
                                    `UPDATE agent_task_history
                             SET status = 'completed', completed_at = ?, last_activity_at = ?
                             WHERE id = ?`
                                )
                                .run(ts, ts, currentActive.id);

                            database
                                .prepare(
                                    `INSERT INTO agent_task_history (agent_id, task, status, started_at, last_activity_at)
                             VALUES (?, ?, 'active', ?, ?)`
                                )
                                .run(agentId, safeTask, ts, ts);
                        }
                    }
                } catch (error) {
                    console.error("[Agents] Task history sync failed:", error);
                }
                response.json(metadata);
            },
            {
                fallback: "Agent metadata update failed",
                logLabel: "[Agents] Metadata update error:",
            }
        )
    );
}
