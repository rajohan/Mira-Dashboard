/** Represents agent status. */
export interface AgentStatus {
    version: string;
    uptime: number;
    model: string;
    sessionCount: number;
    tokenUsage: {
        total: number;
        byModel: Record<string, number>;
    };
}

/** Represents session. */
export interface Session {
    id: string;
    key: string;
    type: string;
    agentType: string;
    hookName: string;
    kind: string;
    model: string;
    tokenCount: number;
    maxTokens: number;
    createdAt: string | null;
    updatedAt: number | null;
    displayName: string;
    label: string;
    displayLabel: string;
    channel: string;
    status?: string;
    endedAt?: string | number | null;
    startedAt?: string | number | null;
    runId?: string | null;
    activeRunId?: string | null;
    currentRunId?: string | null;
    isRunning?: boolean;
    running?: boolean;
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
}

/** Represents agent info. */
export interface AgentInfo {
    id: string;
    name: string;
    model?: string;
    status?: string;
}

// Agent with real-time status
/** Represents agent. */
export interface Agent {
    id: string;
    status: "active" | "thinking" | "idle" | "offline";
    model: string;
    currentTask: string | null;
    currentActivity: string | null;
    lastActivity: string | null;
    sessionKey: string | null;
    channel: string | null;
}

/** Represents agent task history item. */
export interface AgentTaskHistoryItem {
    id: number;
    agentId: string;
    task: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
}
