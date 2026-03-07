import { useQuery } from "@tanstack/react-query";

import type { Agent, AgentTaskHistoryItem } from "../types/session";

interface AgentsStatusResponse {
    agents: Agent[];
    timestamp: number;
}

interface AgentTaskHistoryResponse {
    tasks: AgentTaskHistoryItem[];
    timestamp: number;
}

interface AgentsConfigResponse {
    defaults: {
        model?: {
            primary?: string;
            fallbacks?: string[];
        };
    };
    list: Array<{
        id: string;
        default?: boolean;
        model?: {
            primary?: string;
            fallbacks?: string[];
        };
        subagents?: {
            allowAgents?: string[];
        };
    }>;
}

export function useAgentsStatus() {
    return useQuery<AgentsStatusResponse>({
        queryKey: ["agents", "status"],
        queryFn: async () => {
            const response = await fetch("/api/agents/status");
            if (!response.ok) {
                throw new Error("Failed to fetch agents status");
            }
            return response.json();
        },
        refetchInterval: 5000, // Poll every 5 seconds
        staleTime: 4000,
    });
}

export function useAgentsConfig() {
    return useQuery<AgentsConfigResponse>({
        queryKey: ["agents", "config"],
        queryFn: async () => {
            const response = await fetch("/api/agents/config");
            if (!response.ok) {
                throw new Error("Failed to fetch agents config");
            }
            return response.json();
        },
        staleTime: 60_000, // Config doesn't change often
    });
}

export function useAgentTaskHistory(limit = 8) {
    return useQuery<AgentTaskHistoryResponse>({
        queryKey: ["agents", "tasks", "history", limit],
        queryFn: async () => {
            const response = await fetch(`/api/agents/tasks/history?limit=${limit}`);
            if (!response.ok) {
                throw new Error("Failed to fetch agent task history");
            }
            return response.json();
        },
        refetchInterval: 5000,
        staleTime: 4000,
    });
}

export function useAgentStatus(agentId: string) {
    return useQuery<Agent>({
        queryKey: ["agents", "status", agentId],
        queryFn: async () => {
            const response = await fetch(`/api/agents/${agentId}/status`);
            if (!response.ok) {
                throw new Error(`Failed to fetch agent ${agentId} status`);
            }
            return response.json();
        },
        refetchInterval: 5000,
        staleTime: 4000,
    });
}