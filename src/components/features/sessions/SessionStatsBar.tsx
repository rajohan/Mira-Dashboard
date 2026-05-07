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
        <div className="grid flex-shrink-0 grid-cols-1 gap-3 border-b border-primary-700 bg-primary-800/30 py-3 sm:grid-cols-3 sm:gap-0 sm:py-4">
            <div className="flex min-w-0 items-center gap-3">
                <div className="rounded-lg bg-primary-700/50 p-2">
                    <Cpu className="h-4 w-4 text-primary-400" />
                </div>
                <div className="min-w-0">
                    <span className="block text-xs text-primary-400">Model</span>
                    <p className="truncate text-sm font-medium text-primary-200 sm:max-w-[150px]">
                        {model}
                    </p>
                </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 sm:justify-center">
                <div className="rounded-lg bg-primary-700/50 p-2">
                    <Hash className="h-4 w-4 text-primary-400" />
                </div>
                <div className="min-w-0 flex-1">
                    <span className="block text-xs text-primary-400">Tokens</span>
                    <div className="flex min-w-0 items-center gap-2">
                        <p className="shrink-0 text-sm font-medium text-primary-200">
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
            <div className="flex min-w-0 items-center gap-3 sm:justify-end">
                <div className="rounded-lg bg-primary-700/50 p-2">
                    <Clock className="h-4 w-4 text-primary-400" />
                </div>
                <div>
                    <span className="block text-xs text-primary-400">Last Active</span>
                    <p className="text-sm font-medium text-primary-200">
                        {formatDuration(updatedAt)}
                    </p>
                </div>
            </div>
        </div>
    );
}
