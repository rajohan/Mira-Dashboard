import {
    Activity,
    Clock,
    Coins,
    Cpu,
    HardDrive,
    MemoryStick,
    Users,
    Wifi,
    WifiOff,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { Alert } from "../components/ui/Alert";
import { Badge, getSessionTypeVariant } from "../components/ui/Badge";
import { Card, CardTitle } from "../components/ui/Card";
import { MetricCard } from "../components/ui/MetricCard";
import { ProgressBar } from "../components/ui/ProgressBar";
import { useMetrics } from "../hooks/useMetrics";
import { useOpenClaw } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";
import {
    formatUptime,
    formatLoad,
    formatTokens,
    getTokenPercent,
} from "../utils/format";
import { formatSessionType, getTypeSortOrder } from "../components/features/sessions";

function sortSessions(sessions: any[]): any[] {
    return [...sessions].sort((a, b) => {
        const typeOrder = getTypeSortOrder(a.type) - getTypeSortOrder(b.type);
        if (typeOrder !== 0) return typeOrder;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

export function Dashboard() {
    const { token } = useAuthStore();
    const { isConnected, error, connect, status, sessions } = useOpenClaw(token);
    const { data: metrics } = useMetrics();
    const hasConnected = useRef(false);

    useEffect(() => {
        if (token && !hasConnected.current) {
            hasConnected.current = true;
            connect();
        }
    }, [token, connect]);

    const sortedSessions = sessions ? sortSessions(sessions) : [];

    return (
        <div className="p-6">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Dashboard</h1>
                <div className="flex items-center gap-2">
                    {isConnected ? (
                        <span className="flex items-center gap-1 text-sm text-green-400">
                            <Wifi size={16} /> Connected
                        </span>
                    ) : (
                        <span className="flex items-center gap-1 text-sm text-red-400">
                            <WifiOff size={16} /> Disconnected
                        </span>
                    )}
                </div>
            </div>

            {error && <Alert variant="error">{error}</Alert>}

            {/* Status cards */}
            <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <div className="flex items-center gap-3">
                        <div
                            className={
                                "rounded-lg p-2 " +
                                (isConnected ? "bg-green-500/20" : "bg-red-500/20")
                            }
                        >
                            <Activity
                                className={
                                    "h-5 w-5 " +
                                    (isConnected ? "text-green-400" : "text-red-400")
                                }
                            />
                        </div>
                        <div>
                            <div className="text-sm text-slate-400">Status</div>
                            <div
                                className={
                                    "text-lg font-semibold " +
                                    (isConnected ? "text-green-400" : "text-red-400")
                                }
                            >
                                {isConnected ? "Online" : "Offline"}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card>
                    <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-blue-500/20 p-2">
                            <Users className="h-5 w-5 text-blue-400" />
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
                        <div className="rounded-lg bg-purple-500/20 p-2">
                            <Cpu className="h-5 w-5 text-purple-400" />
                        </div>
                        <div>
                            <div className="text-sm text-slate-400">Model</div>
                            <div className="text-lg text-sm font-semibold">
                                {status?.model || "Unknown"}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card>
                    <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-orange-500/20 p-2">
                            <HardDrive className="h-5 w-5 text-orange-400" />
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
            <h2 className="mb-4 text-lg font-semibold">System Health</h2>
            <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                    title="CPU"
                    value={metrics ? metrics.cpu.loadPercent + "%" : "—"}
                    subtitle={metrics ? formatLoad(metrics.cpu.loadAvg) : "Loading..."}
                    percent={metrics?.cpu.loadPercent}
                    icon={<Cpu className="h-5 w-5" />}
                />
                <MetricCard
                    title="Memory"
                    value={metrics ? metrics.memory.usedGB + " GB" : "—"}
                    subtitle={
                        metrics ? "of " + metrics.memory.totalGB + " GB" : "Loading..."
                    }
                    percent={metrics?.memory.percent}
                    icon={<MemoryStick className="h-5 w-5" />}
                />
                <MetricCard
                    title="Disk"
                    value={metrics ? metrics.disk.usedGB + " GB" : "—"}
                    subtitle={
                        metrics ? "of " + metrics.disk.totalGB + " GB" : "Loading..."
                    }
                    percent={metrics?.disk.percent}
                    icon={<HardDrive className="h-5 w-5" />}
                />
                <MetricCard
                    title="Uptime"
                    value={metrics ? formatUptime(metrics.system.uptime) : "—"}
                    subtitle={metrics ? metrics.system.hostname : "Loading..."}
                    color="green"
                    icon={<Clock className="h-5 w-5" />}
                />
            </div>

            {/* Agent info */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
                    {sortedSessions.length > 0 ? (
                        <div className="max-h-64 space-y-2 overflow-y-auto pr-2">
                            {sortedSessions.map((session: any) => {
                                const tokenPercent = getTokenPercent(
                                    session.tokenCount || 0,
                                    session.maxTokens || 200_000
                                );
                                return (
                                    <div
                                        key={session.id}
                                        className="flex items-center justify-between border-b border-slate-700/50 py-2 text-sm last:border-0"
                                    >
                                        <div className="flex min-w-0 flex-1 items-center gap-2">
                                            <Badge variant={getSessionTypeVariant(session.type)}>
                                                {formatSessionType(session)}
                                            </Badge>
                                            <span
                                                className="truncate text-slate-300"
                                                title={
                                                    session.displayLabel ||
                                                    session.label ||
                                                    session.displayName ||
                                                    session.id
                                                }
                                            >
                                                {session.displayLabel ||
                                                    session.label ||
                                                    session.displayName ||
                                                    session.id.slice(0, 12)}
                                            </span>
                                        </div>
                                        <div className="ml-2 flex flex-shrink-0 items-center gap-2">
                                            <Coins className="h-3 w-3 text-slate-400" />
                                            <span className="text-xs text-slate-400">
                                                {formatTokens(
                                                    session.tokenCount || 0,
                                                    session.maxTokens || 200_000
                                                )}
                                            </span>
                                            <ProgressBar percent={tokenPercent} size="sm" className="w-12" />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-slate-400">No active sessions</p>
                    )}
                </Card>
            </div>
        </div>
    );
}
