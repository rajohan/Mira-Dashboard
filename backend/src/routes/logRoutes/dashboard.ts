import fs from "node:fs";
import path from "node:path";

import type {
    DashboardLogContentResponse,
    LogContent,
} from "../../../../contracts/logs.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { guardedPath } from "../../lib/guardedOps/core.ts";
import { openReadNoFollowNonblockingGuarded } from "../../lib/guardedOps/read.ts";
import { runProcess, type RunProcessResult } from "../../lib/processes.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    isLogPathUnreadableErrorCode,
    isOpenedLogPathWithinRoot,
    lineContentWithIds,
    parsePositiveLineCount,
} from "./tailReader.ts";

const logger = createStructuredLogger("logs");

const DASHBOARD_LOG_DEFAULT_LINES = 100;
const DASHBOARD_LOG_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DASHBOARD_LOG_TIMEOUT_MS = 5000;
const DEVELOPMENT_APPLICATION_LOG_FILE = "dashboard.ndjson";
const DASHBOARD_JOURNAL_UNITS = [
    "mira-dashboard.service",
    "mira-dashboard-worker.service",
] as const;
const DASHBOARD_JOURNAL_PROCESS_MATCH = "_COMM=bun";

interface JournalRecord {
    MESSAGE?: unknown;
    __CURSOR?: unknown;
    __REALTIME_TIMESTAMP?: unknown;
}

type JournalRunner = (
    executable: string,
    arguments_: readonly string[],
    options: {
        maxBuffer: number;
        timeoutMs: number;
    }
) => Promise<RunProcessResult>;

function journalEntry(
    raw: string,
    index: number
): { line: string; lineId: string } | undefined {
    if (!raw.trim()) return undefined;
    try {
        const record = JSON.parse(raw) as JournalRecord;
        if (typeof record.MESSAGE !== "string" || !record.MESSAGE.trim()) {
            return undefined;
        }
        const cursor =
            typeof record.__CURSOR === "string" && record.__CURSOR
                ? record.__CURSOR
                : undefined;
        const timestamp =
            typeof record.__REALTIME_TIMESTAMP === "string" && record.__REALTIME_TIMESTAMP
                ? record.__REALTIME_TIMESTAMP
                : "journal";
        return {
            line: record.MESSAGE,
            lineId: cursor ?? `${timestamp}:${index}`,
        };
    } catch {
        return undefined;
    }
}

/**
 * Reads the fixed Dashboard web/worker journal units without accepting command input.
 * @param lines Lines value.
 * @param runner Runner value.
 * @returns Read the fixed Dashboard web/worker journal units without accepting command input.
 */
export async function readDashboardJournal(
    lines: number,
    runner: JournalRunner = runProcess
): Promise<LogContent> {
    const result = await runner(
        "/usr/bin/journalctl",
        [
            "--user",
            "--no-pager",
            "--quiet",
            "--output=json",
            "--lines",
            String(lines),
            ...DASHBOARD_JOURNAL_UNITS.flatMap((unit) => ["--unit", unit]),
            DASHBOARD_JOURNAL_PROCESS_MATCH,
        ],
        {
            maxBuffer: DASHBOARD_LOG_MAX_BUFFER_BYTES,
            timeoutMs: DASHBOARD_LOG_TIMEOUT_MS,
        }
    );
    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "journalctl failed");
    }
    const entries = result.stdout
        .split("\n")
        .map((line, index) => journalEntry(line, index))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    return {
        content: entries.map((entry) => entry.line).join("\n"),
        lineIds: entries.map((entry) => entry.lineId),
    };
}

export async function dashboardLogContentResponse(request: Request): Promise<Response> {
    if (process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1") {
        return developmentDashboardLogContentResponse(request);
    }
    const query = new URL(request.url).searchParams;
    const parsedLines = parsePositiveLineCount(query.get("lines"));
    if (parsedLines === undefined && query.has("lines")) {
        return routeFailureResponse({
            context: "log",
            message: "Invalid lines",
            status: 400,
        });
    }
    try {
        return json({
            ...(await readDashboardJournal(parsedLines ?? DASHBOARD_LOG_DEFAULT_LINES)),
        } satisfies DashboardLogContentResponse);
    } catch (error) {
        logger.error("logs.dashboard_journal_read_failed", { error });
        return routeFailureResponse({
            context: "log",
            message: "Failed to read Dashboard logs",
            status: 503,
        });
    }
}

async function developmentDashboardLogContentResponse(
    request: Request
): Promise<Response> {
    const configuredPath = process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH?.trim();
    if (!configuredPath) {
        return json({
            content: "",
            lineIds: [],
            unavailableReason: "Dashboard application log capture is not configured.",
        } satisfies DashboardLogContentResponse);
    }
    const resolvedPath = path.resolve(configuredPath);
    if (
        !path.isAbsolute(configuredPath) ||
        path.basename(resolvedPath) !== DEVELOPMENT_APPLICATION_LOG_FILE
    ) {
        logger.error("logs.dashboard_development_path_invalid");
        return routeFailureResponse({
            context: "log",
            message: "Dashboard application log capture is unavailable",
            status: 503,
        });
    }
    const query = new URL(request.url).searchParams;
    const parsedLines = parsePositiveLineCount(query.get("lines"));
    if (parsedLines === undefined && query.has("lines")) {
        return routeFailureResponse({
            context: "log",
            message: "Invalid lines",
            status: 400,
        });
    }
    let file: fs.promises.FileHandle;
    try {
        file = await openReadNoFollowNonblockingGuarded(guardedPath(resolvedPath));
    } catch (error) {
        if (isLogPathUnreadableErrorCode((error as NodeJS.ErrnoException).code)) {
            return json({
                content: "",
                lineIds: [],
            } satisfies DashboardLogContentResponse);
        }
        logger.error("logs.dashboard_development_file_open_failed", { error });
        return routeFailureResponse({
            context: "log",
            message: "Failed to read Dashboard logs",
            status: 503,
        });
    }
    try {
        const stat = await file.stat();
        const realParent = fs.realpathSync(path.dirname(resolvedPath));
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            !isOpenedLogPathWithinRoot(file, realParent)
        ) {
            return routeFailureResponse({
                context: "log",
                message: "Dashboard application log capture is unavailable",
                status: 503,
            });
        }
        return json({
            ...(await lineContentWithIds(
                file,
                stat,
                parsedLines ?? DASHBOARD_LOG_DEFAULT_LINES
            )),
        } satisfies DashboardLogContentResponse);
    } catch (error) {
        logger.error("logs.dashboard_development_file_read_failed", { error });
        return routeFailureResponse({
            context: "log",
            message: "Failed to read Dashboard logs",
            status: 503,
        });
    } finally {
        await file.close();
    }
}
