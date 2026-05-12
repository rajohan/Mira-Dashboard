import express, { type RequestHandler } from "express";
import FS from "fs";
import JSON5 from "json5";
import Path from "path";

import { db } from "../db.js";
import gateway from "../gateway.js";
import {
    guardedPath,
    mkdirGuarded,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";
import { safePathWithinRoot } from "../lib/safePath.js";

const OPENCLAW_ROOT = (process.env.HOME || "") + "/.openclaw";
const AGENTS_DIR = Path.join(OPENCLAW_ROOT, "agents");

// Agent IDs may only contain alphanumeric chars, hyphens, underscores, and dots.
// This prevents path traversal when constructing file paths from agent IDs.
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9._-]+$/u;

function isValidAgentId(id: string): boolean {
    return (
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 64 &&
        SAFE_AGENT_ID_RE.test(id)
    );
}

// Activity thresholds (in milliseconds)
const ACTIVE_THRESHOLD = 20_000; // < 20s = active (tool/activity)
const THINKING_THRESHOLD = 60_000; // 20s-60s = thinking, 60s+ = idle
const STALE_THRESHOLD = 5 * 60_000; // 5 minutes - ignore data older than this
const TASK_IDLE_TIMEOUT_MS = 30 * 60_000;

interface AgentMetadata {
    currentTask?: string;
    updatedAt?: string;
}

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

interface SessionInfo {
    key?: string;
    sessionId?: string;
    updatedAt?: number;
    channel?: string;
    displayName?: string;
    label?: string;
}

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

interface AgentTaskHistoryItem {
    id: number;
    agentId: string;
    task: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
}

interface GatewaySessionSummary {
    key: string;
    model: string;
    updatedAt?: number | null;
}

function toDisplayModelName(model: string): string {
    if (!model) {
        return "unknown";
    }

    const slashIndex = model.indexOf("/");
    return slashIndex === -1 ? model : model.slice(slashIndex + 1);
}

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

async function getGatewaySessionsForAgents(): Promise<GatewaySessionSummary[]> {
    const cached = gateway.getSessions().map((session) => ({
        key: session.key,
        model: session.model,
        updatedAt: session.updatedAt,
    }));

    try {
        const result = (await gateway.request("sessions.list", {})) as {
            sessions?: Array<{ key?: string; model?: string; updatedAt?: number | null }>;
        };

        if (Array.isArray(result.sessions) && result.sessions.length > 0) {
            return result.sessions
                .filter(
                    (session) => typeof session.key === "string" && session.key.length > 0
                )
                .map((session) => ({
                    key: session.key || "",
                    model: session.model || "Unknown",
                    updatedAt: session.updatedAt,
                }));
        }
    } catch {
        // Fall back to cached sessions below
    }

    return cached;
}

function nowIso(): string {
    return new Date().toISOString();
}

function closeStaleActiveTasks(): void {
    const cutoff = new Date(Date.now() - TASK_IDLE_TIMEOUT_MS).toISOString();
    db.prepare(
        `UPDATE agent_task_history
         SET status = 'completed_auto', completed_at = ?, last_activity_at = ?
         WHERE status = 'active' AND last_activity_at < ?`
    ).run(nowIso(), nowIso(), cutoff);
}

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
function getAgentMetadata(agentId: string): AgentMetadata | null {
    const metadataPath = Path.join(AGENTS_DIR, agentId, "sessions", "metadata.json");
    try {
        const content = FS.readFileSync(metadataPath, "utf8");
        return JSON5.parse(content) as AgentMetadata;
    } catch {
        return null;
    }
}

// Get sessions from agent's sessions.json file
function getAgentSessionsFromFiles(agentId: string): SessionInfo[] {
    const sessionsFile = Path.join(AGENTS_DIR, agentId, "sessions", "sessions.json");
    try {
        const content = FS.readFileSync(sessionsFile, "utf8");
        const sessions = JSON5.parse(content);
        return Array.isArray(sessions) ? sessions : [];
    } catch (error) {
        console.error(
            "[Agents] Failed to read agent sessions.json:",
            (error as Error).message
        );
        return [];
    }
}

