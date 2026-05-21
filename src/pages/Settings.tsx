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

/** Performs patch success. */
export function patchSuccess(
    setSuccess: (value: string | null) => void,
    message: string,
    timerRef?: { current: ReturnType<typeof setTimeout> | null }
) {
    if (timerRef?.current) clearTimeout(timerRef.current);
    setSuccess(message);
    const timeoutId = setTimeout(() => {
        setSuccess(null);
        if (timerRef) timerRef.current = null;
    }, 3000);
    if (timerRef) timerRef.current = timeoutId;
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
        .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Convert a duration value to a number of seconds.
 *
 * Accepts a number or a string with an optional unit suffix (`s`, `m`, `h`, `d`, case-insensitive).
 *
 * @param value - A numeric seconds value or a string like `"30s"`, `"5m"`, `"1h"`, `"2d"`. If the unit is omitted the value is treated as seconds.
 * @param fallback - Value to return when `value` is not a number or a matching duration string.
 * @returns The duration expressed in seconds, or `fallback` if `value` is not a supported format.
 */
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

/**
 * Get a human-readable message from an error, falling back to the provided string.
 *
 * @param error - Value that may be an `Error` instance
 * @param fallback - Message to return when `error` is not an `Error`
 * @returns `error.message` when `error` is an `Error`, otherwise `fallback`
 */
export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

/**
 * Normalize optional form input by converting empty or falsy strings to `undefined`.
 *
 * @param value - The form input value to normalize.
 * @returns The original `value` when it is a non-empty string, otherwise `undefined`.
 */
export function optionalFormValue(value?: string): string | undefined {
    return value || undefined;
}

/** Represents system host cache. */
interface SystemHostCache {
    version?: {
        current?: string;
        latest?: string | null;
        updateAvailable?: boolean;
    };
}

/**
 * Render the Settings page UI with configuration controls, backup/restart actions, and server information.
 *
 * Loads configuration, skills, and host data; provides handlers to save session, heartbeat, agent access,
 * model, tool, and channel settings; allows toggling skills, creating backups, and restarting the gateway.
 * Displays error and success alerts and clears internal timers on unmount.
 */
export function Settings() {
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const restartReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            if (successTimerRef.current) clearTimeout(successTimerRef.current);
            if (restartReloadTimerRef.current) {
                clearTimeout(restartReloadTimerRef.current);
            }
        };
    }, []);

    /**
     * Initiates a gateway restart; on success closes the restart modal and schedules a page reload after two seconds.
     *
     * On failure, sets the component error state with a user-facing message derived from the caught error.
     */
    async function handleRestart() {
        try {
            await restartGateway.mutateAsync();
            setShowRestartModal(false);
            restartReloadTimerRef.current = setTimeout(
                () => window.location.reload(),
                2000
            );
        } catch (error_) {
            setError(errorMessage(error_, "Failed to restart"));
        }
    }

    /**
     * Triggers a server backup and initiates a JSON file download.
     *
     * Calls the backup mutation, serializes the returned data to pretty JSON, and starts a download named
     * `openclaw-backup-YYYY-MM-DD.json`. On failure, sets the component error state with a backup failure message.
     */
    async function handleBackup() {
        try {
            const result = await createBackup.mutateAsync();
            const blob = new Blob([JSON.stringify(result, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `openclaw-backup-${new Date().toISOString().split("T")[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to backup"));
        }
    }

    /**
     * Toggle a skill's enabled state in the backend and set an error message if the update fails.
     *
     * @param skillName - The name of the skill to update.
     * @param enabled - Whether the skill should be enabled.
     */
    async function handleSkillToggle(skillName: string, enabled: boolean) {
        try {
            await toggleSkill.mutateAsync({ name: skillName, enabled });
        } catch (error_) {
            setError(errorMessage(error_, "Failed to update skill"));
        }
    }

    /**
     * Persist the session idle timeout (minutes) into the application configuration and display a success message on completion.
     *
     * On failure, sets the component's error message to a readable fallback.
     *
     * @param idleMinutes - Idle timeout in minutes to set for session reset
     */
    async function handleSessionSave(idleMinutes: number) {
        setError(null);
        try {
            await updateConfig.mutateAsync({
                session: { reset: { idleMinutes } },
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Session settings saved", successTimerRef);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /**
     * Save heartbeat configuration to the application's config.
     *
     * Updates `heartbeat.every` and `heartbeat.target`; if an agent with id `"ops"` exists, updates only that agent's `heartbeat`, otherwise updates the top-level `heartbeat`. When targeting an agent, `every` is converted to a string using minutes (`"Nm"`) when divisible by 60 or seconds (`"Ns"`) otherwise. The `target` parameter is normalized to `undefined` when empty.
     *
     * @param every - Heartbeat interval in seconds
     * @param target - Heartbeat target string (empty string becomes `undefined`)
     */
    async function handleHeartbeatSave(every: number, target: string) {
        setError(null);
        try {
            const nextEvery = every % 60 === 0 ? `${every / 60}m` : `${every}s`;
            const agents = config?.agents?.list || [];
            const opsAgent = agents.find((agent) => agent.id === "ops");
            const patch = opsAgent
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
                : { heartbeat: { every, target: optionalFormValue(target) } };

            await updateConfig.mutateAsync(patch as OpenClawConfig);
            patchSuccess(setSuccess, "Heartbeat settings saved", successTimerRef);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /**
     * Persist the provided agent access list to the application configuration and update UI state.
     *
     * Clears any existing error, updates config with the given agents list, shows a transient
     * success message on success, and sets a user-facing error message on failure.
     *
     * @param agents - The full list of agent configurations to save as `agents.list` in the config
     */
    async function handleAgentAccessSave(agents: AgentConfig[]) {
        setError(null);
        try {
            await updateConfig.mutateAsync({
                agents: {
                    list: agents,
                },
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Agent access settings saved", successTimerRef);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /**
     * Save agent model defaults from the provided form values into the application configuration.
     *
     * On success, sets a transient success message ("Model settings saved"); on failure, sets the error message
     * derived from the thrown error or the fallback "Failed to save".
     *
     * @param values - Object containing `primary` model id and an array of `fallbacks`
     */
    async function handleModelSave(values: { primary: string; fallbacks: string[] }) {
        setError(null);
        try {
            await updateConfig.mutateAsync({
                agents: { defaults: { model: values } },
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Model settings saved", successTimerRef);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /**
     * Save tool-related settings to the configuration and trigger success or error UI feedback.
     *
     * @param values - Form values for tool settings including profile, web search and fetch options, exec policies, elevated and agent-to-agent toggles, and sessions visibility
     */
    async function handleToolSave(values: ToolSettings) {
        setError(null);
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
            patchSuccess(setSuccess, "Tool settings saved", successTimerRef);
        } catch (error_) {
            setError(errorMessage(error_, "Failed to save"));
        }
    }

    /**
     * Persists the provided channel enabled states to the application configuration and displays a transient success message.
     *
     * @param channels - Array of channel summaries whose `enabled` state will be saved by channel id
     */
    async function handleChannelsSave(channels: ChannelSummary[]) {
        setError(null);
        try {
            await updateConfig.mutateAsync({
                channels: Object.fromEntries(
                    channels.map((channel) => [channel.id, { enabled: channel.enabled }])
                ),
            } as OpenClawConfig);
            patchSuccess(setSuccess, "Channel settings saved", successTimerRef);
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
                        onClick={() => setError(null)}
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
