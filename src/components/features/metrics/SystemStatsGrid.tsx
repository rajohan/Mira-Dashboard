import { Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";

import type { Metrics } from "../../../hooks/useMetrics";
import { formatSize, formatUptime } from "../../../utils/format";
import { Card } from "../../ui/Card";
import { ProgressBar } from "../../ui/ProgressBar";

interface SystemStatsGridProps {
    metrics: Metrics;
}

export function SystemStatsGrid({ metrics }: SystemStatsGridProps) {
    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
                <div className="flex items-center gap-3">
                    <Cpu className="h-8 w-8 text-blue-400" />
                    <div>
                        <p className="text-sm text-primary-400">CPU</p>
                        <p className="text-2xl font-bold text-primary-100">
                            {metrics.cpu.loadPercent}%
                        </p>
                    </div>
                </div>
                <ProgressBar percent={metrics.cpu.loadPercent} color="blue" />
                <p className="mt-2 text-xs text-primary-500">
                    {metrics.cpu.count}x {metrics.cpu.model?.split(" ")[0] || "Unknown"}
                </p>
            </Card>

            <Card className="p-4">
                <div className="flex items-center gap-3">
                    <MemoryStick className="h-8 w-8 text-green-400" />
                    <div>
                        <p className="text-sm text-primary-400">Memory</p>
                        <p className="text-2xl font-bold text-primary-100">
                            {metrics.memory.percent}%
                        </p>
                    </div>
                </div>
                <ProgressBar percent={metrics.memory.percent} color="green" />
                <p className="mt-2 text-xs text-primary-500">
                    {formatSize(metrics.memory.used)} / {formatSize(metrics.memory.total)}
                </p>
            </Card>

            <Card className="p-4">
                <div className="flex items-center gap-3">
                    <HardDrive className="h-8 w-8 text-orange-400" />
                    <div>
                        <p className="text-sm text-primary-400">Disk</p>
                        <p className="text-2xl font-bold text-primary-100">
                            {metrics.disk.percent}%
                        </p>
                    </div>
                </div>
                <ProgressBar percent={metrics.disk.percent} color="orange" />
                <p className="mt-2 text-xs text-primary-500">
                    {formatSize(metrics.disk.used)} / {formatSize(metrics.disk.total)}
                </p>
            </Card>

            <Card className="p-4">
                <div className="flex items-center gap-3">
                    <Clock className="h-8 w-8 text-purple-400" />
                    <div>
                        <p className="text-sm text-primary-400">Uptime</p>
                        <p className="text-xl font-bold text-primary-100">
                            {formatUptime(metrics.system.uptime)}
                        </p>
                    </div>
                </div>
                <p className="mt-2 text-xs text-primary-500">
                    {metrics.system.hostname} ({metrics.system.platform})
                </p>
            </Card>
        </div>
    );
}
