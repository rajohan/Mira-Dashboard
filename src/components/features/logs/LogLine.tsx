import { type LogEntry } from "../../../types/log";
import {
    formatLogTime,
    getLevelColor,
    getSubsystemColor,
} from "../../../utils/logUtilities";

/** Provides props for log line. */
interface LogLineProperties {
    log: LogEntry;
}

/** Renders the log line UI. */
export function LogLine({ log }: LogLineProperties) {
    const level = typeof log.level === "string" ? log.level : "";
    const subsystem = typeof log.subsystem === "string" ? log.subsystem : "";
    const message = typeof log.msg === "string" ? log.msg : String(log.raw ?? "");

    return (
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1 px-2 py-1 hover:bg-primary-800/50 sm:flex-nowrap sm:px-4 sm:py-0.5">
            {log.ts && (
                <span className="shrink-0 whitespace-nowrap text-primary-500">
                    {formatLogTime(log.ts)}
                </span>
            )}
            {level && (
                <span
                    className={`shrink-0 rounded px-1 py-0.5 text-xs ${getLevelColor(level)}`}
                >
                    {level.toUpperCase().slice(0, 5)}
                </span>
            )}
            {subsystem && (
                <span
                    className={`shrink-0 whitespace-nowrap ${getSubsystemColor(subsystem)}`}
                >
                    [{subsystem}]
                </span>
            )}
            <span className="min-w-full flex-1 break-all whitespace-pre-wrap text-primary-200 sm:min-w-0">
                {message}
            </span>
        </div>
    );
}
