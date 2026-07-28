import { useQuery } from "@tanstack/react-query";

import type {
    Agent,
    AgentsConfig,
    AgentsStatusResponse,
    AgentTaskHistoryResponse,
} from "../../contracts/agents";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchRequired } from "./useApi";

/** Provides agents status. */
export function useAgentsStatus() {
    return useQuery<AgentsStatusResponse>({
        queryKey: ["agents", "status"],
        queryFn: () => apiFetchRequired<AgentsStatusResponse>("/agents/status"),
        refetchInterval: refreshPolicy.live,
        staleTime: 1000,
    });
}

/** Provides agents config. */
export function useAgentsConfig() {
    return useQuery<AgentsConfig>({
        queryKey: ["agents", "config"],
        queryFn: () => apiFetchRequired<AgentsConfig>("/agents/config"),
        staleTime: 60_000,
    });
}

/** Provides agent task history. */
export function useAgentTaskHistory(limit = 8) {
    return useQuery<AgentTaskHistoryResponse>({
        queryKey: ["agents", "tasks", "history", limit],
        queryFn: () =>
            apiFetchRequired<AgentTaskHistoryResponse>(
                `/agents/tasks/history?limit=${limit}`
            ),
        refetchInterval: refreshPolicy.active,
        staleTime: 4000,
    });
}

/** Provides agent status. */
export function useAgentStatus(agentId: string) {
    return useQuery<Agent>({
        queryKey: ["agents", "status", agentId],
        queryFn: () =>
            apiFetchRequired<Agent>(`/agents/${encodeURIComponent(agentId)}/status`),
        refetchInterval: refreshPolicy.live,
        staleTime: 1000,
    });
}
