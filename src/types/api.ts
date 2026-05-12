/** Represents the high-level OpenClaw runtime status returned by the API. */
export interface OpenClawStatus {
    version: string;
    uptime: number;
    model: string;
    sessionCount: number;
    tokenUsage: {
        total: number;
        byModel: Record<string, number>;
    };
}

/** Represents a session summary returned by generic API responses. */
export interface Session {
    id: string;
    agentId: string;
    agentName: string;
    type: "main" | "hook" | "cron" | "subagent";
    model: string;
    tokenCount: number;
    createdAt: string;
    updatedAt: string;
}

/** Represents the compact legacy metrics payload with scalar resource usage values. */
export interface ApiMetrics {
    cpu: number;
    memory: number;
    disk: number;
    network: { in: number; out: number };
    uptime: number;
    loadAvg: [number, number, number];
}