// Get activity from a JSONL session file
interface ActivityInfo {
    task: string | null; // High-level task (from last user message)
    activity: string | null; // Current activity (from last tool use)
    modTime: number;
}

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
    const command = (args.command || nested.command) as string | undefined;
    const action = (args.action || nested.action) as string | undefined;
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
    if (normalizedTool === "exec" && command) {
        return `exec ${command.slice(0, 70)}`;
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

function getLatestActivityFromFile(agentId: string): ActivityInfo | null {
    const sessionsDir = Path.join(AGENTS_DIR, agentId, "sessions");
    if (!FS.existsSync(sessionsDir)) {
        return null;
    }

    try {
        // Find most recently modified JSONL file
        const files = FS.readdirSync(sessionsDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({
                name: f,
                path: Path.join(sessionsDir, f),
                mtime: FS.statSync(Path.join(sessionsDir, f)).mtimeMs,
            }))
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
        const content = FS.readFileSync(latestFile.path, "utf8");
        const lines = content.trim().split("\n");

        let lastTask: string | null = null;
        let lastActivity: string | null = null;

        // Scan from end to find most recent user message and tool use
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
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

function getSessionFileModTime(agentId: string): number | null {
    // Check for session files in agents directory
    const agentDir = Path.join(AGENTS_DIR, agentId);
    if (!FS.existsSync(agentDir)) {
        return null;
    }

    try {
        // Look for JSONL session files
        const sessionsDir = Path.join(agentDir, "sessions");
        if (!FS.existsSync(sessionsDir)) {
            return null;
        }

        const files = FS.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
        let latestModTime = 0;

        for (const file of files) {
            const filePath = Path.join(sessionsDir, file);
            try {
                const stat = FS.statSync(filePath);
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

function getChannelFromSessionKey(sessionKey: string): string | null {
    const parts = sessionKey.split(":");
    if (parts[0] === "channel") {
        return parts[1] || null;
    }
    return null;
}

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

function findBestSessionForAgent(
    agentId: string,
    sessions: GatewaySessionSummary[]
): GatewaySessionSummary | undefined {
    const prefix = `agent:${agentId}:`;
    const matches = sessions.filter((session) => session.key.startsWith(prefix));

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
        const timeA = a.updatedAt || 0;
        const timeB = b.updatedAt || 0;
        const preferredA = preferredKinds.some((part) => a.key.includes(part)) ? 1 : 0;
        const preferredB = preferredKinds.some((part) => b.key.includes(part)) ? 1 : 0;

        if (preferredA !== preferredB) {
            return preferredB - preferredA;
        }

        return timeB - timeA;
    })[0];
}

function getAgentStatus(agentId: string): AgentStatus {
    // Auto-close stale active tasks before reading current state
    closeStaleActiveTasks();

    // Current task priority: active history task -> metadata -> inferred activity
    const activeTask = getActiveHistoryTask(agentId);
    const metadata = getAgentMetadata(agentId);

    // Get sessions from agent's sessions.json file
    const fileSessions = getAgentSessionsFromFiles(agentId);

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
    const activity = getLatestActivityFromFile(agentId);

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
            const config = parseAgentsConfig();
            if (!config) {
                res.status(404).json({ error: "Agent configuration not found" });
                return;
            }

            const defaultModel = config.defaults?.model?.primary || "unknown";
            const sessions = await getGatewaySessionsForAgents();

            const agents: AgentStatus[] = config.list.map((agent) => {
                const status = getAgentStatus(agent.id);
                const configuredModel = resolveConfiguredModelName(
                    agent.model?.primary || defaultModel,
                    config
                );
                const matchingSession = status.sessionKey
                    ? sessions.find((session) => session.key === status.sessionKey)
                    : findBestSessionForAgent(agent.id, sessions);
                status.model =
                    matchingSession?.model && matchingSession.model !== configuredModel
                        ? matchingSession.model
                        : configuredModel;
                return status;
            });

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

            const status = getAgentStatus(agentId);
            const sessions = await getGatewaySessionsForAgents();
            const configuredModel = resolveConfiguredModelName(
                agentConfig.model?.primary || config.defaults?.model?.primary,
                config
            );
            const matchingSession = status.sessionKey
                ? sessions.find((session) => session.key === status.sessionKey)
                : findBestSessionForAgent(agentId, sessions);
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
