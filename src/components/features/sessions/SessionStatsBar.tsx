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
        <div className="border-primary-700 bg-primary-800/30 grid flex-shrink-0 grid-cols-1 gap-3 border-b py-3 sm:grid-cols-3 sm:gap-0 sm:py-4">
            <div className="flex min-w-0 items-center gap-3">
                <div className="bg-primary-700/50 rounded-lg p-2">
                    <Cpu className="text-primary-400 h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <span className="text-primary-400 block text-xs">Model</span>
                    <p className="text-primary-200 truncate text-sm font-medium sm:max-w-[150px]">
                        {model}
                    </p>
                </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 sm:justify-center">
                <div className="bg-primary-700/50 rounded-lg p-2">
                    <Hash className="text-primary-400 h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <span className="text-primary-400 block text-xs">Tokens</span>
                    <div className="flex min-w-0 items-center gap-2">
                        <p className="text-primary-200 shrink-0 text-sm font-medium">
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
                <div className="bg-primary-700/50 rounded-lg p-2">
                    <Clock className="text-primary-400 h-4 w-4" />
                </div>
                <div>
                    <span className="text-primary-400 block text-xs">Last Active</span>
                    <p className="text-primary-200 text-sm font-medium">
                        {formatDuration(updatedAt)}
                    </p>
                </div>
            </div>
        </div>
    );
}
