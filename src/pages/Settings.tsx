import { useForm } from "@tanstack/react-form";
import {
    AlertCircle,
    Check,
    ChevronDown,
    ChevronRight,
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
import { Card, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Switch } from "../components/ui/Switch";

// Types
interface Skill {
    name: string;
    description?: string;
    enabled: boolean;
    location?: string;
}

interface Config {
    gateway?: {
        port?: number;
        mode?: string;
        auth?: {
            type?: string;
            enabled?: boolean;
        };
    };
    agents?: {
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
        [key: string]: unknown;
    };
    session?: {
        reset?: {
            mode?: string;
            idleMinutes?: number;
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
    heartbeat?: {
        enabled?: boolean;
        every?: number;
        target?: string;
    };
}

interface SettingsForm {
    idleMinutes: number;
    heartbeatEvery: number;
    heartbeatTarget: string;
}

// Expandable card component
function ExpandableCard({
    title,
    icon: Icon,
    children,
    defaultExpanded = false,
}: {
    title: string;
    icon: React.ElementType;
    children: React.ReactNode;
    defaultExpanded?: boolean;
}) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    return (
        <Card variant="bordered" className="mb-4">
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex w-full items-center justify-between py-1"
            >
                <div className="flex items-center gap-2">
                    <Icon size={18} className="text-accent-400" />
                    <CardTitle>{title}</CardTitle>
                </div>
                {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            </button>
            {isExpanded && (
                <div className="mt-4 border-t border-primary-700 pt-4">{children}</div>
            )}
        </Card>
    );
}

// Read-only field display
function ReadOnlyField({
    label,
    value,
}: {
    label: string;
    value?: string | number | boolean;
}) {
    return (
        <div className="flex items-center justify-between py-2">
            <span className="text-sm text-slate-400">{label}</span>
            <span className="font-mono text-sm text-primary-100">
                {value === undefined || value === null ? "—" : String(value)}
            </span>
        </div>
    );
}

export function Settings() {
    const [config, setConfig] = useState<Config | null>(null);
    const [skills, setSkills] = useState<Skill[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Operations
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [backingUp, setBackingUp] = useState(false);

    // Form using TanStack Form
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

    // Fetch config and skills
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
                // Update form with fetched values
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

    const handleToggleSkill = useCallback(async (name: string, enable: boolean) => {
        try {
            const res = await fetch(
                `/api/skills/${encodeURIComponent(name)}/${enable ? "enable" : "disable"}`,
                { method: "POST" }
            );

            if (res.ok) {
                setSkills((prev) =>
                    prev.map((s) => (s.name === name ? { ...s, enabled: enable } : s))
                );
            }
        } catch (error_) {
            console.error("Failed to toggle skill:", error_);
        }
    }, []);

    async function handleRestart() {
        setRestarting(true);
        setError(null);

        try {
            const res = await fetch("/api/operations/restart", { method: "POST" });
            if (res.ok) {
                setShowRestartModal(false);
                setSuccess("Gateway restart initiated");
                setTimeout(() => setSuccess(null), 5000);
            } else {
                const data = await res.json();
                setError(data.error || "Failed to restart gateway");
            }
        } catch (error_: unknown) {
            const errorMessage =
                error_ instanceof Error ? error_.message : "Failed to restart gateway";
            setError(errorMessage);
        } finally {
            setRestarting(false);
        }
    }

    async function handleBackup() {
        setBackingUp(true);
        setError(null);

        try {
            const res = await fetch("/api/operations/backup", { method: "POST" });
            if (res.ok) {
                const data = await res.json();
                setSuccess("Backup created: " + (data.path || "workspace-backup.tar.gz"));
                setTimeout(() => setSuccess(null), 5000);
            } else {
                const data = await res.json();
                setError(data.error || "Failed to create backup");
            }
        } catch (error_: unknown) {
            const errorMessage =
                error_ instanceof Error ? error_.message : "Failed to create backup";
            setError(errorMessage);
        } finally {
            setBackingUp(false);
        }
    }

    if (loading) {
        return (
            <div className="flex min-h-64 items-center justify-center p-6">
                <Loader2 className="h-8 w-8 animate-spin text-accent-400" />
            </div>
        );
    }

    return (
        <div className="p-6">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Settings</h1>
                <Button onClick={() => form.handleSubmit()} disabled={saving}>
                    {saving ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving...
                        </>
                    ) : (
                        <>
                            <Check size={16} className="mr-2" />
                            Save Changes
                        </>
                    )}
                </Button>
            </div>

            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500 bg-red-500/20 p-3 text-red-400">
                    <AlertCircle size={18} />
                    {error}
                </div>
            )}

            {success && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-500 bg-green-500/20 p-3 text-green-400">
                    <Check size={18} />
                    {success}
                </div>
            )}

            {/* Configuration Sections */}
            <div className="space-y-4">
                {/* Gateway */}
                <ExpandableCard title="Gateway" icon={Server}>
                    <div className="space-y-1">
                        <ReadOnlyField label="Port" value={config?.gateway?.port} />
                        <ReadOnlyField label="Mode" value={config?.gateway?.mode} />
                        <ReadOnlyField
                            label="Auth Type"
                            value={config?.gateway?.auth?.type}
                        />
                        <ReadOnlyField
                            label="Auth Enabled"
                            value={config?.gateway?.auth?.enabled ? "Yes" : "No"}
                        />
                    </div>
                </ExpandableCard>

                {/* Agents */}
                <ExpandableCard title="Agents" icon={Users}>
                    <div className="space-y-1">
                        <ReadOnlyField
                            label="Default Model"
                            value={config?.agents?.defaultModel}
                        />
                        {config?.agents?.fallbacks?.length ? (
                            <div className="py-2">
                                <span className="mb-1 block text-sm text-slate-400">
                                    Fallbacks
                                </span>
                                <div className="flex flex-wrap gap-1">
                                    {config.agents.fallbacks.map((m, i) => (
                                        <span
                                            key={i}
                                            className="rounded bg-primary-700 px-2 py-0.5 text-xs"
                                        >
                                            {m}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <ReadOnlyField label="Fallbacks" value="None" />
                        )}
                        <ReadOnlyField
                            label="Max Tokens"
                            value={config?.agents?.contextSettings?.maxTokens}
                        />
                        <ReadOnlyField
                            label="Temperature"
                            value={config?.agents?.contextSettings?.temperature}
                        />
                    </div>
                </ExpandableCard>

                {/* Channels */}
                <ExpandableCard title="Channels" icon={MessageSquare}>
                    <div className="space-y-3">
                        {config?.channels?.discord ? (
                            <div className="flex items-center justify-between border-b border-primary-700 py-2 last:border-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-primary-200">Discord</span>
                                    {config.channels.discord.botId && (
                                        <span className="font-mono text-xs text-primary-500">
                                            ({config.channels.discord.botId.slice(0, 8)}
                                            ...)
                                        </span>
                                    )}
                                </div>
                                <span
                                    className={
                                        config.channels.discord.enabled
                                            ? "text-green-400"
                                            : "text-red-400"
                                    }
                                >
                                    {config.channels.discord.enabled
                                        ? "Enabled"
                                        : "Disabled"}
                                </span>
                            </div>
                        ) : (
                            <ReadOnlyField label="Discord" value="Not configured" />
                        )}
                    </div>
                </ExpandableCard>

                {/* Session */}
                <ExpandableCard title="Session" icon={Clock} defaultExpanded>
                    <div className="space-y-1">
                        <ReadOnlyField
                            label="Reset Mode"
                            value={config?.session?.reset?.mode}
                        />
                        <form.Field name="idleMinutes">
                            {(field) => (
                                <div className="py-2">
                                    <Input
                                        label="Idle Timeout (minutes)"
                                        type="number"
                                        value={field.state.value?.toString() ?? ""}
                                        onChange={(e) =>
                                            field.handleChange(
                                                Number.parseInt(e.target.value) || 0
                                            )
                                        }
                                        onBlur={field.handleBlur}
                                        placeholder="30"
                                        className="text-sm"
                                    />
                                </div>
                            )}
                        </form.Field>
                    </div>
                </ExpandableCard>

                {/* Tools */}
                <ExpandableCard title="Tools" icon={Wrench}>
                    <div className="space-y-3">
                        <div className="flex items-center justify-between border-b border-primary-700 py-2">
                            <div>
                                <span className="text-primary-200">Web Search</span>
                                <span className="ml-2 text-xs text-primary-500">
                                    ({config?.tools?.webSearch?.provider || "default"})
                                </span>
                            </div>
                            <span
                                className={
                                    config?.tools?.webSearch?.enabled
                                        ? "text-green-400"
                                        : "text-red-400"
                                }
                            >
                                {config?.tools?.webSearch?.enabled
                                    ? "Enabled"
                                    : "Disabled"}
                            </span>
                        </div>
                        <div className="flex items-center justify-between py-2">
                            <div>
                                <span className="text-primary-200">Exec</span>
                                <span className="ml-2 text-xs text-primary-500">
                                    ({config?.tools?.exec?.mode || "default"})
                                </span>
                            </div>
                            <span
                                className={
                                    config?.tools?.exec?.enabled
                                        ? "text-green-400"
                                        : "text-red-400"
                                }
                            >
                                {config?.tools?.exec?.enabled ? "Enabled" : "Disabled"}
                            </span>
                        </div>
                    </div>
                </ExpandableCard>

                {/* Heartbeat */}
                <ExpandableCard title="Heartbeat" icon={Heart} defaultExpanded>
                    <div className="space-y-1">
                        <ReadOnlyField
                            label="Enabled"
                            value={config?.heartbeat?.enabled ? "Yes" : "No"}
                        />
                        <form.Field name="heartbeatEvery">
                            {(field) => (
                                <div className="py-2">
                                    <Input
                                        label="Interval (seconds)"
                                        type="number"
                                        value={field.state.value?.toString() ?? ""}
                                        onChange={(e) =>
                                            field.handleChange(
                                                Number.parseInt(e.target.value) || 0
                                            )
                                        }
                                        onBlur={field.handleBlur}
                                        placeholder="60"
                                        className="text-sm"
                                    />
                                </div>
                            )}
                        </form.Field>
                        <form.Field name="heartbeatTarget">
                            {(field) => (
                                <div className="py-2">
                                    <Input
                                        label="Target Channel"
                                        type="text"
                                        value={field.state.value ?? ""}
                                        onChange={(e) =>
                                            field.handleChange(e.target.value)
                                        }
                                        onBlur={field.handleBlur}
                                        placeholder="channel-id or name"
                                        className="text-sm"
                                    />
                                </div>
                            )}
                        </form.Field>
                    </div>
                </ExpandableCard>

                {/* Skills */}
                <ExpandableCard title="Installed Skills" icon={Shield} defaultExpanded>
                    {skills.length > 0 ? (
                        <div className="space-y-2">
                            {skills.map((skill) => (
                                <div
                                    key={skill.name}
                                    className="flex items-center justify-between border-b border-primary-700 py-2 last:border-0"
                                >
                                    <div className="flex flex-col">
                                        <span className="text-primary-200">
                                            {skill.name}
                                        </span>
                                        {skill.description && (
                                            <span className="text-xs text-primary-500">
                                                {skill.description}
                                            </span>
                                        )}
                                    </div>
                                    <Switch
                                        checked={skill.enabled}
                                        onChange={() =>
                                            handleToggleSkill(skill.name, !skill.enabled)
                                        }
                                    />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-primary-500">No skills installed</p>
                    )}
                </ExpandableCard>

                {/* Operations */}
                <Card variant="bordered" className="mt-6">
                    <CardTitle className="mb-4">Operations</CardTitle>
                    <p className="mb-4 text-sm text-primary-400">
                        Manage OpenClaw gateway and workspace operations.
                    </p>
                    <div className="flex gap-4">
                        <Button
                            variant="danger"
                            onClick={() => setShowRestartModal(true)}
                        >
                            <RefreshCw size={16} className="mr-2" />
                            Restart Gateway
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={handleBackup}
                            disabled={backingUp}
                        >
                            {backingUp ? (
                                <Loader2 size={16} className="mr-2 animate-spin" />
                            ) : (
                                <Download size={16} className="mr-2" />
                            )}
                            Backup Workspace
                        </Button>
                    </div>
                </Card>
            </div>

            {/* Restart Confirmation Modal */}
            <Modal
                isOpen={showRestartModal}
                onClose={() => setShowRestartModal(false)}
                title="Confirm Restart"
                size="sm"
            >
                <p className="mb-4 text-primary-300">
                    Are you sure you want to restart the Gateway? This will temporarily
                    disconnect all sessions.
                </p>
                <div className="flex justify-end gap-3">
                    <Button variant="ghost" onClick={() => setShowRestartModal(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="danger"
                        onClick={handleRestart}
                        disabled={restarting}
                    >
                        {restarting ? (
                            <>
                                <Loader2 size={16} className="mr-2 animate-spin" />
                                Restarting...
                            </>
                        ) : (
                            "Restart Gateway"
                        )}
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
