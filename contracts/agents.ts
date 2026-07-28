export type AgentLifecycleStatus = "active" | "thinking" | "idle" | "offline";

export interface Agent {
    channel: string | undefined;
    currentActivity: string | undefined;
    currentTask: string | undefined;
    id: string;
    lastActivity: string | undefined;
    model: string;
    sessionKey: string | undefined;
    status: AgentLifecycleStatus;
}

export interface AgentTaskHistoryItem {
    agentId: string;
    completedAt: string | undefined;
    id: number;
    lastActivityAt: string;
    startedAt: string;
    status: string;
    task: string;
}

export interface AgentModelConfig {
    fallbacks?: string[];
    primary?: string;
}

export interface AgentConfig {
    default?: boolean;
    id: string;
    model?: AgentModelConfig;
    subagents?: {
        allowAgents?: string[];
    };
}

export interface AgentsConfig {
    defaults: {
        model?: AgentModelConfig;
        models?: Record<string, { alias?: string }>;
    };
    list: AgentConfig[];
}

export interface AgentsStatusResponse {
    agents: Agent[];
    timestamp: number;
}

export interface AgentTaskHistoryResponse {
    tasks: AgentTaskHistoryItem[];
    timestamp: number;
}
