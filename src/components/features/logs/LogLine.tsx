import { type LogEntry } from "../../../types/log";
import { formatLogTime, getLevelColor, getSubsystemColor } from "../../../utils/logUtils";

/** Provides props for log line. */
interface LogLineProps {
    log: LogEntry;
}

/** Renders the log line UI. */
export function LogLine({ log }: LogLineProps) {
    const level = typeof log.level === "string" ? log.level : "";
    const subsystem = typeof log.subsystem === "string" ? log.subsystem : "";
    const message = typeof log.msg === "string" ? log.msg : String(log.raw ?? "");

    return (
        <div className="hover:bg-primary-800/50 flex flex-wrap items-start gap-x-2 gap-y-1 px-2 py-1 sm:flex-nowrap sm:px-4 sm:py-0.5">
            {log.ts && (
                <span className="text-primary-500 flex-shrink-0 whitespace-nowrap">
                    {formatLogTime(log.ts)}
                </span>
            )}
            {level && (
                <span
                    className={`flex-shrink-0 rounded px-1 py-0.5 text-xs ${getLevelColor(level)}`}
                >
                    {level.toUpperCase().slice(0, 5)}
                </span>
            )}
            {subsystem && (
                <span
                    className={`flex-shrink-0 whitespace-nowrap ${getSubsystemColor(subsystem)}`}
                >
                    [{subsystem}]
                </span>
            )}
            <span className="text-primary-200 min-w-full flex-1 break-all whitespace-pre-wrap sm:min-w-0">
                {message}
            </span>
        </div>
    );
}
