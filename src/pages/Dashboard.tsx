import { useEffect, useRef } from "react";
import { useOpenClaw } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";
import { useMetrics } from "../hooks/useMetrics";
import { Card, CardTitle } from "../components/ui/Card";
import { MetricCard } from "../components/ui/MetricCard";
import { Activity, Cpu, HardDrive, MemoryStick, Users, Wifi, WifiOff, Clock } from "lucide-react";

function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + mins + "m";
    return mins + "m";
}

function formatLoad(load: number[]): string {
    return load.map(l => l.toFixed(2)).join(", ");
}

export function Dashboard() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, status, sessions } = useOpenClaw(token);
    const { data: metrics } = useMetrics();
    const hasConnected = useRef(false);

    useEffect(() => {
        // Only connect once when token is available
        if (token && !hasConnected.current) {
            hasConnected.current = true;
            connect();
        }
    }, [token, connect]);

    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">Dashboard</h1>
                <div className="flex items-center gap-2">
                    {isConnected ? (
                        <span className="flex items-center gap-1 text-green-400 text-sm">
                            <Wifi size={16} /> Connected
                        </span>
                    ) : (
                        <span className="flex items-center gap-1 text-red-400 text-sm">
                            <WifiOff size={16} /> Disconnected
                        </span>
                    )}
                </div>
            </div>

            {error && (
                <div className="bg-red-500/20 border border-red-500 text-red-400 p-3 rounded-lg mb-4">
                    {error}
                </div>
            )}

            {/* Status cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <Card>
                    <div className="flex items-center gap-3">
                        <div className={"p-2 rounded-lg " + (isConnected ? "bg-green-500/20" : "bg-red-500/20")}>
                            <Activity className={"w-5 h-5 " + (isConnected ? "text-green-400" : "text-red-400")} />
                        </div>
                        <div>
                            <div className="text-sm text-slate-400">Status</div>
                            <div className={"text-lg font-semibold " + (isConnected ? "text-green-400" : "text-red-400")}>
                                {isConnected ? "Online" : "Offline"}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-500/20 rounded-lg">
                            <Users className="w-5 h-5 text-blue-400" />
                        </div>
                        <div>
                            <div className="text-sm text-slate-400">Sessions</div>
                            <div className="text-lg font-semibold">
                                {sessions?.length ?? 0}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-500/20 rounded-lg">
                            <Cpu className="w-5 h-5 text-purple-400" />
                        </div>
                        <div>
                            <div className="text-sm text-slate-400">Model</div>
                            <div className="text-lg font-semibold text-sm">
                                {status?.model || "Unknown"}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-orange-500/20 rounded-lg">
                            <HardDrive className="w-5 h-5 text-orange-400" />
                        </div>
                        <div>
                            <div className="text-sm text-slate-400">Tokens</div>
                            <div className="text-lg font-semibold">
                                {status?.tokenUsage?.total?.toLocaleString() ?? 0}
                            </div>
                        </div>
                    </div>
                </Card>
            </div>

            {/* System Metrics */}
            <h2 className="text-lg font-semibold mb-4">System Health</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <MetricCard
                    title="CPU"
                    value={metrics ? metrics.cpu.loadPercent + "%" : "—"}
                    subtitle={metrics ? formatLoad(metrics.cpu.loadAvg) : "Loading..."}
                    percent={metrics?.cpu.loadPercent}
                    icon={<Cpu className="w-5 h-5" />}
                />
                <MetricCard
                    title="Memory"
                    value={metrics ? metrics.memory.usedGB + " GB" : "—"}
                    subtitle={metrics ? "of " + metrics.memory.totalGB + " GB" : "Loading..."}
                    percent={metrics?.memory.percent}
                    icon={<MemoryStick className="w-5 h-5" />}
                />
                <MetricCard
                    title="Disk"
                    value={metrics ? metrics.disk.usedGB + " GB" : "—"}
                    subtitle={metrics ? "of " + metrics.disk.totalGB + " GB" : "Loading..."}
                    percent={metrics?.disk.percent}
                    icon={<HardDrive className="w-5 h-5" />}
                />
                <MetricCard
                    title="Uptime"
                    value={metrics ? formatUptime(metrics.system.uptime) : "—"}
                    subtitle={metrics ? metrics.system.hostname : "Loading..."}
                    color="green"
                    icon={<Clock className="w-5 h-5" />}
                />
            </div>

            {/* Agent info */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card variant="bordered">
                    <CardTitle className="mb-4">Agent Info</CardTitle>
                    <div className="space-y-3">
                        <div className="flex justify-between">
                            <span className="text-slate-400">Version</span>
                            <span className="font-mono">
                                {status?.version ?? "Unknown"}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-slate-400">Model</span>
                            <span>{status?.model ?? "Unknown"}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-slate-400">Uptime</span>
                            <span>
                                {status ? formatUptime(status.uptime) : "Unknown"}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-slate-400">Session Count</span>
                            <span>{status?.sessionCount ?? 0}</span>
                        </div>
                    </div>
                </Card>

                <Card variant="bordered">
                    <CardTitle className="mb-4">Active Sessions</CardTitle>
                    {sessions && sessions.length > 0 ? (
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                            {sessions.slice(0, 5).map((session: any) => (
                                <div
                                    key={session.id}
                                    className="flex justify-between text-sm"
                                >
                                    <span className="text-slate-300">
                                        {session.id?.slice(0, 12)}...
                                    </span>
                                    <span className="text-slate-400">
                                        {session.type || "unknown"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-slate-400">No active sessions</p>
                    )}
                </Card>
            </div>
        </div>
    );
}
