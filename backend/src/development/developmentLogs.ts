import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    openSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { formatOpenClawLogDate } from "../lib/logRoots.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";
import { ensurePrivateStateDirectory, isRealDirectory } from "./developmentState.ts";

const HOST_OPENCLAW_LOGS_ROOT = "/tmp/openclaw";
export const DEVELOPMENT_LOG_FIXTURE_INTERVAL_MS = 5000;
const MAX_DEVELOPMENT_LOG_BYTES = 2 * 1024 * 1024;

function developmentLogsRoot(config: DevelopmentStackConfig): string {
    return path.join(config.stateRoot, "logs");
}

export function developmentAppLogPath(config: DevelopmentStackConfig): string {
    return path.join(developmentLogsRoot(config), "dashboard.ndjson");
}

function syntheticDevelopmentOpenClawLogsRoot(config: DevelopmentStackConfig): string {
    return path.join(developmentLogsRoot(config), "openclaw");
}

export function developmentOpenClawLogsRoot(config: DevelopmentStackConfig): string {
    return config.openClawLogMode === "host-read-only"
        ? HOST_OPENCLAW_LOGS_ROOT
        : syntheticDevelopmentOpenClawLogsRoot(config);
}

export interface DevelopmentLogFixtureEntry {
    level: "DEBUG" | "ERROR" | "FATAL" | "INFO" | "TRACE" | "WARN";
    message: string;
}

export const DEVELOPMENT_LOG_FIXTURES = [
    {
        level: "TRACE",
        message: "[dashboard-dev] Synthetic trace entry for virtualized history testing.",
    },
    {
        level: "DEBUG",
        message: "[gateway] Synthetic debug entry: capability proxy poll completed.",
    },
    {
        level: "INFO",
        message:
            "[worker] Synthetic info entry: database.summary completed successfully.",
    },
    {
        level: "WARN",
        message:
            "[sandbox] Synthetic warning entry for level-filter testing; no incident.",
    },
    {
        level: "ERROR",
        message: "[logs] Synthetic error entry for search/export testing; no incident.",
    },
    {
        level: "FATAL",
        message:
            "[logs] Synthetic fatal entry for complete filter coverage; no incident.",
    },
] as const satisfies readonly DevelopmentLogFixtureEntry[];

function developmentLogPath(
    config: DevelopmentStackConfig,
    timestamp = new Date()
): string {
    return path.join(
        syntheticDevelopmentOpenClawLogsRoot(config),
        `openclaw-${formatOpenClawLogDate(timestamp)}.log`
    );
}

export function appendDevelopmentLogEntry(
    config: DevelopmentStackConfig,
    entry: DevelopmentLogFixtureEntry,
    timestamp = new Date()
): void {
    const logPath = developmentLogPath(config, timestamp);
    const line = `${JSON.stringify({
        0: entry.message,
        _meta: {
            date: timestamp.toISOString(),
            logLevelName: entry.level,
        },
    })}\n`;
    const descriptor = openSync(
        logPath,
        constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW,
        0o600
    );
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error("Development log must be a single-link regular file");
        }
        fchmodSync(descriptor, 0o600);
        if (
            stat.size >= MAX_DEVELOPMENT_LOG_BYTES ||
            stat.size + Buffer.byteLength(line, "utf8") > MAX_DEVELOPMENT_LOG_BYTES
        ) {
            return;
        }
        writeFileSync(descriptor, line, "utf8");
    } finally {
        closeSync(descriptor);
    }
}

function developmentLogFileSize(logPath: string): number | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(
            logPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error("Development log must be a single-link regular file");
        }
        return stat.size;
    } finally {
        closeSync(descriptor);
    }
}

function seedDevelopmentOpenClawLog(
    config: DevelopmentStackConfig,
    timestamp: Date
): void {
    const logPath = developmentLogPath(config, timestamp);
    const existingLogSize = developmentLogFileSize(logPath);
    if (existingLogSize !== undefined && existingLogSize >= 1024) return;
    for (let index = 0; index < 24; index += 1) {
        appendDevelopmentLogEntry(
            config,
            DEVELOPMENT_LOG_FIXTURES[index % DEVELOPMENT_LOG_FIXTURES.length]!,
            new Date(timestamp.getTime() - (24 - index) * 1000)
        );
    }
}

export function prepareDevelopmentLog(config: DevelopmentStackConfig): void {
    const logsRoot = developmentLogsRoot(config);
    ensurePrivateStateDirectory(config, logsRoot);
    if (config.openClawLogMode === "host-read-only") {
        if (!isRealDirectory(HOST_OPENCLAW_LOGS_ROOT)) {
            throw new Error(
                `OpenClaw host logs must be a real directory: ${HOST_OPENCLAW_LOGS_ROOT}`
            );
        }
        return;
    }
    ensurePrivateStateDirectory(config, syntheticDevelopmentOpenClawLogsRoot(config));
    const timestamp = new Date();
    seedDevelopmentOpenClawLog(config, timestamp);
    seedDevelopmentOpenClawLog(
        config,
        new Date(timestamp.getTime() - 24 * 60 * 60 * 1000)
    );
    appendDevelopmentLogEntry(config, {
        level: "INFO",
        message:
            "[dashboard-dev] Isolated Dashboard dev log started; host logs are not mounted.",
    });
}
