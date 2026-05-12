/** Describes open claw status. */
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

/** Describes session. */
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

/** Describes metrics. */
export interface Metrics {
    cpu: number;
    memory: number;
    disk: number;
    network: { in: number; out: number };
    uptime: number;
    loadAvg: [number, number, number];
}
