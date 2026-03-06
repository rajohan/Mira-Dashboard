import express, { type RequestHandler } from "express";
import FS from "fs";
import JSON5 from "json5";
import Path from "path";
import gateway from "../gateway.js";

const OPENCLAW_ROOT = (process.env.HOME || "") + "/.openclaw";
const AGENTS_DIR = Path.join(OPENCLAW_ROOT, "agents");

// Activity thresholds (in milliseconds)
const ACTIVE_THRESHOLD = 15_000; // < 15s = active
const THINKING_THRESHOLD = 45_000; // 15-45s = thinking, 45s+ = idle

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
    lastActivity: string | null;
    sessionKey: string | null;
    channel: string | null;
}

function parseAgentsConfig(): AgentsConfig | null {
    const configPath = Path.join(OPENCLAW_ROOT, "config", "agents.json5");
    try {
        if (!FS.existsSync(configPath)) {
            return null;
        }
        const content = FS.readFileSync(configPath, "utf8");
        return JSON5.parse(content) as AgentsConfig;
    } catch (error) {
        console.error("[Agents] Failed to parse agents config:", (error as Error).message);
        return null;
    }
}

function getSessions(): SessionInfo[] {
    // Get sessions from gateway
    try {
        const sessions = gateway.getSessions();
        return sessions.map((s) => ({
            key: s.key,
            sessionId: s.id,
            updatedAt: s.updatedAt,
            channel: s.channel,
            displayName: s.displayName,
            label: s.label,
        }));
    } catch (error) {
        console.error("[Agents] Failed to get sessions from gateway:", (error as Error).message);
        return [];
    }
}

// Get sessions from agent's sessions.json file
function getAgentSessionsFromFiles(agentId: string): SessionInfo[] {
    const sessionsFile = Path.join(AGENTS_DIR, agentId, "sessions", "sessions.json");
    try {
        if (!FS.existsSync(sessionsFile)) {
            return [];
        }
        const content = FS.readFileSync(sessionsFile, "utf8");
        const sessions = JSON5.parse(content);
        return Array.isArray(sessions) ? sessions : [];
    } catch (error) {
        console.error("[Agents] Failed to read agent sessions.json:", (error as Error).message);
        return [];
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

function deriveActivityFromSessionKey(sessionKey: string): string {
    const parts = sessionKey.split(":");

    // Check for hooks
    if (sessionKey.includes(":hook:")) {
        const hookIndex = parts.indexOf("hook");
        if (hookIndex !== -1 && parts[hookIndex + 1]) {
            const hookName = parts[hookIndex + 1];
            return `Running ${hookName} hook`;
        }
    }

    // Check for cron
    if (sessionKey.includes(":cron:")) {
        return "Running scheduled task";
    }

    // Check for subagent
    if (sessionKey.includes(":subagent:")) {
        const agentIndex = parts.indexOf("subagent");
        if (agentIndex !== -1 && parts[agentIndex + 1]) {
            return `Subagent: ${parts[agentIndex + 1]}`;
        }
        return "Running subagent task";
    }

    // Check for channel (discord, telegram, etc.)
    if (parts[0] === "channel") {
        const channel = parts[1] || "unknown";
        return `Chatting on ${channel}`;
    }

    // Default
    if (parts[0] === "agent") {
        return "Processing request";
    }

    return "Working";
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

function getAgentStatus(agentId: string, sessions: SessionInfo[]): AgentStatus {
    // Get sessions from both gateway and agent's sessions.json file
    const fileSessions = getAgentSessionsFromFiles(agentId);
    const allSessions = [...sessions, ...fileSessions];

    // Find sessions for this agent
    const agentSessions = allSessions.filter((s) => {
        if (!s.key) return false;
        // Match session key pattern: agent:{agentId}:... or agent:{agentId}
        const parts = s.key.split(":");
        return parts[0] === "agent" && parts[1] === agentId;
    });

    // Get latest session file modification time
    const fileModTime = getSessionFileModTime(agentId);

    // Find most recent session activity
    let latestSession: SessionInfo | null = null;
    let latestTime = 0;

    for (const session of agentSessions) {
        const sessionTime = session.updatedAt || 0;
        if (sessionTime > latestTime) {
            latestTime = sessionTime;
            latestSession = session;
        }
    }

    // Use whichever is more recent: file mod time or session updatedAt
    // Both are already in milliseconds
    const effectiveTime = Math.max(fileModTime || 0, latestTime);
    const status = determineStatus(effectiveTime);

    // Derive current task from session key
    const sessionKey = latestSession?.key || null;
    const currentTask = sessionKey ? deriveActivityFromSessionKey(sessionKey) : null;
    const channel = sessionKey ? getChannelFromSessionKey(sessionKey) : null;

    return {
        id: agentId,
        status,
        model: "unknown", // Will be filled from config
        currentTask,
        lastActivity: effectiveTime > 0 ? new Date(effectiveTime).toISOString() : null,
        sessionKey,
        channel,
    };
}

export default function agentsRoutes(app: express.Application): void {
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

            const sessions = getSessions();
            const defaultModel = config.defaults?.model?.primary || "unknown";

            const agents: AgentStatus[] = config.list.map((agent) => {
                const status = getAgentStatus(agent.id, sessions);
                status.model = agent.model?.primary || defaultModel;
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
            const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
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

            const sessions = getSessions();
            const status = getAgentStatus(agentId, sessions);
            status.model = agentConfig.model?.primary || config.defaults?.model?.primary || "unknown";

            res.json(status);
        } catch (error) {
            console.error("[Agents] Status error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}