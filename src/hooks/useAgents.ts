import { useQuery } from "@tanstack/react-query";

import type { Agent, AgentTaskHistoryItem } from "../types/session";
import { apiFetch } from "./useApi";

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
        queryFn: () => apiFetch<AgentsStatusResponse>("/agents/status"),
        refetchInterval: 5000,
        staleTime: 4000,
    });
}

export function useAgentsConfig() {
    return useQuery<AgentsConfigResponse>({
        queryKey: ["agents", "config"],
        queryFn: () => apiFetch<AgentsConfigResponse>("/agents/config"),
        staleTime: 60_000,
    });
}

export function useAgentTaskHistory(limit = 8) {
    return useQuery<AgentTaskHistoryResponse>({
        queryKey: ["agents", "tasks", "history", limit],
        queryFn: () => apiFetch<AgentTaskHistoryResponse>(`/agents/tasks/history?limit=${limit}`),
        refetchInterval: 5000,
        staleTime: 4000,
    });
}

export function useAgentStatus(agentId: string) {
    return useQuery<Agent>({
        queryKey: ["agents", "status", agentId],
        queryFn: () => apiFetch<Agent>(`/agents/${agentId}/status`),
        refetchInterval: 5000,
        staleTime: 4000,
    });
}
