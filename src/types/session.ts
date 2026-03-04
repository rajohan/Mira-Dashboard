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
}

export interface AgentInfo {
    id: string;
    name: string;
    model?: string;
    status?: string;
}
