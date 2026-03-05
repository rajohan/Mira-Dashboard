import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch, apiPost } from "./useApi";

export type OpsActionId =
    | "gateway_restart"
    | "system_restart"
    | "system_cleanup"
    | "system_update"
    | "openclaw_update"
    | "openclaw_cleanup";

export interface OpsActionDefinition {
    id: OpsActionId;
    label: string;
    description: string;
    command: string;
    confirmLabel: string;
    confirmMessage: string;
    scope: "system" | "openclaw";
    danger?: boolean;
}

export interface ExecResponse {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface OpenClawVersionInfo {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checkedAt: number;
}

export const OPS_ACTIONS: OpsActionDefinition[] = [
    {
        id: "system_restart",
        label: "Restart system",
        description: "Schedule server reboot (+1 minute)",
        command: "sudo shutdown -r +1 'Dashboard requested reboot'",
        confirmLabel: "Restart system",
        confirmMessage:
            "Schedule system reboot in 1 minute? This will interrupt services during restart.",
        scope: "system",
        danger: true,
    },
    {
        id: "system_cleanup",
        label: "Cleanup system",
        description: "apt cleanup + journal vacuum + docker prune",
        command:
            "sudo apt-get autoremove -y && sudo apt-get autoclean -y && sudo journalctl --vacuum-time=14d && sudo docker system prune -af",
        confirmLabel: "Run system cleanup",
        confirmMessage:
            "Run system cleanup now? This removes unused apt packages/cache, old journal logs, and unused Docker images/cache/networks.",
        scope: "system",
        danger: true,
    },
    {
        id: "system_update",
        label: "System update",
        description: "apt update + upgrade",
        command: "sudo apt-get update && sudo apt-get upgrade -y",
        confirmLabel: "Run system update",
        confirmMessage: "Run system update now? This can take several minutes.",
        scope: "system",
        danger: true,
    },
    {
        id: "gateway_restart",
        label: "Restart gateway",
        description: "Restart OpenClaw gateway service",
        command: "openclaw gateway restart",
        confirmLabel: "Restart gateway",
        confirmMessage: "Restart gateway now? Active sessions may disconnect briefly.",
        scope: "openclaw",
        danger: true,
    },
    {
        id: "openclaw_update",
        label: "Update OpenClaw",
        description: "Install latest OpenClaw CLI globally",
        command: "openclaw update --yes", 
        confirmLabel: "Update OpenClaw",
        confirmMessage: "Update OpenClaw to latest version now?",
        scope: "openclaw",
        danger: true,
    },
    {
        id: "openclaw_cleanup",
        label: "Cleanup OpenClaw",
        description: "Prune old sessions/media/logs/queue/cron artifacts",
        command:
            "find $HOME/.openclaw/agents -type f -path '*/sessions/*' -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/agents -type d -path '*/sessions/*' -empty -delete 2>/dev/null || true; find $HOME/.openclaw/media -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/workspace/images -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/tmp -type f -mtime +7 -delete 2>/dev/null || true; find $HOME/.openclaw/delivery-queue/failed -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/completions -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/cron/runs -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/logs -type f -mtime +14 -delete 2>/dev/null || true",
        confirmLabel: "Run OpenClaw cleanup",
        confirmMessage:
            "Run OpenClaw cleanup now? This removes old OpenClaw session/media/log/queue/temp artifacts.",
        scope: "openclaw",
    },
];

export function useRunOpsAction() {
    return useMutation({
        mutationFn: async (action: OpsActionDefinition) =>
            apiPost<ExecResponse>("/exec", { command: action.command }),
    });
}

export function useOpenClawVersion() {
    return useQuery({
        queryKey: ["openclaw-version"],
        queryFn: () => apiFetch<OpenClawVersionInfo>("/openclaw/version"),
        staleTime: 60_000,
    });
}
