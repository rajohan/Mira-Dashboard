import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type OpenClawConfig,
    type OpenClawConfigUpdateRequest,
    type OpenClawConfigUpdateResponse,
    type OpenClawSkillUpdateRequest,
    type OpenClawSkill,
    parseOpenClawConfig,
    parseOpenClawConfigBackupResponse,
    parseOpenClawConfigUpdateResponse,
    parseOpenClawMutationResponse,
    parseOpenClawSkillsResponse,
} from "../../../contracts/openClawConfig";
import { apiFetchParsed, apiPostParsed, apiPutParsed } from "./useApi";

// Query keys
/** Defines config keys. */
export const configKeys = {
    config: (): ["config"] => ["config"],
    skills: (): ["skills"] => ["skills"],
};

// Fetchers
/**
 * Fetches config.
 * @returns Promise resolving to the fetch config result.
 */
async function fetchConfig(): Promise<OpenClawConfig> {
    return apiFetchParsed("/config", parseOpenClawConfig);
}

/**
 * Fetches skills.
 * @returns Promise resolving to the fetch skills result.
 */
async function fetchSkills(): Promise<OpenClawSkill[]> {
    const response = await apiFetchParsed("/skills", parseOpenClawSkillsResponse);
    return response.skills;
}

/**
 * Performs update config.
 * @returns Update config result.
 */
async function updateConfig(
    config: OpenClawConfig,
    baseHash?: string
): Promise<OpenClawConfigUpdateResponse> {
    const configHash = baseHash ?? config.__hash;
    if (!configHash?.trim()) {
        throw new Error("Config hash is required");
    }
    return apiPutParsed("/config", parseOpenClawConfigUpdateResponse, {
        ...config,
        __hash: configHash.trim(),
    } satisfies OpenClawConfigUpdateRequest);
}

/**
 * Performs toggle skill.
 * @param name Name value.
 * @param isEnabled Whether is enabled.
 * @param baseHash Base hash value.
 */
async function toggleSkill(
    name: string,
    isEnabled: boolean,
    baseHash?: string
): Promise<void> {
    if (!baseHash?.trim()) {
        throw new Error("Config hash is required");
    }
    await apiPostParsed(
        `/skills/${encodeURIComponent(name)}`,
        parseOpenClawMutationResponse,
        {
            __hash: baseHash.trim(),
            enabled: isEnabled,
        } satisfies OpenClawSkillUpdateRequest
    );
}

/** Performs restart gateway. */
async function restartGateway(): Promise<void> {
    await apiPostParsed("/restart", parseOpenClawMutationResponse);
}

/**
 * Creates backup.
 * @returns Created backup.
 */
async function createBackup() {
    return apiPostParsed("/backup", parseOpenClawConfigBackupResponse);
}

// Hooks
/**
 * Provides config.
 * @param isEnabled Whether is enabled.
 * @returns The config.
 */
export function useConfig(isEnabled = true) {
    return useQuery({
        enabled: isEnabled,
        queryKey: ["config"],
        queryFn: fetchConfig,
        staleTime: 60_000, // 1 minute
    });
}

/**
 * Provides skills.
 * @param isEnabled Whether is enabled.
 * @returns The skills.
 */
export function useSkills(isEnabled = true) {
    return useQuery({
        enabled: isEnabled,
        queryKey: ["skills"],
        queryFn: fetchSkills,
        staleTime: 60_000,
    });
}

/**
 * Provides update config.
 * @returns The update config.
 */
export function useUpdateConfig() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (config: OpenClawConfig) => {
            const current = queryClient.getQueryData<OpenClawConfig>(configKeys.config());
            return updateConfig(config, config.__hash ?? current?.__hash);
        },
        onSuccess: async (response, config) => {
            const nextHash = response.result.hash;
            if (nextHash?.trim()) {
                const nextConfig = response.result.parsed;
                queryClient.setQueryData<OpenClawConfig>(
                    configKeys.config(),
                    (current) => {
                        if (nextConfig) {
                            return { ...nextConfig, __hash: nextHash.trim() };
                        }
                        return current
                            ? { ...current, __hash: nextHash.trim() }
                            : { ...config, __hash: nextHash.trim() };
                    }
                );
            }
            await queryClient.invalidateQueries({ queryKey: configKeys.config() });
        },
    });
}

/**
 * Provides toggle skill.
 * @returns The toggle skill.
 */
export function useToggleSkill() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => {
            const current = queryClient.getQueryData<OpenClawConfig>(configKeys.config());
            return toggleSkill(name, enabled, current?.__hash);
        },
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: configKeys.config() }),
                queryClient.invalidateQueries({ queryKey: configKeys.skills() }),
            ]);
        },
    });
}

/**
 * Provides restart gateway.
 * @returns The restart gateway.
 */
export function useRestartGateway() {
    return useMutation({
        mutationFn: restartGateway,
    });
}

/**
 * Provides create backup.
 * @returns The create backup.
 */
export function useCreateBackup() {
    return useMutation({
        mutationFn: createBackup,
    });
}
