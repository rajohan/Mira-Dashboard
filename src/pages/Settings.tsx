import { useState, useEffect } from "react";
import { Card, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Switch } from "../components/ui/Switch";
import { Modal } from "../components/ui/Modal";
import { 
    Server, 
    Users, 
    MessageSquare, 
    Clock, 
    Wrench, 
    Heart,
    RefreshCw,
    Download,
    ChevronDown,
    ChevronRight,
    Shield,
    AlertCircle,
    Check,
    Loader2
} from "lucide-react";

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
        [key: string]: any;
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

// Expandable card component
function ExpandableCard({ 
    title, 
    icon: Icon, 
    children, 
    defaultExpanded = false 
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
                className="w-full flex items-center justify-between py-1"
            >
                <div className="flex items-center gap-2">
                    <Icon size={18} className="text-accent-400" />
                    <CardTitle>{title}</CardTitle>
                </div>
                {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            </button>
            {isExpanded && (
                <div className="mt-4 pt-4 border-t border-primary-700">
                    {children}
                </div>
            )}
        </Card>
    );
}

// Read-only field display
function ReadOnlyField({ label, value }: { label: string; value?: string | number | boolean }) {
    return (
        <div className="flex justify-between items-center py-2">
            <span className="text-slate-400 text-sm">{label}</span>
            <span className="text-primary-100 font-mono text-sm">
                {value === undefined || value === null ? "—" : String(value)}
            </span>
        </div>
    );
}

// Editable field
function EditableField({ 
    label, 
    value, 
    onChange, 
    type = "text",
    placeholder 
}: { 
    label: string; 
    value: string | number;
    onChange: (value: string) => void;
    type?: "text" | "number";
    placeholder?: string;
}) {
    return (
        <div className="py-2">
            <Input
                label={label}
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="text-sm"
            />
        </div>
    );
}

export function Settings() {
    const [config, setConfig] = useState<Config | null>(null);
    const [skills, setSkills] = useState<Skill[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    
    // Editable fields
    const [idleMinutes, setIdleMinutes] = useState<string>("30");
    const [heartbeatEvery, setHeartbeatEvery] = useState<string>("60");
    const [heartbeatTarget, setHeartbeatTarget] = useState<string>("");
    
    // Operations
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [backingUp, setBackingUp] = useState(false);
    
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
                setIdleMinutes(String(data?.session?.reset?.idleMinutes || "30"));
                setHeartbeatEvery(String(data?.heartbeat?.every || "60"));
                setHeartbeatTarget(data?.heartbeat?.target || "");
            }
        } catch (e) {
            console.error("Failed to fetch config:", e);
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
        } catch (e) {
            console.error("Failed to fetch skills:", e);
        }
    }
    
    async function handleSaveConfig() {
        setSaving(true);
        setError(null);
        setSuccess(null);
        
        try {
            const updates: Partial<Config> = {
                session: {
                    reset: {
                        idleMinutes: parseInt(idleMinutes) || 30
                    }
                },
                heartbeat: {
                    every: parseInt(heartbeatEvery) || 60,
                    target: heartbeatTarget
                }
            };
            
            const res = await fetch("/api/config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updates)
            });
            
            if (res.ok) {
                setSuccess("Configuration saved successfully");
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || "Failed to save configuration");
            }
        } catch (e: any) {
            setError(e.message || "Failed to save configuration");
        } finally {
            setSaving(false);
        }
    }
    
    async function handleToggleSkill(name: string, enable: boolean) {
        try {
            const res = await fetch(`/api/skills/${encodeURIComponent(name)}/${enable ? "enable" : "disable"}`, {
                method: "POST"
            });
            
            if (res.ok) {
                setSkills(skills.map(s => 
                    s.name === name ? { ...s, enabled: enable } : s
                ));
            }
        } catch (e) {
            console.error("Failed to toggle skill:", e);
        }
    }
    
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
        } catch (e: any) {
            setError(e.message || "Failed to restart gateway");
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
        } catch (e: any) {
            setError(e.message || "Failed to create backup");
        } finally {
            setBackingUp(false);
        }
    }
    
    if (loading) {
        return (
            <div className="p-6 flex items-center justify-center min-h-64">
                <Loader2 className="w-8 h-8 animate-spin text-accent-400" />
            </div>
        );
    }
    
    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">Settings</h1>
                <Button onClick={handleSaveConfig} disabled={saving}>
                    {saving ? (
                        <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
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
                <div className="bg-red-500/20 border border-red-500 text-red-400 p-3 rounded-lg mb-4 flex items-center gap-2">
                    <AlertCircle size={18} />
                    {error}
                </div>
            )}
            
            {success && (
                <div className="bg-green-500/20 border border-green-500 text-green-400 p-3 rounded-lg mb-4 flex items-center gap-2">
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
                        <ReadOnlyField label="Auth Type" value={config?.gateway?.auth?.type} />
                        <ReadOnlyField label="Auth Enabled" value={config?.gateway?.auth?.enabled ? "Yes" : "No"} />
                    </div>
                </ExpandableCard>
                
                {/* Agents */}
                <ExpandableCard title="Agents" icon={Users}>
                    <div className="space-y-1">
                        <ReadOnlyField label="Default Model" value={config?.agents?.defaultModel} />
                        {config?.agents?.fallbacks?.length ? (
                            <div className="py-2">
                                <span className="text-slate-400 text-sm block mb-1">Fallbacks</span>
                                <div className="flex flex-wrap gap-1">
                                    {config.agents.fallbacks.map((m, i) => (
                                        <span key={i} className="px-2 py-0.5 bg-primary-700 rounded text-xs">
                                            {m}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <ReadOnlyField label="Fallbacks" value="None" />
                        )}
                        <ReadOnlyField label="Max Tokens" value={config?.agents?.contextSettings?.maxTokens} />
                        <ReadOnlyField label="Temperature" value={config?.agents?.contextSettings?.temperature} />
                    </div>
                </ExpandableCard>
                
                {/* Channels */}
                <ExpandableCard title="Channels" icon={MessageSquare}>
                    <div className="space-y-3">
                        {config?.channels?.discord ? (
                            <div className="flex justify-between items-center py-2 border-b border-primary-700 last:border-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-primary-200">Discord</span>
                                    {config.channels.discord.botId && (
                                        <span className="text-xs text-primary-500 font-mono">
                                            ({config.channels.discord.botId.slice(0, 8)}...)
                                        </span>
                                    )}
                                </div>
                                <span className={config.channels.discord.enabled ? "text-green-400" : "text-red-400"}>
                                    {config.channels.discord.enabled ? "Enabled" : "Disabled"}
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
                        <ReadOnlyField label="Reset Mode" value={config?.session?.reset?.mode} />
                        <EditableField
                            label="Idle Timeout (minutes)"
                            type="number"
                            value={idleMinutes}
                            onChange={setIdleMinutes}
                            placeholder="30"
                        />
                    </div>
                </ExpandableCard>
                
                {/* Tools */}
                <ExpandableCard title="Tools" icon={Wrench}>
                    <div className="space-y-3">
                        <div className="flex justify-between items-center py-2 border-b border-primary-700">
                            <div>
                                <span className="text-primary-200">Web Search</span>
                                <span className="text-xs text-primary-500 ml-2">
                                    ({config?.tools?.webSearch?.provider || "default"})
                                </span>
                            </div>
                            <span className={config?.tools?.webSearch?.enabled ? "text-green-400" : "text-red-400"}>
                                {config?.tools?.webSearch?.enabled ? "Enabled" : "Disabled"}
                            </span>
                        </div>
                        <div className="flex justify-between items-center py-2">
                            <div>
                                <span className="text-primary-200">Exec</span>
                                <span className="text-xs text-primary-500 ml-2">
                                    ({config?.tools?.exec?.mode || "default"})
                                </span>
                            </div>
                            <span className={config?.tools?.exec?.enabled ? "text-green-400" : "text-red-400"}>
                                {config?.tools?.exec?.enabled ? "Enabled" : "Disabled"}
                            </span>
                        </div>
                    </div>
                </ExpandableCard>
                
                {/* Heartbeat */}
                <ExpandableCard title="Heartbeat" icon={Heart} defaultExpanded>
                    <div className="space-y-1">
                        <ReadOnlyField label="Enabled" value={config?.heartbeat?.enabled ? "Yes" : "No"} />
                        <EditableField
                            label="Interval (seconds)"
                            type="number"
                            value={heartbeatEvery}
                            onChange={setHeartbeatEvery}
                            placeholder="60"
                        />
                        <EditableField
                            label="Target Channel"
                            value={heartbeatTarget}
                            onChange={setHeartbeatTarget}
                            placeholder="channel-id or name"
                        />
                    </div>
                </ExpandableCard>
                
                {/* Skills */}
                <ExpandableCard title="Installed Skills" icon={Shield} defaultExpanded>
                    {skills.length > 0 ? (
                        <div className="space-y-2">
                            {skills.map((skill) => (
                                <div 
                                    key={skill.name} 
                                    className="flex justify-between items-center py-2 border-b border-primary-700 last:border-0"
                                >
                                    <div className="flex flex-col">
                                        <span className="text-primary-200">{skill.name}</span>
                                        {skill.description && (
                                            <span className="text-xs text-primary-500">{skill.description}</span>
                                        )}
                                    </div>
                                    <Switch
                                        checked={skill.enabled}
                                        onChange={() => handleToggleSkill(skill.name, !skill.enabled)}
                                    />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-primary-500 text-sm">No skills installed</p>
                    )}
                </ExpandableCard>
                
                {/* Operations */}
                <Card variant="bordered" className="mt-6">
                    <CardTitle className="mb-4">Operations</CardTitle>
                    <p className="text-primary-400 text-sm mb-4">
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
                <p className="text-primary-300 mb-4">
                    Are you sure you want to restart the Gateway? This will temporarily disconnect all sessions.
                </p>
                <div className="flex gap-3 justify-end">
                    <Button variant="ghost" onClick={() => setShowRestartModal(false)}>
                        Cancel
                    </Button>
                    <Button variant="danger" onClick={handleRestart} disabled={restarting}>
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
