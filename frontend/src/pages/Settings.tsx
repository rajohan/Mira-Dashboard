import { useLocation, useNavigate } from "@tanstack/react-router";
import { Download, Loader2, RefreshCw, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AgentConfig } from "../../../contracts/agents";
import {
    parseSystemHostSummary,
    type SystemHostSummary,
} from "../../../contracts/system";
import { AccountSecuritySection } from "../components/features/settings/AccountSecuritySection";
import { AgentAccessSection } from "../components/features/settings/AgentAccessSection";
import {
    ChannelSection,
    type ChannelSummary,
} from "../components/features/settings/ChannelSection";
import { HeartbeatSection } from "../components/features/settings/HeartbeatSection";
import { ModelSection } from "../components/features/settings/ModelSection";
import { SecuritySection } from "../components/features/settings/SecuritySection";
import { SessionSection } from "../components/features/settings/SessionSection";
import { SkillsSection } from "../components/features/settings/SkillsSection";
import {
    ToolSection,
    type ToolSettings,
} from "../components/features/settings/ToolSection";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/LoadingState";
import { Modal } from "../components/ui/Modal";
import { useCacheEntry } from "../hooks/useCache";
import {
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "../hooks/useConfig";
import { messageFromError } from "../lib/errorMessage";
import { currentIsoString } from "../utils/date";
import {
    clearTimer,
    configuredChannels,
    numberFromDuration,
    optionalFormValue,
    patchSuccess,
} from "./settingsPageUtilities";

type SettingsView = "dashboard" | "openclaw";

/**
 * Renders the settings UI.
 * @returns Rendered the settings UI.
 */
export function Settings() {
    const navigate = useNavigate();
    const search = useLocation({ select: (location_) => location_.search });
    const view: SettingsView = search.view === "openclaw" ? "openclaw" : "dashboard";
    const setView = (nextView: SettingsView) => {
        void navigate({
            replace: true,
            search: { view: nextView },
            to: "/settings",
        });
    };
    const [error, setError] = useState<string | undefined>();
    const [success, setSuccess] = useState<string | undefined>();
    const [showRestartModal, setShowRestartModal] = useState(false);
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const restartReloadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );

    // Queries
    const shouldLoadOpenClawSettings = view === "openclaw";
    const { data: config, isLoading: configLoading } = useConfig(
        shouldLoadOpenClawSettings
    );
    const { data: skills = [], isLoading: skillsLoading } = useSkills(
        shouldLoadOpenClawSettings
    );
    const { data: systemHost } = useCacheEntry<SystemHostSummary>(
        "system.host",
        parseSystemHostSummary,
        60_000
    );

    // Mutations
    const updateConfig = useUpdateConfig();
    const toggleSkill = useToggleSkill();
    const restartGateway = useRestartGateway();
    const createBackup = useCreateBackup();

    const isLoading = shouldLoadOpenClawSettings && (configLoading || skillsLoading);

    useEffect(() => {
        return () => {
            clearTimer(successTimerRef);
            clearTimer(restartReloadTimerRef);
        };
    }, []);

    /** Responds to restart events. */
    async function handleRestart() {
        try {
            await restartGateway.mutateAsync();
            setShowRestartModal(false);
            restartReloadTimerRef.current = setTimeout(() => location.reload(), 2000);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to restart"));
        }
    }

    /** Responds to backup events. */
    async function handleBackup() {
        try {
            const result = await createBackup.mutateAsync();
            const blob = new Blob([JSON.stringify(result, undefined, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `openclaw-backup-${currentIsoString().split("T", 1)[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to backup"));
        }
    }

    /**
     * Responds to skill toggle events.
     * @param skillName Skill name value.
     * @param isEnabled Whether is enabled.
     */
    async function handleSkillToggle(skillName: string, isEnabled: boolean) {
        try {
            await toggleSkill.mutateAsync({ name: skillName, enabled: isEnabled });
        } catch (error_) {
            setError(messageFromError(error_, "Failed to update skill"));
        }
    }

    /**
     * Responds to session save events.
     * @param idleMinutes Idle minutes value.
     */
    async function handleSessionSave(idleMinutes: number) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                session: { reset: { idleMinutes } },
            });
            patchSuccess(setSuccess, "Session settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    /**
     * Responds to heartbeat save events.
     * @param every Every value.
     * @param target Target value.
     */
    async function handleHeartbeatSave(every: number, target: string) {
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

    /**
     * Responds to agent access save events.
     * @param agents Agents value.
     */
    async function handleAgentAccessSave(agents: AgentConfig[]) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                agents: {
                    list: agents,
                },
            });
            patchSuccess(setSuccess, "Agent access settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    /**
     * Responds to model save events.
     * @param values Values value.
     */
    async function handleModelSave(values: { primary: string; fallbacks: string[] }) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                agents: { defaults: { model: values } },
            });
            patchSuccess(setSuccess, "Model settings saved", successTimerRef);
        } catch (error_) {
            setError(messageFromError(error_, "Failed to save"));
        }
    }

    /** Responds to tool save events. */
    async function handleToolSave(values: ToolSettings) {
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
                    exec: {
                        security: values.execSecurity,
                        ask: values.execAsk,
                    },
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

    /**
     * Responds to channels save events.
     * @param channels Channels value.
     */
    async function handleChannelsSave(channels: ChannelSummary[]) {
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

    if (isLoading) {
        return <LoadingState size="lg" />;
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

    const sessionInfo = {
        idleMinutes: config?.session?.reset?.idleMinutes || 30,
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

    return (
        <div className="space-y-3 p-3 sm:space-y-4 sm:p-4 lg:p-6">
            <Card className="p-2" variant="bordered">
                <div className="grid grid-cols-2 gap-2">
                    <Button
                        aria-pressed={view === "dashboard"}
                        className="justify-center"
                        onClick={() => setView("dashboard")}
                        variant={view === "dashboard" ? "primary" : "secondary"}
                    >
                        Dashboard settings
                    </Button>
                    <Button
                        aria-pressed={view === "openclaw"}
                        className="justify-center"
                        onClick={() => setView("openclaw")}
                        variant={view === "openclaw" ? "primary" : "secondary"}
                    >
                        OpenClaw settings
                    </Button>
                </div>
            </Card>

            {view === "dashboard" ? (
                <AccountSecuritySection />
            ) : (
                <>
                    <div className="flex justify-end">
                        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    void handleBackup();
                                }}
                                disabled={createBackup.isPending}
                            >
                                {createBackup.isPending ? (
                                    <>
                                        <Loader2 className="size-4 animate-spin" />
                                        Backing up...
                                    </>
                                ) : (
                                    <>
                                        <Download className="size-4" />
                                        Backup
                                    </>
                                )}
                            </Button>
                            <Button
                                variant="danger"
                                onClick={() => setShowRestartModal(true)}
                            >
                                <RefreshCw className="size-4" />
                                Restart
                            </Button>
                        </div>
                    </div>

                    {error && (
                        <Alert variant="error">
                            {error}
                            <Button
                                variant="ghost"
                                size="sm"
                                className="ml-auto"
                                onClick={() => setError(undefined)}
                            >
                                ×
                            </Button>
                        </Alert>
                    )}

                    {success && <Alert variant="success">{success}</Alert>}

                    <ModelSection
                        key={`models:${config?.__hash || "empty"}`}
                        defaultModel={modelInfo.defaultModel}
                        fallbacks={modelInfo.fallbacks}
                        imageModel={modelInfo.imageModel}
                        imageGenerationModel={modelInfo.imageGenerationModel}
                        onSave={handleModelSave}
                        saving={updateConfig.isPending}
                    />

                    <ChannelSection
                        key={`channels:${config?.__hash || "empty"}`}
                        channels={configuredChannels(config)}
                        onSave={handleChannelsSave}
                        saving={updateConfig.isPending}
                    />

                    <ToolSection
                        key={`tools:${config?.__hash || "empty"}`}
                        {...toolInfo}
                        onSave={handleToolSave}
                        saving={updateConfig.isPending}
                    />

                    <SecuritySection {...securityInfo} />

                    <SessionSection
                        idleMinutes={sessionInfo.idleMinutes}
                        onSave={handleSessionSave}
                        saving={updateConfig.isPending}
                    />

                    <HeartbeatSection
                        every={heartbeatInfo.every}
                        target={heartbeatInfo.target}
                        onSave={handleHeartbeatSave}
                        saving={updateConfig.isPending}
                    />

                    <SkillsSection
                        skills={skills}
                        onToggle={(skillName, isEnabled) => {
                            void handleSkillToggle(skillName, isEnabled);
                        }}
                    />

                    <AgentAccessSection
                        key={`agents:${config?.__hash || "empty"}`}
                        agents={config?.agents?.list || []}
                        onSave={handleAgentAccessSave}
                        saving={updateConfig.isPending}
                    />

                    {/* Server Info */}
                    <div className="rounded-lg border border-primary-700 bg-primary-800/50 p-3 sm:p-4">
                        <div className="mb-2 flex items-center gap-2">
                            <Server className="size-4 text-accent-400" />
                            <h3 className="text-sm font-medium text-primary-200">
                                Server
                            </h3>
                        </div>
                        <div className="space-y-2">
                            <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                                <span className="text-sm text-primary-400">Version</span>
                                <span className="font-mono text-sm break-all text-primary-100 sm:text-right">
                                    {serverInfo.version}
                                </span>
                            </div>
                            <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                                <span className="text-sm text-primary-400">
                                    Config hash
                                </span>
                                <span className="font-mono text-sm break-all text-primary-100 sm:text-right">
                                    {serverInfo.configHash}
                                </span>
                            </div>
                            <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                                <span className="text-sm text-primary-400">
                                    Last touched
                                </span>
                                <span className="font-mono text-sm break-all text-primary-100 sm:text-right">
                                    {serverInfo.lastTouched}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Restart Modal */}
                    <Modal
                        isOpen={showRestartModal}
                        onClose={() => setShowRestartModal(false)}
                        title="Restart Gateway"
                        size="sm"
                    >
                        <div className="space-y-4">
                            <p className="text-sm text-primary-300">
                                Are you sure you want to restart the gateway? This will
                                temporarily disconnect all sessions.
                            </p>
                            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                                <Button
                                    variant="secondary"
                                    onClick={() => setShowRestartModal(false)}
                                    disabled={restartGateway.isPending}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="danger"
                                    onClick={() => {
                                        void handleRestart();
                                    }}
                                    disabled={restartGateway.isPending}
                                >
                                    {restartGateway.isPending ? (
                                        <>
                                            <Loader2 className="size-4 animate-spin" />
                                            Restarting...
                                        </>
                                    ) : (
                                        "Restart"
                                    )}
                                </Button>
                            </div>
                        </div>
                    </Modal>
                </>
            )}
        </div>
    );
}
