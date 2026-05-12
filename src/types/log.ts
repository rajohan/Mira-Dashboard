export interface LogEntry {
    id: string;
    dedupeKey?: string;
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
