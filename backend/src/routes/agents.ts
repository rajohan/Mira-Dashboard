import express, { type RequestHandler } from "express";
import FS from "fs";
import JSON5 from "json5";
import Path from "path";

const OPENCLAW_ROOT = (process.env.HOME || "") + "/.openclaw";
const AGENTS_DIR = Path.join(OPENCLAW_ROOT, "agents");

// Activity thresholds (in milliseconds)
const ACTIVE_THRESHOLD = 15_000; // < 15s = active
const THINKING_THRESHOLD = 45_000; // 15-45s = thinking, 45s+ = idle
const STALE_THRESHOLD = 5 * 60_000; // 5 minutes - ignore data older than this

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
    currentActivity: string | null;
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

// Get activity from a JSONL session file
interface ActivityInfo {
    task: string | null;      // High-level task (from last user message)
    activity: string | null;  // Current activity (from last tool use)
    modTime: number;
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
                    let text = typeof msg.content === "string" 
                        ? msg.content 
                        : Array.isArray(msg.content)
                          ? msg.content
                              .filter((c: { type?: string }) => c.type === "text")
                              .map((c: { text?: string }) => c.text)
                              .join(" ")
                          : String(msg.content);
                    
                    // Clean metadata and extract actual message
                    text = text
                        .replace(/```json[\s\S]*?```/g, "")
                        .replace(/```[\s\S]*?```/g, "")
                        .replace(/\[media attached[^\]]*\]/g, "")
                        .replace(/Conversation info[^\n]*/g, "")
                        .replace(/Sender[^\n]*/g, "")
                        .replace(/\n+/g, " ")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 100);
                    
                    lastTask = text || null;
                }
                
                // First tool use from end = current activity
                if (msg.role === "assistant" && Array.isArray(msg.content) && !lastActivity) {
                    const toolCalls = msg.content.filter((c: { type?: string }) => c.type === "toolCall");
                    if (toolCalls.length > 0) {
                        const toolCall = toolCalls[0];
                        const toolName = toolCall.name || "unknown";
                        const action = toolCall.arguments?.action || toolCall.arguments?.command?.slice(0, 50) || "";
                        lastActivity = action ? `${toolName}: ${action}` : toolName;
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
            modTime: latestFile.mtime 
        };
    } catch (error) {
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

function getAgentStatus(agentId: string): AgentStatus {
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

    return {
        id: agentId,
        status,
        model: "unknown", // Will be filled from config
        currentTask: activity?.task || null,
        currentActivity: activity?.activity || null,
        lastActivity: effectiveModTime > 0 ? new Date(effectiveModTime).toISOString() : null,
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

            const defaultModel = config.defaults?.model?.primary || "unknown";

            const agents: AgentStatus[] = config.list.map((agent) => {
                const status = getAgentStatus(agent.id);
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

            const status = getAgentStatus(agentId);
            status.model = agentConfig.model?.primary || config.defaults?.model?.primary || "unknown";

            res.json(status);
        } catch (error) {
            console.error("[Agents] Status error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}