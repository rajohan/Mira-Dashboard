import { BarChart3, Coins } from "lucide-react";

import { formatTokenCount } from "../../../utils/format";
import { Card } from "../../ui/Card";
import { ProgressBar } from "../../ui/ProgressBar";

interface TokenUsageCardProps {
    totalTokens: number;
    byModel: Record<string, number>;
    byAgent: Array<{ label: string; model: string; tokens: number; type: string }>;
}

export function TokenUsageCard({ totalTokens, byModel, byAgent }: TokenUsageCardProps) {
    const sortedModels = Object.entries(byModel).sort((a, b) => b[1] - a[1]);

    return (
        <Card className="p-6">
            <div className="mb-6 flex items-center gap-3">
                <Coins className="h-6 w-6 text-yellow-400" />
                <h2 className="text-lg font-semibold text-slate-100">Token Usage</h2>
                <span className="ml-auto text-2xl font-bold text-slate-100">
                    {formatTokenCount(totalTokens)}
                </span>
            </div>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
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
                                        <span className="text-slate-300">{model}</span>
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

                <div>
                    <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-400">
                        <BarChart3 className="h-4 w-4" /> By Agent
                    </h3>
                    <div className="max-h-64 space-y-2 overflow-y-auto">
                        {byAgent.map((agent, i) => {
                            const percent =
                                totalTokens > 0 ? (agent.tokens / totalTokens) * 100 : 0;
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
    );
}
