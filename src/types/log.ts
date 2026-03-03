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

export const LINE_OPTIONS = [100, 500, 1000, 2000, 5000] as const;

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = typeof LOG_LEVELS[number];