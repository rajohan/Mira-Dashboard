import { type LogEntry } from "../../../types/log";
import { formatLogTime, getLevelColor, getSubsystemColor } from "../../../utils/logUtils";

interface LogLineProps {
    log: LogEntry;
}

export function LogLine({ log }: LogLineProps) {
    return (
        <div className="flex items-start gap-2 px-4 py-0.5 hover:bg-slate-800/50">
            {log.ts && (
                <span className="flex-shrink-0 whitespace-nowrap text-slate-500">
                    {formatLogTime(log.ts)}
                </span>
            )}
            {log.level && (
                <span
                    className={`flex-shrink-0 rounded px-1 py-0.5 text-xs ${getLevelColor(log.level)}`}
                >
                    {log.level.toUpperCase().slice(0, 5)}
                </span>
            )}
            {log.subsystem && (
                <span
                    className={`flex-shrink-0 whitespace-nowrap ${getSubsystemColor(log.subsystem)}`}
                >
                    [{log.subsystem}]
                </span>
            )}
            <span className="flex-1 whitespace-pre-wrap break-all text-slate-200">
                {log.msg}
            </span>
        </div>
    );
}
