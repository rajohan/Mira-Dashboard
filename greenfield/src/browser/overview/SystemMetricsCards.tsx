import { ArrowDown, ArrowUp, Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";

import type { SystemMetrics } from "../../contracts/system.ts";
import {
    formatBitsPerSecond,
    formatByteCount,
    formatLoadValue,
    formatPercent,
    formatUptime,
} from "../lib/formatMeasurements.ts";
import { MetricCard } from "../ui/MetricCard.tsx";

function capacityDescription(capacity: SystemMetrics["memory"]): string {
    return `${formatByteCount(capacity.usedBytes)} / ${formatByteCount(
        capacity.totalBytes
    )} · ${formatByteCount(capacity.freeBytes)} free`;
}

function networkValue(
    state: SystemMetrics["network"]["state"],
    bitsPerSecond: number
): string {
    return state === "warming" ? "Measuring…" : formatBitsPerSecond(bitsPerSecond);
}

interface SystemMetricsCardsProps {
    readonly metrics: SystemMetrics;
}

/** @returns Six identity-free operational metric cards. */
export function SystemMetricsCards({ metrics }: SystemMetricsCardsProps) {
    const coreLabel = metrics.cpu.logicalCoreCount === 1 ? "CPU core" : "CPU cores";
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <MetricCard
                description={`Average load over 1 minute: ${formatLoadValue(metrics.cpu.loadAverage[0])} · ${metrics.cpu.logicalCoreCount} ${coreLabel}`}
                icon={Cpu}
                meter={{
                    label: "CPU load",
                    maximum: 100,
                    value: metrics.cpu.loadPercent,
                }}
                title="CPU"
                value={formatPercent(metrics.cpu.loadPercent)}
            />
            <MetricCard
                description={capacityDescription(metrics.memory)}
                icon={MemoryStick}
                meter={{
                    label: "Memory used",
                    maximum: 100,
                    value: metrics.memory.usedPercent,
                }}
                title="Memory"
                value={formatPercent(metrics.memory.usedPercent)}
            />
            <MetricCard
                description={capacityDescription(metrics.disk)}
                icon={HardDrive}
                meter={{
                    label: "Disk used",
                    maximum: 100,
                    value: metrics.disk.usedPercent,
                }}
                title="Disk"
                value={formatPercent(metrics.disk.usedPercent)}
            />
            <MetricCard
                description="Host uptime"
                icon={Clock}
                title="Uptime"
                value={formatUptime(metrics.uptimeSeconds)}
            />
            <MetricCard
                description="Current total download speed"
                icon={ArrowDown}
                title="Download"
                value={networkValue(
                    metrics.network.state,
                    metrics.network.downloadBitsPerSecond
                )}
            />
            <MetricCard
                description="Current total upload speed"
                icon={ArrowUp}
                title="Upload"
                value={networkValue(
                    metrics.network.state,
                    metrics.network.uploadBitsPerSecond
                )}
            />
        </div>
    );
}
