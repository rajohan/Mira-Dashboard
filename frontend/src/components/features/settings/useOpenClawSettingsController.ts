import { useEffect, useRef, useState } from "react";

import type { AgentConfig } from "../../../../../contracts/agents";
import {
    parseSystemHostSummary,
    type SystemHostSummary,
} from "../../../../../contracts/system";
import { useCacheEntry } from "../../../hooks/useCache";
import {
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "../../../hooks/useConfig";
import { messageFromError } from "../../../lib/errorMessage";
import {
    clearTimer,
    configuredChannels,
    numberFromDuration,
    optionalFormValue,
    patchSuccess,
} from "../../../pages/settingsPageUtilities";
import { currentIsoString } from "../../../utils/date";
import type { ChannelSummary } from "./ChannelSection";
import type { ToolSettings } from "./ToolSection";

export function useOpenClawSettingsController() {
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();
    const [showRestartModal, setShowRestartModal] = useState(false);
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const restartReloadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );

    const { data: config, isLoading: configLoading } = useConfig();
    const { data: skills = [], isLoading: skillsLoading } = useSkills();
    const { data: systemHost } = useCacheEntry<SystemHostSummary>(
        "system.host",
        parseSystemHostSummary,
        60_000
    );
    const updateConfig = useUpdateConfig();
    const toggleSkill = useToggleSkill();
    const restartGateway = useRestartGateway();
    const createBackup = useCreateBackup();

    useEffect(() => {
        return () => {
            clearTimer(successTimerRef);
            clearTimer(restartReloadTimerRef);
        };
    }, []);

    async function handleRestart(): Promise<void> {
        try {
            await restartGateway.mutateAsync();
            setShowRestartModal(false);
            restartReloadTimerRef.current = setTimeout(() => location.reload(), 2000);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to restart"));
        }
    }

    async function handleBackup(): Promise<void> {
        try {
            const result = await createBackup.mutateAsync();
            const blob = new Blob([JSON.stringify(result, undefined, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `openclaw-backup-${currentIsoString().split("T", 1)[0]}.json`;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to backup"));
        }
    }

    async function handleSkillToggle(
        skillName: string,
        isEnabled: boolean
    ): Promise<void> {
        try {
            await toggleSkill.mutateAsync({ name: skillName, enabled: isEnabled });
        } catch (error_) {
            setError(messageFromError(error_, "Failed to update skill"));
        }
    }

    async function handleSessionSave(idleMinutes: number): Promise<void> {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({ session: { reset: { idleMinutes } } });
            patchSuccess(setSuccess, "Session settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    async function handleHeartbeatSave(every: number, target: string): Promise<void> {
        setError(undefined);
        try {
            const nextEvery = every % 60 === 0 ? `${every / 60}m` : `${every}s`;
            const agents = config?.agents?.list || [];
            const hasOpsAgent = agents.some((agent) => agent.id === "ops");
            const patch = hasOpsAgent
                ? {
                      agents: {
                          list: agents.map((agent) =>
                              agent.id === "ops"
                                  ? {
                                        ...agent,
                                        heartbeat: {
                                            ...((agent.heartbeat || {}) as Record<
                                                string,
                                                unknown
                                            >),
                                            every: nextEvery,
                                            target: optionalFormValue(target),
                                        },
                                    }
                                  : agent
                          ),
                      },
                  }
                : { heartbeat: { every: nextEvery, target: optionalFormValue(target) } };

            await updateConfig.mutateAsync(patch);
            patchSuccess(setSuccess, "Heartbeat settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    async function handleAgentAccessSave(agents: AgentConfig[]): Promise<void> {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({ agents: { list: agents } });
            patchSuccess(setSuccess, "Agent access settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    async function handleModelSave(values: {
        primary: string;
        fallbacks: string[];
    }): Promise<void> {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({ agents: { defaults: { model: values } } });
            patchSuccess(setSuccess, "Model settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    async function handleToolSave(values: ToolSettings): Promise<void> {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                tools: {
                    profile: optionalFormValue(values.profile),
                    web: {
                        search: {
                            enabled: values.webSearchEnabled,
                            provider: optionalFormValue(values.webSearchProvider),
                        },
                        fetch: { enabled: values.webFetchEnabled },
                    },
                    exec: { security: values.execSecurity, ask: values.execAsk },
                    elevated: { enabled: values.elevatedEnabled },
                    agentToAgent: { enabled: values.agentToAgentEnabled },
                    sessions: {
                        visibility: optionalFormValue(values.sessionsVisibility),
                    },
                },
            });
            patchSuccess(setSuccess, "Tool settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    async function handleChannelsSave(channels: ChannelSummary[]): Promise<void> {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                channels: Object.fromEntries(
                    channels.map((channel) => [channel.id, { enabled: channel.enabled }])
                ),
            });
            patchSuccess(setSuccess, "Channel settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    const modelInfo = {
        defaultModel:
            config?.agents?.defaults?.model?.primary ||
            config?.agents?.defaultModel ||
            "",
        fallbacks:
            config?.agents?.defaults?.model?.fallbacks || config?.agents?.fallbacks || [],
        imageModel: config?.agents?.defaults?.imageModel?.primary,
        imageGenerationModel: config?.agents?.defaults?.imageGenerationModel?.primary,
    };
    const toolInfo = {
        profile: config?.tools?.profile || "",
        webSearchEnabled: config?.tools?.web?.search?.enabled !== false,
        webSearchProvider: config?.tools?.web?.search?.provider || "",
        webFetchEnabled: config?.tools?.web?.fetch?.enabled !== false,
        execSecurity:
            config?.tools?.exec?.security || config?.tools?.exec?.mode || "deny",
        execAsk: config?.tools?.exec?.ask || "always",
        elevatedEnabled: config?.tools?.elevated?.enabled === true,
        agentToAgentEnabled: config?.tools?.agentToAgent?.enabled === true,
        sessionsVisibility: config?.tools?.sessions?.visibility || "",
    };
    const securityInfo = {
        authProfiles: Object.keys(config?.auth?.profiles || {}).length,
        commandRestartEnabled: config?.commands?.restart === true,
        ownerAllowFrom: (config?.commands?.ownerAllowFrom || []).join(", "),
        elevatedEnabled: toolInfo.elevatedEnabled,
        execSecurity: toolInfo.execSecurity,
        execAsk: toolInfo.execAsk,
        redactionMode: config?.logging?.redactSensitive,
    };
    const opsAgent = config?.agents?.list?.find((agent) => agent.id === "ops");
    const heartbeat = (opsAgent?.heartbeat || config?.heartbeat || {}) as {
        every?: string | number;
        target?: string;
    };
    const heartbeatInfo = {
        every: numberFromDuration(heartbeat.every, 60),
        target: heartbeat.target || "",
    };
    const serverInfo = {
        version:
            systemHost?.data.version?.current ||
            config?.meta?.lastTouchedVersion ||
            config?.wizard?.lastRunVersion ||
            "Unknown",
        lastTouched:
            config?.meta?.lastTouchedAt || config?.wizard?.lastRunAt || "Unknown",
        configHash: config?.__hash ? `${config.__hash.slice(0, 12)}…` : "Unknown",
    };

    return {
        backupPending: createBackup.isPending,
        channels: configuredChannels(config),
        closeRestartModal: () => setShowRestartModal(false),
        config,
        dismissError: () => setError(undefined),
        error,
        handleAgentAccessSave,
        handleBackup,
        handleChannelsSave,
        handleHeartbeatSave,
        handleModelSave,
        handleRestart,
        handleSessionSave,
        handleSkillToggle,
        handleToolSave,
        heartbeatInfo,
        isLoading: configLoading || skillsLoading,
        modelInfo,
        openRestartModal: () => setShowRestartModal(true),
        restartPending: restartGateway.isPending,
        securityInfo,
        serverInfo,
        sessionInfo: { idleMinutes: config?.session?.reset?.idleMinutes || 30 },
        showRestartModal,
        skills,
        success,
        toolInfo,
        updatePending: updateConfig.isPending,
    };
}

export type OpenClawSettingsController = ReturnType<typeof useOpenClawSettingsController>;
