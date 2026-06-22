import { Download, Loader2, RefreshCw, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
    AgentAccessSection,
    ChannelSection,
    HeartbeatSection,
    ModelSection,
    SecuritySection,
    SessionSection,
    SkillsSection,
    ToolSection,
} from "../components/features/settings";
import type { ChannelSummary } from "../components/features/settings/ChannelSection";
import type { ToolSettings } from "../components/features/settings/ToolSection";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { LoadingState } from "../components/ui/LoadingState";
import { Modal } from "../components/ui/Modal";
import {
    useCacheEntry,
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "../hooks";
import type { AgentConfig, OpenClawConfig, Skill } from "../hooks/useConfig";
import { currentIsoString } from "../utils/date";

/** Performs patch success. */
export function patchSuccess(
    setSuccess: (value: string | undefined) => void,
    message: string,
    timerReference?: { current: ReturnType<typeof setTimeout> | undefined }
) {
    if (timerReference?.current) clearTimeout(timerReference.current);
    setSuccess(message);
    const timeoutId = setTimeout(() => {
        setSuccess(undefined);
        if (timerReference) timerReference.current = undefined;
    }, 3000);
    if (timerReference) timerReference.current = timeoutId;
}

/** Performs configured channels. */
export function configuredChannels(config?: OpenClawConfig): ChannelSummary[] {
    const channels = (config?.channels || {}) as Record<string, Record<string, unknown>>;
    return Object.entries(channels)
        .map(([id, value]) => ({
            id,
            enabled: value.enabled === true,
            policy:
                typeof value.groupPolicy === "string"
                    ? `group: ${value.groupPolicy}`
                    : typeof value.dmPolicy === "string"
                      ? `dm: ${value.dmPolicy}`
                      : undefined,
            details:
                typeof value.botId === "string"
                    ? value.botId
                    : Array.isArray(value.allowFrom)
                      ? `${value.allowFrom.length} allowed senders`
                      : undefined,
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Performs number from duration. */
export function numberFromDuration(value: unknown, fallback: number): number {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return fallback;
    const match = value.match(/^(\d+)([smhd])?$/i);
    if (!match) return fallback;
    const amount = Number(match[1]);
    const unit = (match[2] || "s").toLowerCase() as "s" | "m" | "h" | "d";
    const factors: Record<typeof unit, number> = {
        s: 1,
        m: 60,
        h: 3600,
        d: 86_400,
    };
    return amount * factors[unit];
}

/** Returns a displayable error message with a stable fallback. */
export function errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) {
        return fallback;
    }

    const message = error.message.trim();
    return message || fallback;
}

/** Returns undefined for empty form values before writing config patches. */
export function optionalFormValue(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
}

/** Represents system host cache. */
interface SystemHostCache {
    version?: {
        current?: string;
        latest?: string | undefined;
        updateAvailable?: boolean;
    };
}

/** Renders the settings UI. */
export function Settings() {
    const [error, setError] = useState<string | undefined>(undefined);
    const [success, setSuccess] = useState<string | undefined>(undefined);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const successTimerReference = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    const restartReloadTimerReference = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );

    // Queries
    const { data: config, isLoading: configLoading } = useConfig();
    const { data: skills = [], isLoading: skillsLoading } = useSkills();
    const { data: systemHost } = useCacheEntry<SystemHostCache>("system.host", 60_000);

    // Mutations
    const updateConfig = useUpdateConfig();
    const toggleSkill = useToggleSkill();
    const restartGateway = useRestartGateway();
    const createBackup = useCreateBackup();

    const loading = configLoading || skillsLoading;

    useEffect(() => {
        return () => {
            if (successTimerReference.current)
                clearTimeout(successTimerReference.current);
            if (restartReloadTimerReference.current) {
                clearTimeout(restartReloadTimerReference.current);
            }
        };
    }, []);

    /** Responds to restart events. */
    async function handleRestart() {
        try {
            await restartGateway.mutateAsync();
            setShowRestartModal(false);
            restartReloadTimerReference.current = setTimeout(
                () => location.reload(),
                2000
            );
        } catch (error_) {
            setError(errorMessage(error_, "Failed to restart"));
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
            setError(errorMessage(error_, "Failed to backup"));
        }
    }

    /** Responds to skill toggle events. */
    async function handleSkillToggle(skillName: string, isEnabled: boolean) {
        try {
            await toggleSkill.mutateAsync({ name: skillName, enabled: isEnabled });
        } catch (error_) {
            setError(errorMessage(error_, "Failed to update skill"));
        }
    }

    /** Responds to session save events. */
    async function handleSessionSave(idleMinutes: number) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                session: { reset: { idleMinutes } },
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Session settings saved", successTimerReference);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /** Responds to heartbeat save events. */
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

            await updateConfig.mutateAsync(patch as OpenClawConfig);
            patchSuccess(setSuccess, "Heartbeat settings saved", successTimerReference);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /** Responds to agent access save events. */
    async function handleAgentAccessSave(agents: AgentConfig[]) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                agents: {
                    list: agents,
                },
            } as OpenClawConfig);
            patchSuccess(
                setSuccess,
                "Agent access settings saved",
                successTimerReference
            );
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /** Responds to model save events. */
    async function handleModelSave(values: { primary: string; fallbacks: string[] }) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                agents: { defaults: { model: values } },
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Model settings saved", successTimerReference);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
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
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Tool settings saved", successTimerReference);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /** Responds to channels save events. */
    async function handleChannelsSave(channels: ChannelSummary[]) {
        setError(undefined);
        try {
            await updateConfig.mutateAsync({
                channels: Object.fromEntries(
                    channels.map((channel) => [channel.id, { enabled: channel.enabled }])
                ),
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Channel settings saved", successTimerReference);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    if (loading) {
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
            <div className="flex justify-end">
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                    <Button
                        variant="secondary"
                        onClick={handleBackup}
                        disabled={createBackup.isPending}
                    >
                        {createBackup.isPending ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Backing up...
                            </>
                        ) : (
                            <>
                                <Download className="h-4 w-4" />
                                Backup
                            </>
                        )}
                    </Button>
                    <Button variant="danger" onClick={() => setShowRestartModal(true)}>
                        <RefreshCw className="h-4 w-4" />
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
                defaultModel={modelInfo.defaultModel}
                fallbacks={modelInfo.fallbacks}
                imageModel={modelInfo.imageModel}
                imageGenerationModel={modelInfo.imageGenerationModel}
                onSave={handleModelSave}
                saving={updateConfig.isPending}
            />

            <ChannelSection
                channels={configuredChannels(config)}
                onSave={handleChannelsSave}
                saving={updateConfig.isPending}
            />

            <ToolSection
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

            <SkillsSection skills={skills as Skill[]} onToggle={handleSkillToggle} />

            <AgentAccessSection
                agents={config?.agents?.list || []}
                onSave={handleAgentAccessSave}
                saving={updateConfig.isPending}
            />

            {/* Server Info */}
            <div className="border-primary-700 bg-primary-800/50 rounded-lg border p-3 sm:p-4">
                <div className="mb-2 flex items-center gap-2">
                    <Server className="text-accent-400 h-4 w-4" />
                    <h3 className="text-primary-200 text-sm font-medium">Server</h3>
                </div>
                <div className="space-y-2">
                    <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="text-primary-400 text-sm">Version</span>
                        <span className="text-primary-100 font-mono text-sm break-all sm:text-right">
                            {serverInfo.version}
                        </span>
                    </div>
                    <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="text-primary-400 text-sm">Config hash</span>
                        <span className="text-primary-100 font-mono text-sm break-all sm:text-right">
                            {serverInfo.configHash}
                        </span>
                    </div>
                    <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="text-primary-400 text-sm">Last touched</span>
                        <span className="text-primary-100 font-mono text-sm break-all sm:text-right">
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
                    <p className="text-primary-300 text-sm">
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
                            onClick={handleRestart}
                            disabled={restartGateway.isPending}
                        >
                            {restartGateway.isPending ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Restarting...
                                </>
                            ) : (
                                "Restart"
                            )}
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
