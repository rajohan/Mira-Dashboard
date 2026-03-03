import { useForm } from "@tanstack/react-form";
import {
    AlertCircle,
    Check,
    Clock,
    Download,
    Heart,
    Loader2,
    MessageSquare,
    RefreshCw,
    Server,
    Shield,
    Users,
    Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Switch } from "../components/ui/Switch";
import { ExpandableCard, ReadOnlyField } from "../components/ui/ExpandableCard";
import { type Config, type Skill, type SettingsForm } from "../types/settings";

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

    const form = useForm({
        defaultValues: {
            idleMinutes: 30,
            heartbeatEvery: 60,
            heartbeatTarget: "",
        } as SettingsForm,
        onSubmit: async ({ value }) => {
            setSaving(true);
            setError(null);
            setSuccess(null);

            try {
                const updates: Partial<Config> = {
                    session: {
                        reset: {
                            idleMinutes: value.idleMinutes,
                        },
                    },
                    heartbeat: {
                        every: value.heartbeatEvery,
                        target: value.heartbeatTarget || undefined,
                    },
                };

                const res = await fetch("/api/config", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(updates),
                });

                if (res.ok) {
                    setSuccess("Configuration saved successfully");
                    setTimeout(() => setSuccess(null), 3000);
                } else {
                    const data = await res.json();
                    setError(data.error || "Failed to save configuration");
                }
            } catch (error_: unknown) {
                const errorMessage =
                    error_ instanceof Error
                        ? error_.message
                        : "Failed to save configuration";
                setError(errorMessage);
            } finally {
                setSaving(false);
            }
        },
    });

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
                form.setFieldValue(
                    "idleMinutes",
                    data?.session?.reset?.idleMinutes || 30
                );
                form.setFieldValue("heartbeatEvery", data?.heartbeat?.every || 60);
                form.setFieldValue("heartbeatTarget", data?.heartbeat?.target || "");
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

    const handleRestart = useCallback(async () => {
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
    }, []);

    const handleBackup = useCallback(async () => {
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
    }, []);

    const handleSkillToggle = useCallback(
        async (skillName: string, enabled: boolean) => {
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
        },
        []
    );

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
                    <Button
                        variant="danger"
                        onClick={() => setShowRestartModal(true)}
                    >
                        <RefreshCw className="h-4 w-4" />
                        Restart
                    </Button>
                </div>
            </div>

            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    <AlertCircle size={16} />
                    {error}
                    <button
                        className="ml-auto text-red-300 hover:text-red-100"
                        onClick={() => setError(null)}
                    >
                        ×
                    </button>
                </div>
            )}

            {success && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-500 bg-green-500/20 p-3 text-green-400">
                    <Check size={16} />
                    {success}
                </div>
            )}

            {/* Model Configuration */}
            <ExpandableCard title="Model Configuration" icon={Wrench} defaultExpanded>
                <div className="space-y-2">
                    <ReadOnlyField label="Default Model" value={modelInfo.defaultModel} />
                    <ReadOnlyField label="Fallback Models" value={modelInfo.fallbacks} />
                    <ReadOnlyField
                        label="Context Window"
                        value={modelInfo.contextWindow.toLocaleString() + " tokens"}
                    />
                    <ReadOnlyField label="Temperature" value={modelInfo.temperature} />
                </div>
            </ExpandableCard>

            {/* Channel Configuration */}
            <ExpandableCard title="Channels" icon={MessageSquare}>
                <div className="space-y-2">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-slate-400">Discord</span>
                        <span
                            className={
                                channelInfo.discordEnabled
                                    ? "text-green-400"
                                    : "text-slate-500"
                            }
                        >
                            {channelInfo.discordEnabled ? "Enabled" : "Disabled"}
                        </span>
                    </div>
                    <ReadOnlyField label="Bot ID" value={channelInfo.discordBotId} />
                </div>
            </ExpandableCard>

            {/* Tool Configuration */}
            <ExpandableCard title="Tools" icon={Wrench}>
                <div className="space-y-2">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-slate-400">Web Search</span>
                        <span
                            className={
                                toolInfo.webSearchEnabled
                                    ? "text-green-400"
                                    : "text-slate-500"
                            }
                        >
                            {toolInfo.webSearchEnabled
                                ? "Enabled (" + toolInfo.webSearchProvider + ")"
                                : "Disabled"}
                        </span>
                    </div>
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-slate-400">Exec</span>
                        <span
                            className={
                                toolInfo.execEnabled ? "text-green-400" : "text-slate-500"
                            }
                        >
                            {toolInfo.execEnabled
                                ? "Enabled (" + toolInfo.execMode + ")"
                                : "Disabled"}
                        </span>
                    </div>
                </div>
            </ExpandableCard>

            {/* Security Configuration */}
            <ExpandableCard title="Security" icon={Shield}>
                <div className="space-y-2">
                    <ReadOnlyField label="Gateway Port" value={securityInfo.gatewayPort} />
                    <ReadOnlyField label="Mode" value={securityInfo.gatewayMode} />
                    <ReadOnlyField
                        label="Authentication"
                        value={
                            securityInfo.authEnabled
                                ? securityInfo.authType
                                : "Disabled"
                        }
                    />
                </div>
            </ExpandableCard>

            {/* Session Configuration */}
            <ExpandableCard title="Session" icon={Clock}>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        form.handleSubmit();
                    }}
                    className="space-y-4"
                >
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-300">
                            Idle Timeout (minutes)
                        </label>
                        <form.Field name="idleMinutes">
                            {(field) => (
                                <Input
                                    type="number"
                                    value={field.state.value}
                                    onChange={(e) =>
                                        field.handleChange(Number(e.target.value))
                                    }
                                    min={0}
                                    max={1440}
                                    className="w-32"
                                />
                            )}
                        </form.Field>
                    </div>
                    <div className="flex justify-end">
                        <Button type="submit" variant="primary" disabled={saving}>
                            {saving ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Check className="h-4 w-4" />
                                    Save
                                </>
                            )}
                        </Button>
                    </div>
                </form>
            </ExpandableCard>

            {/* Heartbeat Configuration */}
            <ExpandableCard title="Heartbeat" icon={Heart}>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        form.handleSubmit();
                    }}
                    className="space-y-4"
                >
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-300">
                            Interval (seconds)
                        </label>
                        <form.Field name="heartbeatEvery">
                            {(field) => (
                                <Input
                                    type="number"
                                    value={field.state.value}
                                    onChange={(e) =>
                                        field.handleChange(Number(e.target.value))
                                    }
                                    min={60}
                                    max={3600}
                                    className="w-32"
                                />
                            )}
                        </form.Field>
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-slate-300">
                            Target Channel
                        </label>
                        <form.Field name="heartbeatTarget">
                            {(field) => (
                                <Input
                                    type="text"
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    placeholder="Channel ID or name"
                                    className="w-64"
                                />
                            )}
                        </form.Field>
                    </div>
                    <div className="flex justify-end">
                        <Button type="submit" variant="primary" disabled={saving}>
                            {saving ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Check className="h-4 w-4" />
                                    Save
                                </>
                            )}
                        </Button>
                    </div>
                </form>
            </ExpandableCard>

            {/* Skills */}
            <ExpandableCard title="Skills" icon={Users}>
                <div className="space-y-2">
                    {skills.length === 0 ? (
                        <p className="text-sm text-slate-400">No skills configured</p>
                    ) : (
                        skills.map((skill) => (
                            <div
                                key={skill.name}
                                className="flex items-center justify-between py-2"
                            >
                                <div>
                                    <p className="text-sm font-medium text-slate-200">
                                        {skill.name}
                                    </p>
                                    {skill.description && (
                                        <p className="text-xs text-slate-400">
                                            {skill.description}
                                        </p>
                                    )}
                                </div>
                                <Switch
                                    checked={skill.enabled}
                                    onChange={(e) =>
                                        handleSkillToggle(skill.name, e.target.checked)
                                    }
                                />
                            </div>
                        ))
                    )}
                </div>
            </ExpandableCard>

            {/* Server Info */}
            <ExpandableCard title="Server" icon={Server}>
                <div className="space-y-2">
                    <ReadOnlyField label="Version" value="2026.2.23" />
                    <ReadOnlyField label="Platform" value={typeof window !== 'undefined' ? window.navigator.platform : 'Unknown'} />
                </div>
            </ExpandableCard>

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