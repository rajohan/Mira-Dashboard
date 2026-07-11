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
    modelProvider?: string;
    tokenCount: number;
    maxTokens: number;
    createdAt: string | undefined;
    updatedAt: number | undefined;
    displayName: string;
    label: string;
    displayLabel: string;
    channel: string;
    status?: string;
    endedAt?: string | number | undefined;
    startedAt?: string | number | undefined;
    runId?: string | undefined;
    activeRunId?: string | undefined;
    currentRunId?: string | undefined;
    hasActiveRun?: boolean;
    isRunning?: boolean;
    running?: boolean;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
    thinkingOptions?: string[];
    thinkingDefault?: string;
    fastMode?: boolean | "auto";
    effectiveFastMode?: boolean | "auto";
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    totalTokensFresh?: boolean;
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
    currentTask: string | undefined;
    currentActivity: string | undefined;
    lastActivity: string | undefined;
    sessionKey: string | undefined;
    channel: string | undefined;
}

/** Represents agent task history item. */
export interface AgentTaskHistoryItem {
    id: number;
    agentId: string;
    task: string;
    status: string;
    startedAt: string;
    completedAt: string | undefined;
    lastActivityAt: string;
}
