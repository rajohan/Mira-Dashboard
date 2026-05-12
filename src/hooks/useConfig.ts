import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost, apiPut } from "./useApi";

// Types
export type SkillSource = "workspace" | "builtin" | "extra";

export interface Skill {
    name: string;
    path: string;
    enabled: boolean;
    description?: string;
    source?: SkillSource;
}

export interface AgentConfig {
    id: string;
    default?: boolean;
    name?: string;
    skills?: string[];
    tools?: {
        allow?: string[];
        alsoAllow?: string[];
        deny?: string[];
        profile?: string;
    };
    [key: string]: unknown;
}

export interface OpenClawConfig {
    __hash?: string;
    agents?: {
        defaults?: {
            skills?: string[];
            model?: { primary?: string; fallbacks?: string[] };
            imageModel?: { primary?: string; fallbacks?: string[] };
            imageGenerationModel?: { primary?: string; fallbacks?: string[] };
            contextSettings?: {
                maxTokens?: number;
                temperature?: number;
            };
            [key: string]: unknown;
        };
        list?: AgentConfig[];
        defaultModel?: string;
        fallbacks?: string[];
        contextSettings?: {
            maxTokens?: number;
            temperature?: number;
        };
    };
    channels?: Record<
        string,
        {
            enabled?: boolean;
            botId?: string;
            groupPolicy?: string;
            dmPolicy?: string;
            allowFrom?: string[];
            [key: string]: unknown;
        }
    >;
    tools?: {
        profile?: string;
        webSearch?: {
            enabled?: boolean;
            provider?: string;
        };
        web?: {
            search?: { enabled?: boolean; provider?: string };
            fetch?: { enabled?: boolean };
        };
        exec?: {
            enabled?: boolean;
            mode?: string;
            security?: string;
            ask?: string;
        };
        elevated?: { enabled?: boolean };
        agentToAgent?: { enabled?: boolean };
        sessions?: { visibility?: string };
        [key: string]: unknown;
    };
    gateway?: {
        port?: number;
        mode?: string;
        auth?: {
            enabled?: boolean;
            type?: string;
        };
    };
    session?: {
        reset?: {
            idleMinutes?: number;
        };
    };
    heartbeat?: {
        every?: number | string;
        target?: string;
    };
    auth?: {
        profiles?: Record<string, unknown>;
    };
    commands?: {
        restart?: boolean;
        ownerAllowFrom?: string[];
    };
    logging?: {
        redactSensitive?: string;
    };
    meta?: {
        lastTouchedVersion?: string;
        lastTouchedAt?: string;
    };
    wizard?: {
        lastRunVersion?: string;
        lastRunAt?: string;
    };
    [key: string]: unknown;
}

// Query keys
export const configKeys = {
    config: (): ["config"] => ["config"],
    skills: (): ["skills"] => ["skills"],
};

// Fetchers
async function fetchConfig(): Promise<OpenClawConfig> {
    return apiFetch<OpenClawConfig>("/config");
}

async function fetchSkills(): Promise<Skill[]> {
    const data = await apiFetch<{ skills: Skill[] }>("/skills");
    return data.skills;
}

async function updateConfig(config: OpenClawConfig): Promise<void> {
    await apiPut("/config", config);
}

async function toggleSkill(name: string, enabled: boolean): Promise<void> {
    await apiPost(`/skills/${name}`, { enabled });
}

async function restartGateway(): Promise<void> {
    await apiPost("/restart");
}

async function createBackup(): Promise<{
    createdAt: string;
    hash?: string;
    config: OpenClawConfig;
}> {
    return apiPost<{ createdAt: string; hash?: string; config: OpenClawConfig }>(
        "/backup"
    );
}

// Hooks
export function useConfig() {
    return useQuery({
        queryKey: ["config"],
        queryFn: fetchConfig,
        staleTime: 60_000, // 1 minute
    });
}

export function useSkills() {
    return useQuery({
        queryKey: ["skills"],
        queryFn: fetchSkills,
        staleTime: 60_000,
    });
}

export function useUpdateConfig() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: updateConfig,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: configKeys.config() });
        },
    });
}

export function useToggleSkill() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
            toggleSkill(name, enabled),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: configKeys.skills() });
        },
    });
}

export function useRestartGateway() {
    return useMutation({
        mutationFn: restartGateway,
    });
}

export function useCreateBackup() {
    return useMutation({
        mutationFn: createBackup,
    });
}
