import { Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useEffect, useRef } from "react";

import {
    ActiveSessionsCard,
    AgentInfoCard,
    StatusCards,
} from "../components/features/dashboard";
import { getTypeSortOrder } from "../components/features/sessions";
import { Alert } from "../components/ui/Alert";
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { MetricCard } from "../components/ui/MetricCard";
import { PageHeader } from "../components/ui/PageHeader";
import { useMetrics } from "../hooks/useMetrics";
import { type Session, useOpenClaw } from "../hooks/useOpenClaw";
import { useAuthStore } from "../stores/authStore";
import { formatLoad, formatUptime } from "../utils/format";

function sortSessions(sessions: Session[]): Session[] {
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
            <PageHeader
                title="Dashboard"
                status={<ConnectionStatus isConnected={isConnected} />}
            />

            {error && <Alert variant="error">{error}</Alert>}

            <StatusCards
                isConnected={isConnected}
                sessions={sessions}
                status={status}
            />

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

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <AgentInfoCard status={status} />
                <ActiveSessionsCard sessions={sortedSessions} />
            </div>
        </div>
    );
}
