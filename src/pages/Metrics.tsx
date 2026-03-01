import { useEffect, useState } from "react";
import { Card } from "../components/ui/Card";
import { Cpu, HardDrive, MemoryStick, Clock, Coins, BarChart3, Users } from "lucide-react";

interface AgentToken {
    type: string;
    label: string;
    model: string;
    tokens: number;
}

interface MetricsData {
    cpu: { loadPercent: number; count: number; model: string };
    memory: { total: number; used: number; free: number; percent: number };
    disk: { total: number; used: number; percent: number };
    system: { uptime: number; platform: string; hostname: string };
    tokens?: { total: number; byModel: Record<string, number>; sessionsByModel: Record<string, number>; byAgent: AgentToken[] };
}

export function Metrics() {
    const [metrics, setMetrics] = useState<MetricsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchMetrics = async () => {
            try {
                const res = await fetch("/api/metrics");
                if (!res.ok) throw new Error("Failed to fetch metrics");
                const data = await res.json();
                setMetrics(data);
                setError(null);
            } catch (e) {
                setError(e instanceof Error ? e.message : "Unknown error");
            } finally {
                setLoading(false);
            }
        };

        fetchMetrics();
        const interval = setInterval(fetchMetrics, 5000);
        return () => clearInterval(interval);
    }, []);

    const formatBytes = (bytes: number) => {
        const gb = bytes / (1024 * 1024 * 1024);
        return gb.toFixed(1) + " GB";
    };

    const formatUptime = (seconds: number) => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        return days + "d " + hours + "h " + mins + "m";
    };

    const formatTokens = (tokens: number) => {
        if (tokens >= 1000000) return (tokens / 1000000).toFixed(2) + "M";
        if (tokens >= 1000) return (tokens / 1000).toFixed(1) + "K";
        return tokens.toString();
    };

    if (loading) {
        return <div className="p-6"><h1 className="text-2xl font-bold text-slate-100">Metrics</h1><p className="text-slate-400 mt-4">Loading...</p></div>;
    }

    if (error) {
        return <div className="p-6"><h1 className="text-2xl font-bold text-slate-100">Metrics</h1><p className="text-red-400 mt-4">Error: {error}</p></div>;
    }

    const totalTokens = metrics?.tokens?.total || 0;
    const byModel = metrics?.tokens?.byModel || {};
    const sessionsByModel = metrics?.tokens?.sessionsByModel || {};
    const byAgent = metrics?.tokens?.byAgent || [];
    const sortedModels = Object.entries(byModel).sort((a, b) => b[1] - a[1]);

    return (
        <div className="p-6 space-y-6">
            <h1 className="text-2xl font-bold text-slate-100">Metrics</h1>

            {/* System Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <Cpu className="w-8 h-8 text-blue-400" />
                        <div>
                            <p className="text-sm text-slate-400">CPU</p>
                            <p className="text-2xl font-bold text-slate-100">{metrics?.cpu.loadPercent || 0}%</p>
                        </div>
                    </div>
                    <div className="mt-3 h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 transition-all" style={{ width: (metrics?.cpu.loadPercent || 0) + "%" }} />
                    </div>
                    <p className="text-xs text-slate-500 mt-2">{metrics?.cpu.count}x {metrics?.cpu.model?.split(" ")[0] || "Unknown"}</p>
                </Card>

                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <MemoryStick className="w-8 h-8 text-green-400" />
                        <div>
                            <p className="text-sm text-slate-400">Memory</p>
                            <p className="text-2xl font-bold text-slate-100">{metrics?.memory.percent || 0}%</p>
                        </div>
                    </div>
                    <div className="mt-3 h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 transition-all" style={{ width: (metrics?.memory.percent || 0) + "%" }} />
                    </div>
                    <p className="text-xs text-slate-500 mt-2">{formatBytes(metrics?.memory.used || 0)} / {formatBytes(metrics?.memory.total || 0)}</p>
                </Card>

                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <HardDrive className="w-8 h-8 text-orange-400" />
                        <div>
                            <p className="text-sm text-slate-400">Disk</p>
                            <p className="text-2xl font-bold text-slate-100">{metrics?.disk.percent || 0}%</p>
                        </div>
                    </div>
                    <div className="mt-3 h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-orange-500 transition-all" style={{ width: (metrics?.disk.percent || 0) + "%" }} />
                    </div>
                    <p className="text-xs text-slate-500 mt-2">{formatBytes(metrics?.disk.used || 0)} / {formatBytes(metrics?.disk.total || 0)}</p>
                </Card>

                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <Clock className="w-8 h-8 text-purple-400" />
                        <div>
                            <p className="text-sm text-slate-400">Uptime</p>
                            <p className="text-xl font-bold text-slate-100">{formatUptime(metrics?.system?.uptime || 0)}</p>
                        </div>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">{metrics?.system?.hostname} ({metrics?.system?.platform})</p>
                </Card>
            </div>

            {/* Token Usage */}
            {totalTokens > 0 && (
                <Card className="p-6">
                    <div className="flex items-center gap-3 mb-6">
                        <Coins className="w-6 h-6 text-yellow-400" />
                        <h2 className="text-lg font-semibold text-slate-100">Token Usage</h2>
                        <span className="ml-auto text-2xl font-bold text-slate-100">{formatTokens(totalTokens)}</span>
                    </div>
                    
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Tokens by Model */}
                        <div>
                            <h3 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
                                <BarChart3 className="w-4 h-4" /> By Model
                            </h3>
                            <div className="space-y-3">
                                {sortedModels.map(([model, count]) => {
                                    const percent = totalTokens > 0 ? (count / totalTokens) * 100 : 0;
                                    return (
                                        <div key={model}>
                                            <div className="flex justify-between text-sm mb-1">
                                                <span className="text-slate-300">{model}</span>
                                                <span className="text-slate-400">{formatTokens(count)}</span>
                                            </div>
                                            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                                                <div className="h-full bg-blue-500 rounded-full" style={{ width: percent + "%" }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Tokens by Agent */}
                        <div>
                            <h3 className="text-sm font-medium text-slate-400 mb-4 flex items-center gap-2">
                                <BarChart3 className="w-4 h-4" /> By Agent
                            </h3>
                            <div className="space-y-2 max-h-64 overflow-y-auto">
                                {byAgent.map((agent, i) => {
                                    const percent = totalTokens > 0 ? (agent.tokens / totalTokens) * 100 : 0;
                                    return (
                                        <div key={i} className="flex items-center gap-3">
                                            <span className="w-16 text-xs text-slate-500">{agent.type}</span>
                                            <span className="flex-1 text-sm text-slate-300 truncate" title={agent.label}>{agent.label}</span>
                                            <span className="w-16 text-right text-sm text-slate-400">{formatTokens(agent.tokens)}</span>
                                            <div className="w-20 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                <div className="h-full bg-purple-500 rounded-full" style={{ width: percent + "%" }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </Card>
            )}

            {/* Sessions by Model */}
            {Object.keys(sessionsByModel).length > 0 && (
                <Card className="p-6">
                    <div className="flex items-center gap-3 mb-4">
                        <Users className="w-6 h-6 text-cyan-400" />
                        <h2 className="text-lg font-semibold text-slate-100">Sessions by Model</h2>
                    </div>
                    
                    <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {Object.entries(sessionsByModel).sort((a, b) => b[1] - a[1]).map(([model, count]) => (
                            <div key={model} className="p-3 bg-slate-800/50 rounded-lg text-center">
                                <p className="text-2xl font-bold text-slate-100">{count}</p>
                                <p className="text-xs text-slate-400 truncate mt-1" title={model}>{model}</p>
                            </div>
                        ))}
                    </div>
                </Card>
            )}
        </div>
    );
}
