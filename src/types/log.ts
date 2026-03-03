export interface LogEntry {
    ts?: string;
    level?: string;
    subsystem?: string;
    msg: string;
    raw: string;
}

export interface LogFile {
    name: string;
    size: number;
    modified: string;
}

export const LINE_OPTIONS = [100, 500, 1000, 2000, 5000];

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export function getLogLevelColor(level: string): string {
    switch (level.toLowerCase()) {
        case "trace":
        case "debug": {
            return "text-slate-400";
        }
        case "info": {
            return "text-blue-400";
        }
        case "warn":
        case "warning": {
            return "text-yellow-400";
        }
        case "error": {
            return "text-orange-400";
        }
        case "fatal": {
            return "text-red-400";
        }
        default: {
            return "text-slate-300";
        }
    }
}