import { type LogEntry } from "../../../types/log";
import { formatLogTime, getLevelColor, getSubsystemColor } from "../../../utils/logUtils";

interface LogLineProps {
    log: LogEntry;
}

export function LogLine({ log }: LogLineProps) {
    return (
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1 px-2 py-1 hover:bg-primary-800/50 sm:flex-nowrap sm:px-4 sm:py-0.5">
            {log.ts && (
                <span className="flex-shrink-0 whitespace-nowrap text-primary-500">
                    {formatLogTime(log.ts)}
                </span>
            )}
            {log.level && (
                <span
                    className={`flex-shrink-0 rounded px-1 py-0.5 text-xs ${getLevelColor(log.level)}`}
                >
                    {log.level.toUpperCase()?.slice(0, 5) || log.level}
                </span>
            )}
            {log.subsystem && (
                <span
                    className={`flex-shrink-0 whitespace-nowrap ${getSubsystemColor(log.subsystem)}`}
                >
                    [{log.subsystem}]
                </span>
            )}
            <span className="min-w-full flex-1 whitespace-pre-wrap break-all text-primary-200 sm:min-w-0">
                {log.msg}
            </span>
        </div>
    );
}
