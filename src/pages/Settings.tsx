import {
    AlertCircle,
    Check,
    Download,
    Loader2,
    RefreshCw,
    Server,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import {
    ModelSection,
    ChannelSection,
    ToolSection,
    SecuritySection,
    SessionSection,
    HeartbeatSection,
    SkillsSection,
} from "../components/features/settings";
import {
    useConfig,
    useSkills,
    useUpdateConfig,
    useToggleSkill,
    useRestartGateway,
    useCreateBackup,
} from "../hooks";
import type { OpenClawConfig, Skill } from "../hooks/useConfig";

export function Settings() {
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [showRestartModal, setShowRestartModal] = useState(false);

    // Queries
    const { data: config, isLoading: configLoading } = useConfig();
    const { data: skills = [], isLoading: skillsLoading } = useSkills();

    // Mutations
    const updateConfig = useUpdateConfig();
    const toggleSkill = useToggleSkill();
    const restartGateway = useRestartGateway();
    const createBackup = useCreateBackup();

    const loading = configLoading || skillsLoading;

    async function handleRestart() {
        try {
            await restartGateway.mutateAsync();
            setShowRestartModal(false);
            setTimeout(() => window.location.reload(), 2000);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to restart");
        }
    }

    async function handleBackup() {
        try {
            const result = await createBackup.mutateAsync();
            // Create download link
            const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `openclaw-backup-${new Date().toISOString().split("T")[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to backup");
        }
    }

    async function handleSkillToggle(skillName: string, enabled: boolean) {
        try {
            await toggleSkill.mutateAsync({ name: skillName, enabled });
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to update skill");
        }
    }

    async function handleSessionSave(idleMinutes: number) {
        setError(null);
        try {
            await updateConfig.mutateAsync({
                session: { reset: { idleMinutes } },
            } as OpenClawConfig);
            setSuccess("Session settings saved");
            setTimeout(() => setSuccess(null), 3000);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to save");
        }
    }

    async function handleHeartbeatSave(every: number, target: string) {
        setError(null);
        try {
            await updateConfig.mutateAsync({
                heartbeat: { every, target: target || undefined },
            } as OpenClawConfig);
            setSuccess("Heartbeat settings saved");
            setTimeout(() => setSuccess(null), 3000);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to save");
        }
    }

    if (loading) {
        return (
            <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-accent-400" />
            </div>
        );
    }

    const modelInfo = {
        defaultModel: config?.agents?.defaultModel || "Not set",
        fallbacks: config?.agents?.fallbacks?.join(", ") || "None",
        contextWindow: config?.agents?.contextSettings?.maxTokens || 128000,
        temperature: config?.agents?.contextSettings?.temperature || 0.7,
    };

    const channelInfo = {
        discordEnabled: config?.channels?.discord?.enabled || false,
        discordBotId: config?.channels?.discord?.botId || "Not configured",
    };

    const toolInfo = {
        webSearchEnabled: config?.tools?.webSearch?.enabled || false,
        webSearchProvider: config?.tools?.webSearch?.provider || "None",
        execEnabled: config?.tools?.exec?.enabled || false,
        execMode: config?.tools?.exec?.mode || "disabled",
    };

    const securityInfo = {
        gatewayPort: config?.gateway?.port || 18789,
        gatewayMode: config?.gateway?.mode || "development",
        authEnabled: config?.gateway?.auth?.enabled || false,
        authType: config?.gateway?.auth?.type || "None",
    };

    const sessionInfo = {
        idleMinutes: config?.session?.reset?.idleMinutes || 30,
    };

    const heartbeatInfo = {
        every: config?.heartbeat?.every || 60,
        target: config?.heartbeat?.target || "",
    };

    return (
        <div className="p-6">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Settings</h1>
                <div className="flex gap-2">
                    <Button variant="secondary" onClick={handleBackup} disabled={createBackup.isPending}>
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
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    <AlertCircle size={16} />
                    {error}
                    <Button variant="ghost" size="sm" className="ml-auto text-red-300 hover:text-red-100" onClick={() => setError(null)}>
                        ×
                    </Button>
                </div>
            )}

            {success && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-500 bg-green-500/20 p-3 text-green-400">
                    <Check size={16} />
                    {success}
                </div>
            )}

            <ModelSection
                defaultModel={modelInfo.defaultModel}
                fallbacks={modelInfo.fallbacks}
                contextWindow={modelInfo.contextWindow}
                temperature={modelInfo.temperature}
            />

            <ChannelSection
                discordEnabled={channelInfo.discordEnabled}
                discordBotId={channelInfo.discordBotId}
            />

            <ToolSection
                webSearchEnabled={toolInfo.webSearchEnabled}
                webSearchProvider={toolInfo.webSearchProvider}
                execEnabled={toolInfo.execEnabled}
                execMode={toolInfo.execMode}
            />

            <SecuritySection
                gatewayPort={securityInfo.gatewayPort}
                gatewayMode={securityInfo.gatewayMode}
                authEnabled={securityInfo.authEnabled}
                authType={securityInfo.authType}
            />

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
                skills={skills as Skill[]}
                onToggle={handleSkillToggle}
            />

            {/* Server Info */}
            <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <div className="flex items-center gap-2 mb-2">
                    <Server className="h-4 w-4 text-accent-400" />
                    <h3 className="text-sm font-medium text-slate-200">Server</h3>
                </div>
                <div className="space-y-2">
                    <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-slate-400">Version</span>
                        <span className="font-mono text-sm text-primary-100">2026.2.23</span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-slate-400">Platform</span>
                        <span className="font-mono text-sm text-primary-100">
                            {typeof window !== "undefined" ? window.navigator.platform : "Unknown"}
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
                    <p className="text-sm text-slate-300">
                        Are you sure you want to restart the gateway? This will
                        temporarily disconnect all sessions.
                    </p>
                    <div className="flex justify-end gap-2">
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