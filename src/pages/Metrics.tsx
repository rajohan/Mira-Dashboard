import {
    BarChart3,
    Clock,
    Coins,
    Cpu,
    HardDrive,
    MemoryStick,
    RefreshCw,
    Users,
} from "lucide-react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/LoadingState";
import { PageHeader } from "../components/ui/PageHeader";
import { ProgressBar } from "../components/ui/ProgressBar";
import { useMetrics } from "../hooks";
import { formatSize, formatTokenCount, formatUptime } from "../utils/format";

export function Metrics() {
    const { data: metrics, isLoading, error, refetch } = useMetrics();

    if (isLoading) {
        return <LoadingState size="lg" />;
    }

    if (error) {
        return (
            <div className="flex h-64 flex-col items-center justify-center gap-4 p-6">
                <p className="text-red-400">{error.message}</p>
                <Button variant="secondary" onClick={() => refetch()}>
                    <RefreshCw className="h-4 w-4" />
                    Retry
                </Button>
            </div>
        );
    }

    const totalTokens = metrics?.tokens?.total || 0;
    const byModel = metrics?.tokens?.byModel || {};
    const sessionsByModel = metrics?.tokens?.sessionsByModel || {};
    const byAgent = metrics?.tokens?.byAgent || [];
    const sortedModels = Object.entries(byModel).sort((a, b) => b[1] - a[1]);

    return (
        <div className="space-y-6 p-6">
            <PageHeader
                title="Metrics"
                actions={
                    <Button variant="secondary" size="sm" onClick={() => refetch()}>
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                }
            />

            {/* System Stats */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <Cpu className="h-8 w-8 text-blue-400" />
                        <div>
                            <p className="text-sm text-slate-400">CPU</p>
                            <p className="text-2xl font-bold text-slate-100">
                                {metrics?.cpu.loadPercent || 0}%
                            </p>
                        </div>
                    </div>
                    <ProgressBar percent={metrics?.cpu.loadPercent || 0} color="blue" />
                    <p className="mt-2 text-xs text-slate-500">
                        {metrics?.cpu.count}x{" "}
                        {metrics?.cpu.model?.split(" ")[0] || "Unknown"}
                    </p>
                </Card>

                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <MemoryStick className="h-8 w-8 text-green-400" />
                        <div>
                            <p className="text-sm text-slate-400">Memory</p>
                            <p className="text-2xl font-bold text-slate-100">
                                {metrics?.memory.percent || 0}%
                            </p>
                        </div>
                    </div>
                    <ProgressBar percent={metrics?.memory.percent || 0} color="green" />
                    <p className="mt-2 text-xs text-slate-500">
                        {formatSize(metrics?.memory.used || 0)} /{" "}
                        {formatSize(metrics?.memory.total || 0)}
                    </p>
                </Card>

                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <HardDrive className="h-8 w-8 text-orange-400" />
                        <div>
                            <p className="text-sm text-slate-400">Disk</p>
                            <p className="text-2xl font-bold text-slate-100">
                                {metrics?.disk.percent || 0}%
                            </p>
                        </div>
                    </div>
                    <ProgressBar percent={metrics?.disk.percent || 0} color="orange" />
                    <p className="mt-2 text-xs text-slate-500">
                        {formatSize(metrics?.disk.used || 0)} /{" "}
                        {formatSize(metrics?.disk.total || 0)}
                    </p>
                </Card>

                <Card className="p-4">
                    <div className="flex items-center gap-3">
                        <Clock className="h-8 w-8 text-purple-400" />
                        <div>
                            <p className="text-sm text-slate-400">Uptime</p>
                            <p className="text-xl font-bold text-slate-100">
                                {formatUptime(metrics?.system?.uptime || 0)}
                            </p>
                        </div>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                        {metrics?.system?.hostname} ({metrics?.system?.platform})
                    </p>
                </Card>
            </div>

            {/* Token Usage */}
            {totalTokens > 0 && (
                <Card className="p-6">
                    <div className="mb-6 flex items-center gap-3">
                        <Coins className="h-6 w-6 text-yellow-400" />
                        <h2 className="text-lg font-semibold text-slate-100">
                            Token Usage
                        </h2>
                        <span className="ml-auto text-2xl font-bold text-slate-100">
                            {formatTokenCount(totalTokens)}
                        </span>
                    </div>

                    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
                        {/* Tokens by Model */}
                        <div>
                            <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-400">
                                <BarChart3 className="h-4 w-4" /> By Model
                            </h3>
                            <div className="space-y-3">
                                {sortedModels.map(([model, count]) => {
                                    const percent =
                                        totalTokens > 0 ? (count / totalTokens) * 100 : 0;
                                    return (
                                        <div key={model}>
                                            <div className="mb-1 flex justify-between text-sm">
                                                <span className="text-slate-300">
                                                    {model}
                                                </span>
                                                <span className="text-slate-400">
                                                    {formatTokenCount(count)}
                                                </span>
                                            </div>
                                            <ProgressBar percent={percent} color="blue" />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Tokens by Agent */}
                        <div>
                            <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-400">
                                <BarChart3 className="h-4 w-4" /> By Agent
                            </h3>
                            <div className="max-h-64 space-y-2 overflow-y-auto">
                                {byAgent.map((agent, i) => {
                                    const percent =
                                        totalTokens > 0
                                            ? (agent.tokens / totalTokens) * 100
                                            : 0;
                                    return (
                                        <div key={i} className="flex items-center gap-3">
                                            <span className="w-16 text-xs text-slate-500">
                                                {agent.type}
                                            </span>
                                            <span
                                                className="flex-1 truncate text-sm text-slate-300"
                                                title={agent.label}
                                            >
                                                {agent.label}
                                            </span>
                                            <span className="w-16 text-right text-sm text-slate-400">
                                                {formatTokenCount(agent.tokens)}
                                            </span>
                                            <ProgressBar
                                                percent={percent}
                                                color="purple"
                                                size="sm"
                                                className="w-20"
                                            />
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
                    <div className="mb-4 flex items-center gap-3">
                        <Users className="h-6 w-6 text-cyan-400" />
                        <h2 className="text-lg font-semibold text-slate-100">
                            Sessions by Model
                        </h2>
                    </div>

                    <div className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-6">
                        {Object.entries(sessionsByModel)
                            .sort((a, b) => b[1] - a[1])
                            .map(([model, count]) => (
                                <div
                                    key={model}
                                    className="rounded-lg bg-slate-800/50 p-3 text-center"
                                >
                                    <p className="text-2xl font-bold text-slate-100">
                                        {count}
                                    </p>
                                    <p
                                        className="mt-1 truncate text-xs text-slate-400"
                                        title={model}
                                    >
                                        {model}
                                    </p>
                                </div>
                            ))}
                    </div>
                </Card>
            )}
        </div>
    );
}
