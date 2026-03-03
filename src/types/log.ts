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

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";