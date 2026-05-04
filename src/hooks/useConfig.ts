import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost, apiPut } from "./useApi";

// Types
export interface Skill {
    name: string;
    path: string;
    enabled: boolean;
    description?: string;
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
    channels?: {
        discord?: {
            enabled?: boolean;
            botId?: string;
        };
    };
    tools?: {
        webSearch?: {
            enabled?: boolean;
            provider?: string;
        };
        exec?: {
            enabled?: boolean;
            mode?: string;
        };
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
        every?: number;
        target?: string;
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

async function createBackup(): Promise<{ path: string }> {
    return apiPost<{ path: string }>("/backup");
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
