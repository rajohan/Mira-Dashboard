import type { AgentStatus } from "../../../types/session";
import { formatUptime } from "../../../utils/format";
import { Card, CardTitle } from "../../ui/Card";

interface AgentInfoCardProps {
    status: AgentStatus | null;
}

export function AgentInfoCard({ status }: AgentInfoCardProps) {
    return (
        <Card variant="bordered">
            <CardTitle className="mb-4">Agent Info</CardTitle>
            <div className="space-y-3">
                <div className="flex justify-between">
                    <span className="text-slate-400">Version</span>
                    <span className="font-mono">{status?.version ?? "Unknown"}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-slate-400">Model</span>
                    <span>{status?.model ?? "Unknown"}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-slate-400">Uptime</span>
                    <span>{status ? formatUptime(status.uptime) : "Unknown"}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-slate-400">Session Count</span>
                    <span>{status?.sessionCount ?? 0}</span>
                </div>
            </div>
        </Card>
    );
}
