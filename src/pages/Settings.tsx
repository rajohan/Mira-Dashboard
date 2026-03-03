import {
    AlertCircle,
    Check,
    Download,
    Loader2,
    RefreshCw,
    Server,
} from "lucide-react";
import { useEffect, useState } from "react";

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
import { type Config, type Skill } from "../types/settings";

export function Settings() {
    const [config, setConfig] = useState<Config | null>(null);
    const [skills, setSkills] = useState<Skill[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const [showRestartModal, setShowRestartModal] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [backingUp, setBackingUp] = useState(false);

    useEffect(() => {
        fetchConfig();
        fetchSkills();
    }, []);

    async function fetchConfig() {
        try {
            const res = await fetch("/api/config");
            if (res.ok) {
                const data = await res.json();
                setConfig(data);
            }
        } catch (error_) {
            console.error("Failed to fetch config:", error_);
        } finally {
            setLoading(false);
        }
    }

    async function fetchSkills() {
        try {
            const res = await fetch("/api/skills");
            if (res.ok) {
                const data = await res.json();
                setSkills(data.skills || []);
            }
        } catch (error_) {
            console.error("Failed to fetch skills:", error_);
        }
    }

    async function handleRestart() {
        setRestarting(true);
        try {
            const res = await fetch("/api/restart", { method: "POST" });
            if (res.ok) {
                setShowRestartModal(false);
                setTimeout(() => window.location.reload(), 2000);
            } else {
                setError("Failed to initiate restart");
            }
        } catch (error_: unknown) {
            const errorMessage =
                error_ instanceof Error ? error_.message : "Failed to restart";
            setError(errorMessage);
        } finally {
            setRestarting(false);
        }
    }

    async function handleBackup() {
        setBackingUp(true);
        try {
            const res = await fetch("/api/backup", { method: "POST" });
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "openclaw-backup-" + new Date().toISOString().split("T")[0] + ".json";
                a.click();
                URL.revokeObjectURL(url);
            } else {
                setError("Failed to create backup");
            }
        } catch (error_: unknown) {
            const errorMessage =
                error_ instanceof Error ? error_.message : "Failed to backup";
            setError(errorMessage);
        } finally {
            setBackingUp(false);
        }
    }

    async function handleSkillToggle(skillName: string, enabled: boolean) {
        try {
            const res = await fetch("/api/skills/" + skillName, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled }),
            });
            if (res.ok) {
                setSkills((prev) =>
                    prev.map((s) =>
                        s.name === skillName ? { ...s, enabled } : s
                    )
                );
            } else {
                setError("Failed to update skill");
            }
        } catch (error_: unknown) {
            const errorMessage =
                error_ instanceof Error ? error_.message : "Failed to update skill";
            setError(errorMessage);
        }
    }

    async function handleSessionSave(idleMinutes: number) {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch("/api/config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    session: { reset: { idleMinutes } },
                }),
            });
            if (res.ok) {
                setSuccess("Session settings saved");
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || "Failed to save");
            }
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "Failed to save");
        } finally {
            setSaving(false);
        }
    }

    async function handleHeartbeatSave(every: number, target: string) {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch("/api/config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    heartbeat: { every, target: target || undefined },
                }),
            });
            if (res.ok) {
                setSuccess("Heartbeat settings saved");
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || "Failed to save");
            }
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "Failed to save");
        } finally {
            setSaving(false);
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
                    <Button variant="secondary" onClick={handleBackup} disabled={backingUp}>
                        {backingUp ? (
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
                saving={saving}
            />

            <HeartbeatSection
                every={heartbeatInfo.every}
                target={heartbeatInfo.target}
                onSave={handleHeartbeatSave}
                saving={saving}
            />

            <SkillsSection skills={skills} onToggle={handleSkillToggle} />

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
                            disabled={restarting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleRestart}
                            disabled={restarting}
                        >
                            {restarting ? (
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