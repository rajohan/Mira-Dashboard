import { Activity, Cpu, HardDrive, Users } from "lucide-react";

import type { AgentStatus, Session } from "../../../hooks/useOpenClaw";
import { Card } from "../../ui/Card";

interface StatusCardsProps {
    isConnected: boolean;
    sessions: Session[];
    status: AgentStatus | null;
}

export function StatusCards({ isConnected, sessions, status }: StatusCardsProps) {
    return (
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
                        <div className="text-sm font-semibold">
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
    );
}
