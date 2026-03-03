import { Clock, Cpu, Hash } from "lucide-react";

import { formatDuration, formatTokens, getTokenPercent } from "../../../utils/format";
import { ProgressBar } from "../../ui/ProgressBar";

interface SessionStatsBarProps {
    model: string;
    tokenCount: number;
    maxTokens: number;
    updatedAt: number | null;
}

export function SessionStatsBar({
    model,
    tokenCount,
    maxTokens,
    updatedAt,
}: SessionStatsBarProps) {
    const tokenPercent = getTokenPercent(tokenCount, maxTokens);

    return (
        <div className="grid flex-shrink-0 grid-cols-3 border-b border-slate-700 bg-slate-800/30 py-4">
            <div className="flex items-center gap-3">
                <div className="rounded-lg bg-slate-700/50 p-2">
                    <Cpu className="h-4 w-4 text-slate-400" />
                </div>
                <div>
                    <span className="block text-xs text-slate-400">Model</span>
                    <p className="max-w-[150px] truncate text-sm font-medium text-slate-200">
                        {model}
                    </p>
                </div>
            </div>
            <div className="flex items-center justify-center gap-3">
                <div className="rounded-lg bg-slate-700/50 p-2">
                    <Hash className="h-4 w-4 text-slate-400" />
                </div>
                <div className="min-w-0 flex-1">
                    <span className="block text-xs text-slate-400">Tokens</span>
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-200">
                            {formatTokens(tokenCount, maxTokens)}
                        </p>
                        <ProgressBar
                            percent={tokenPercent}
                            size="sm"
                            className="max-w-[100px] flex-1"
                        />
                    </div>
                </div>
            </div>
            <div className="flex items-center justify-end gap-3">
                <div className="rounded-lg bg-slate-700/50 p-2">
                    <Clock className="h-4 w-4 text-slate-400" />
                </div>
                <div>
                    <span className="block text-xs text-slate-400">Last Active</span>
                    <p className="text-sm font-medium text-slate-200">
                        {formatDuration(updatedAt)}
                    </p>
                </div>
            </div>
        </div>
    );
}
