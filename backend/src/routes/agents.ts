import express, { type RequestHandler } from "express";
import FS from "fs";
import JSON5 from "json5";
import Path from "path";

import { db } from "../db.js";
import gateway from "../gateway.js";
import {
    guardedPath,
    mkdirGuarded,
    readdirGuarded,
    readTextNoFollowGuarded,
    statGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";
import { safePathWithinRoot } from "../lib/safePath.js";

const OPENCLAW_ROOT = (process.env.HOME || "") + "/.openclaw";
const AGENTS_DIR = Path.join(OPENCLAW_ROOT, "agents");

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

/** Returns the canonical sessions directory for a validated agent id. */
function getSafeAgentSessionsDir(agentId: string): string | null {
    if (!isValidAgentId(agentId)) {
        return null;
    }

    const sessionsDir = safePathWithinRoot(Path.join(agentId, "sessions"), AGENTS_DIR);
    if (!sessionsDir) {
        return null;
    }

    try {
        const realAgentsDir = FS.realpathSync(AGENTS_DIR);
        const expectedSessionsDir = Path.join(realAgentsDir, agentId, "sessions");
        return sessionsDir === expectedSessionsDir ? sessionsDir : null;
    } catch {
        return null;
    }
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
    model: string;
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
    const cached = gateway.getSessions().map((session) => ({
        key: session.key,
        model: session.model,
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

        if (Array.isArray(result.sessions) && result.sessions.length > 0) {
            return result.sessions
                .filter(
                    (session) => typeof session.key === "string" && session.key.length > 0
                )
                .map((session) => ({
                    key: session.key || "",
                    model: session.model || "Unknown",
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
    return new Date().toISOString();
}

/** Performs close stale active tasks. */
function closeStaleActiveTasks(): void {
    const cutoff = new Date(Date.now() - TASK_IDLE_TIMEOUT_MS).toISOString();
    db.prepare(
        `UPDATE agent_task_history
         SET status = 'completed_auto', completed_at = ?, last_activity_at = ?
         WHERE status = 'active' AND last_activity_at < ?`
    ).run(nowIso(), nowIso(), cutoff);
}

/** Finds the most recent non-finished task in agent history for active-task inference. */
function getActiveHistoryTask(agentId: string): AgentTaskHistoryItem | null {
    const row = db
        .prepare(
            `SELECT id, agent_id, task, status, started_at, completed_at, last_activity_at
         FROM agent_task_history
         WHERE agent_id = ? AND status = 'active'
         ORDER BY started_at DESC
         LIMIT 1`
        )
        .get(agentId) as
        | {
              id: number;
              agent_id: string;
              task: string;
              status: string;
              started_at: string;
              completed_at: string | null;
              last_activity_at: string;
          }
        | undefined;

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
    const rows = db
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
    const configPath = Path.join(OPENCLAW_ROOT, "openclaw.json");

    try {
        if (!FS.existsSync(configPath)) {
            return null;
        }

        const content = FS.readFileSync(configPath, "utf8");
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
    const sessionsDir = getSafeAgentSessionsDir(agentId);
    if (!sessionsDir) {
        return null;
    }

    try {
        const content = await readTextNoFollowGuarded(
            guardedPath(Path.join(sessionsDir, "metadata.json"))
        );
        return JSON5.parse(content) as AgentMetadata;
    } catch {
        return null;
    }
}

// Get sessions from agent's sessions.json file
/** Loads cached session summaries from the agent sessions directory. */
async function getAgentSessionsFromFiles(agentId: string): Promise<SessionInfo[]> {
    const sessionsDir = getSafeAgentSessionsDir(agentId);
    if (!sessionsDir) {
        return [];
    }

    try {
        const content = await readTextNoFollowGuarded(
            guardedPath(Path.join(sessionsDir, "sessions.json"))
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

/** Performs summarize tool activity. */
function summarizeToolActivity(toolName: string, raw: unknown): string {
    const normalizedTool = toolName.includes(".")
        ? toolName.split(".").pop() || toolName
        : toolName;

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

    const args =
        parsed.arguments && typeof parsed.arguments === "object"
            ? (parsed.arguments as Record<string, unknown>)
            : parsed;

    const nested =
        args.parameters && typeof args.parameters === "object"
            ? (args.parameters as Record<string, unknown>)
            : {};

    const path = (args.path ||
        args.file_path ||
        args.filePath ||
        (Array.isArray(args.paths) ? args.paths[0] : undefined) ||
        (args.input && typeof args.input === "object"
            ? (args.input as Record<string, unknown>).path
            : undefined) ||
        nested.path ||
        nested.file_path ||
        nested.filePath ||
        (Array.isArray(nested.paths) ? nested.paths[0] : undefined)) as
        | string
        | undefined;
    const command = (args.command || args.cmd || nested.command || nested.cmd) as
        | string
        | undefined;
    const action = (args.action || nested.action) as string | undefined;
    const message = (args.message || args.text || nested.message || nested.text) as
        | string
        | undefined;
    const url = (args.url || nested.url) as string | undefined;

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
    if (
        (normalizedTool === "exec" ||
            normalizedTool === "exec_command" ||
            normalizedTool === "bash") &&
        command
    ) {
        return `exec ${command.slice(0, 70)}`;
    }
    if (normalizedTool === "message" && message) {
        return `message ${message.replaceAll(/\s+/g, " ").trim().slice(0, 70)}`;
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
        data.name !== "message"
    ) {
        return {
            activity: summarizeToolActivity(data.name, {
                arguments:
                    data.arguments || data.args || data.input || data.parameters || data,
            }),
        };
    }

    if (
        record.type === "tool.result" &&
        typeof data.name === "string" &&
        data.name !== "message" &&
        (data.arguments || data.args || data.input || data.parameters)
    ) {
        return {
            activity: summarizeToolActivity(data.name, data),
        };
    }

    return {};
}

/** Reads the newest activity marker from agent session files when live Gateway data is unavailable. */
async function getLatestActivityFromFile(agentId: string): Promise<ActivityInfo | null> {
    const sessionsDir = getSafeAgentSessionsDir(agentId);
    if (!sessionsDir) {
        return null;
    }

    try {
        // Find most recently modified JSONL file
        const files = readdirGuarded(guardedPath(sessionsDir), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .flatMap((entry) => {
                const sessionPath = Path.join(sessionsDir, entry.name);
                try {
                    return [
                        {
                            name: entry.name,
                            path: sessionPath,
                            mtime: statGuarded(guardedPath(sessionPath)).mtimeMs,
                        },
                    ];
                } catch {
                    return [];
                }
            })
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) {
            return null;
        }

        const latestFile = files[0];
        const now = Date.now();

        // If file hasn't been modified in 5 minutes, agent is idle
        if (now - latestFile.mtime > STALE_THRESHOLD) {
            return { task: null, activity: null, modTime: latestFile.mtime };
        }

        // Read the file and find last user message and tool use
        const content = await readTextNoFollowGuarded(guardedPath(latestFile.path));
        const lines = content.trim().split("\n");

        let lastTask: string | null = null;
        let lastActivity: string | null = null;

        // Scan from end to find most recent user message and tool use
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                const trajectoryActivity = getTrajectoryActivity(entry);
                if (!lastTask && trajectoryActivity.task) {
                    lastTask = trajectoryActivity.task
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
                if (!lastActivity && trajectoryActivity.activity) {
                    lastActivity = trajectoryActivity.activity;
                }

                const msg = entry.message || entry;

                // First user message from end = current task
                if (msg.role === "user" && msg.content && !lastTask) {
                    let text =
                        typeof msg.content === "string"
                            ? msg.content
                            : Array.isArray(msg.content)
                              ? msg.content
                                    .filter((c: { type?: string }) => c.type === "text")
                                    .map((c: { text?: string }) => c.text)
                                    .join(" ")
                              : String(msg.content);

                    // Clean metadata and extract actual message
                    text = text
                        .replaceAll(/```json[\s\S]*?```/g, "")
                        .replaceAll(/```[\s\S]*?```/g, "")
                        .replaceAll(/\[media attached[^\]]*\]/g, "")
                        .replaceAll(/Conversation info[^\n]*/g, "")
                        .replaceAll(/Sender[^\n]*/g, "")
                        .replaceAll(/\n+/g, " ")
                        .replaceAll(/\s+/g, " ")
                        .trim()
                        .slice(0, 100);

                    lastTask = text || null;
                }

                // First tool use from end = current activity
                if (
                    msg.role === "assistant" &&
                    Array.isArray(msg.content) &&
                    !lastActivity
                ) {
                    const toolCalls = msg.content.filter(
                        (c: { type?: string }) => c.type === "toolCall"
                    );
                    if (toolCalls.length > 0) {
                        const toolCall = toolCalls[0] as {
                            name?: string;
                            arguments?: unknown;
                            partialJson?: string;
                            [key: string]: unknown;
                        };
                        const toolName = toolCall.name || "unknown";
                        lastActivity = summarizeToolActivity(toolName, toolCall);
                    }
                }

                // Stop if we found both
                if (lastTask && lastActivity) break;
            } catch {
                // Skip malformed lines
            }
        }

        return {
            task: lastTask,
            activity: lastActivity,
            modTime: latestFile.mtime,
        };
    } catch {
        return null;
    }
}

/** Returns the modification time for a session file, or null when it cannot be read. */
function getSessionFileModTime(agentId: string): number | null {
    const sessionsDir = getSafeAgentSessionsDir(agentId);
    if (!sessionsDir) {
        return null;
    }

    try {
        const files = readdirGuarded(guardedPath(sessionsDir), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => entry.name);
        let latestModTime = 0;

        for (const file of files) {
            const filePath = Path.join(sessionsDir, file);
            try {
                const stat = statGuarded(guardedPath(filePath));
                if (stat.mtimeMs > latestModTime) {
                    latestModTime = stat.mtimeMs;
                }
            } catch {
                // Ignore errors for individual files
            }
        }

        return latestModTime > 0 ? latestModTime : null;
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
function determineStatus(lastModTime: number | null): "active" | "thinking" | "idle" {
    if (!lastModTime) return "idle";

    const now = Date.now();
    const elapsed = now - lastModTime;

    if (elapsed < ACTIVE_THRESHOLD) {
        return "active";
    } else if (elapsed < THINKING_THRESHOLD) {
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
        const preferredA = preferredKinds.some((part) => keyA.includes(part)) ? 1 : 0;
        const preferredB = preferredKinds.some((part) => keyB.includes(part)) ? 1 : 0;

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

    status.sessionKey = status.sessionKey || session.key;
    status.channel = status.channel || getChannelFromSessionKey(session.key);

    const updatedAt = toTimestamp(session.updatedAt);
    if (
        updatedAt &&
        (!status.lastActivity || updatedAt > Date.parse(status.lastActivity))
    ) {
        status.lastActivity = new Date(updatedAt).toISOString();
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
    const fileModTime = activity?.modTime || getSessionFileModTime(agentId);
    const status = determineStatus(fileModTime);

    const sessionKey = latestSession?.key || null;
    const channel = sessionKey ? getChannelFromSessionKey(sessionKey) : null;
    const effectiveModTime = fileModTime || 0;

    const currentTask =
        activeTask?.task || metadata?.currentTask || activity?.task || null;

    return {
        id: agentId,
        status,
        model: "unknown", // Will be filled from config
        currentTask,
        currentActivity: activity?.activity || null,
        lastActivity:
            effectiveModTime > 0 ? new Date(effectiveModTime).toISOString() : null,
        sessionKey,
        channel,
    };
}

/** Registers agents API routes. */
export default function agentsRoutes(app: express.Application): void {
    app.use("/api/agents/:id/metadata", express.json());

    // Get agent configuration
    app.get("/api/agents/config", (async (_req, res) => {
        try {
            const config = parseAgentsConfig();
            if (!config) {
                res.status(404).json({ error: "Agent configuration not found" });
                return;
            }

            res.json(config);
        } catch (error) {
            console.error("[Agents] Config error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Get all agents with status
    app.get("/api/agents/status", (async (_req, res) => {
        try {
            closeStaleActiveTasks();
            const config = parseAgentsConfig();
            if (!config) {
                res.status(404).json({ error: "Agent configuration not found" });
                return;
            }

            const defaultModel = config.defaults?.model?.primary || "unknown";
            const sessions = await getGatewaySessionsForAgents();

            const agents: AgentStatus[] = await Promise.all(
                config.list.map(async (agent) => {
                    const status = await getAgentStatus(agent.id);
                    const configuredModel = resolveConfiguredModelName(
                        agent.model?.primary || defaultModel,
                        config
                    );
                    const matchingSession = status.sessionKey
                        ? findSessionByKey(sessions, status.sessionKey)
                        : findBestSessionForAgent(agent.id, sessions);
                    applyGatewaySessionStatus(status, matchingSession);
                    status.model =
                        matchingSession?.model &&
                        matchingSession.model !== configuredModel
                            ? matchingSession.model
                            : configuredModel;
                    return status;
                })
            );

            res.json({ agents, timestamp: Date.now() });
        } catch (error) {
            console.error("[Agents] Status error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Get single agent status
    app.get("/api/agents/:id/status", (async (req, res) => {
        try {
            const agentId = Array.isArray(req.params.id)
                ? req.params.id[0]
                : req.params.id;

            if (!isValidAgentId(agentId)) {
                res.status(400).json({ error: "Invalid agent ID" });
                return;
            }

            closeStaleActiveTasks();
            const config = parseAgentsConfig();

            if (!config) {
                res.status(404).json({ error: "Agent configuration not found" });
                return;
            }

            const agentConfig = config.list.find((a) => a.id === agentId);
            if (!agentConfig) {
                res.status(404).json({ error: `Agent '${agentId}' not found` });
                return;
            }

            const status = await getAgentStatus(agentId);
            const sessions = await getGatewaySessionsForAgents();
            const configuredModel = resolveConfiguredModelName(
                agentConfig.model?.primary || config.defaults?.model?.primary,
                config
            );
            const matchingSession = status.sessionKey
                ? findSessionByKey(sessions, status.sessionKey)
                : findBestSessionForAgent(agentId, sessions);
            applyGatewaySessionStatus(status, matchingSession);
            status.model =
                matchingSession?.model && matchingSession.model !== configuredModel
                    ? matchingSession.model
                    : configuredModel;

            res.json(status);
        } catch (error) {
            console.error("[Agents] Status error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Latest completed tasks across agents
    app.get("/api/agents/tasks/history", (async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 8));
            closeStaleActiveTasks();
            const tasks = getLatestCompletedTasks(limit);
            res.json({ tasks, timestamp: Date.now() });
        } catch (error) {
            console.error("[Agents] Task history error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Update agent metadata (current task)
    app.put("/api/agents/:id/metadata", (async (req, res) => {
        try {
            const agentId = Array.isArray(req.params.id)
                ? req.params.id[0]
                : req.params.id;

            if (!isValidAgentId(agentId)) {
                res.status(400).json({ error: "Invalid agent ID" });
                return;
            }
            const safeAgentId = agentId.replaceAll(/[^a-zA-Z0-9._-]/gu, "");

            const { currentTask } = req.body as { currentTask?: string };

            if (!currentTask || currentTask.trim().length === 0) {
                res.status(400).json({ error: "Provide currentTask" });
                return;
            }

            FS.mkdirSync(AGENTS_DIR, { recursive: true });
            const metadataPath = safePathWithinRoot(
                Path.join(safeAgentId, "sessions", "metadata.json"),
                AGENTS_DIR
            );

            if (!metadataPath) {
                res.status(400).json({ error: "Invalid agent metadata path" });
                return;
            }

            const metadataDir = Path.dirname(metadataPath);

            // lgtm[js/path-injection] metadataDir is derived from isValidAgentId + safePathWithinRoot under AGENTS_DIR.
            mkdirGuarded(guardedPath(metadataDir), { recursive: true });

            const realAgentsDir = FS.realpathSync(AGENTS_DIR);
            const realMetadataDir = FS.realpathSync(metadataDir);
            if (
                realMetadataDir !== realAgentsDir &&
                !realMetadataDir.startsWith(realAgentsDir + Path.sep)
            ) {
                res.status(400).json({ error: "Invalid agent metadata path" });
                return;
            }

            const safeMetadataPath = Path.join(realMetadataDir, "metadata.json");

            // Read existing metadata or create new (atomic read, no existsSync check)
            let metadata: AgentMetadata = {};
            try {
                // lgtm[js/path-injection] safeMetadataPath is re-canonicalized after mkdir and remains under AGENTS_DIR.
                metadata = JSON5.parse(
                    await readTextNoFollowGuarded(guardedPath(safeMetadataPath))
                );
            } catch {
                // File doesn't exist or is unreadable; start fresh
            }

            const safeTask =
                typeof currentTask === "string"
                    ? currentTask.trim().slice(0, 100)
                    : undefined;
            const currentActive = getActiveHistoryTask(agentId);
            const ts = nowIso();

            // Auto history handling on task changes
            if (safeTask && safeTask.length > 0) {
                if (!currentActive) {
                    db.prepare(
                        `INSERT INTO agent_task_history (agent_id, task, status, started_at, last_activity_at)
                         VALUES (?, ?, 'active', ?, ?)`
                    ).run(agentId, safeTask, ts, ts);
                } else if (currentActive.task === safeTask) {
                    db.prepare(
                        `UPDATE agent_task_history SET last_activity_at = ? WHERE id = ?`
                    ).run(ts, currentActive.id);
                } else {
                    db.prepare(
                        `UPDATE agent_task_history
                         SET status = 'completed', completed_at = ?, last_activity_at = ?
                         WHERE id = ?`
                    ).run(ts, ts, currentActive.id);

                    db.prepare(
                        `INSERT INTO agent_task_history (agent_id, task, status, started_at, last_activity_at)
                         VALUES (?, ?, 'active', ?, ?)`
                    ).run(agentId, safeTask, ts, ts);
                }

                metadata.currentTask = safeTask;
            }

            metadata.updatedAt = ts;

            const latestMetadataDir = FS.realpathSync(metadataDir);
            if (latestMetadataDir !== realMetadataDir) {
                res.status(400).json({ error: "Invalid agent metadata path" });
                return;
            }

            // Write back using O_NOFOLLOW so a swapped final metadata.json symlink is rejected at open time.
            await writeTextNoFollowGuarded(
                guardedPath(Path.join(latestMetadataDir, "metadata.json")),
                JSON.stringify(metadata, null, 2)
            );
            res.json(metadata);
        } catch (error) {
            console.error("[Agents] Metadata update error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
