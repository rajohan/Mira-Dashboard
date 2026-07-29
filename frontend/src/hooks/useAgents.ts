import { useQuery } from "@tanstack/react-query";

import {
    parseAgent,
    parseAgentsConfig,
    parseAgentsStatusResponse,
    parseAgentTaskHistoryResponse,
} from "../../../contracts/agents";
import { refreshPolicy } from "../lib/refreshPolicy";
import { apiFetchParsed } from "./useApi";

/**
 * Provides agents status.
 * @returns The agents status.
 */
export function useAgentsStatus() {
    return useQuery({
        queryKey: ["agents", "status"],
        queryFn: () => apiFetchParsed("/agents/status", parseAgentsStatusResponse),
        refetchInterval: refreshPolicy.live,
        staleTime: 1000,
    });
}

/**
 * Provides agents config.
 * @returns The agents config.
 */
export function useAgentsConfig() {
    return useQuery({
        queryKey: ["agents", "config"],
        queryFn: () => apiFetchParsed("/agents/config", parseAgentsConfig),
        staleTime: 60_000,
    });
}

/**
 * Provides agent task history.
 * @param limit Limit value.
 * @returns The agent task history.
 */
export function useAgentTaskHistory(limit = 8) {
    return useQuery({
        queryKey: ["agents", "tasks", "history", limit],
        queryFn: () =>
            apiFetchParsed(
                `/agents/tasks/history?limit=${limit}`,
                parseAgentTaskHistoryResponse
            ),
        refetchInterval: refreshPolicy.active,
        staleTime: 4000,
    });
}

/**
 * Provides agent status.
 * @param agentId Agent identifier.
 * @returns The agent status.
 */
export function useAgentStatus(agentId: string) {
    return useQuery({
        queryKey: ["agents", "status", agentId],
        queryFn: () =>
            apiFetchParsed(`/agents/${encodeURIComponent(agentId)}/status`, parseAgent),
        refetchInterval: refreshPolicy.live,
        staleTime: 1000,
    });
}
