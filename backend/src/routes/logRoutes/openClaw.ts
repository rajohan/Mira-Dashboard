import fs from "node:fs";
import path from "node:path";

import type {
    LogContent,
    LogFile,
    OpenClawLogContentResponse,
    OpenClawLogFilesResponse,
} from "../../../../contracts/logs.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { guardedPath } from "../../lib/guardedOps/core.ts";
import { openReadNoFollowNonblockingGuarded } from "../../lib/guardedOps/read.ts";
import {
    formatOpenClawLogDate,
    logUnavailableReason,
    resolveRealLogsDirectory,
} from "../../lib/logRoots.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    isLogNotFoundErrorCode,
    isLogPathUnreadableErrorCode,
    isOpenedLogPathWithinRoot,
    lineContentWithIds,
    parsePositiveLineCount,
} from "./tailReader.ts";

const logger = createStructuredLogger("logs");

function unavailableLogInfoResponse(
    reason = logUnavailableReason() || "The log directory is unavailable."
): Response {
    return json({
        logs: [],
        unavailableReason: reason,
    } satisfies OpenClawLogFilesResponse);
}

export function openClawLogInfoResponse(): Response {
    try {
        const unavailableReason = logUnavailableReason();
        if (unavailableReason) {
            return unavailableLogInfoResponse(unavailableReason);
        }

        let realRoot: string;
        try {
            realRoot = resolveRealLogsDirectory();
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return unavailableLogInfoResponse();
            }
            throw error;
        }

        let names: string[];
        try {
            names = fs.readdirSync(realRoot);
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return unavailableLogInfoResponse();
            }
            throw error;
        }

        const files: LogFile[] = names
            .filter(
                (fileName) =>
                    fileName.startsWith("openclaw-") && fileName.endsWith(".log")
            )
            .flatMap((fileName) => {
                let stat: fs.Stats;
                try {
                    stat = fs.lstatSync(path.join(realRoot, fileName));
                } catch (error) {
                    if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                        return [];
                    }
                    throw error;
                }
                if (!stat.isFile() || stat.isSymbolicLink()) return [];
                return [
                    {
                        modified: stat.mtime.toISOString(),
                        name: fileName,
                        size: stat.size,
                    },
                ];
            })
            .toSorted((a, b) => b.modified.localeCompare(a.modified));

        return json({ logs: files } satisfies OpenClawLogFilesResponse);
    } catch (error) {
        logger.error("logs.files_list_failed", { error });
        return routeFailureResponse({
            context: "log",
            message: "Failed to list log files",
            status: 500,
        });
    }
}

export async function openClawLogContentResponse(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    let logFile = query.get("file") || undefined;
    const lines = parsePositiveLineCount(query.get("lines"));
    if (lines === undefined && query.has("lines")) {
        return routeFailureResponse({
            context: "log",
            message: "Invalid lines",
            status: 400,
        });
    }

    if (!logFile) {
        const today = formatOpenClawLogDate(new Date());
        logFile = `openclaw-${today}.log`;
    }
    const logFileName = path.basename(logFile);
    if (
        logFile !== logFileName ||
        !logFileName.startsWith("openclaw-") ||
        !logFileName.endsWith(".log")
    ) {
        return routeFailureResponse({
            context: "log",
            message: "Log file not found",
            status: 404,
        });
    }

    try {
        let realRoot: string;
        try {
            realRoot = resolveRealLogsDirectory();
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return routeFailureResponse({
                    context: "log",
                    message: "Log file not found",
                    status: 404,
                });
            }
            throw error;
        }

        const candidatePath = path.resolve(realRoot, logFile);
        if (candidatePath === realRoot) {
            return routeFailureResponse({
                context: "log",
                message: "Log file not found",
                status: 404,
            });
        }
        if (!candidatePath.startsWith(`${realRoot}${path.sep}`)) {
            return routeFailureResponse({
                context: "log",
                message: "Access denied",
                status: 403,
            });
        }

        let file: fs.promises.FileHandle;
        try {
            file = await openReadNoFollowNonblockingGuarded(guardedPath(candidatePath));
        } catch (error) {
            if (isLogPathUnreadableErrorCode((error as NodeJS.ErrnoException).code)) {
                return routeFailureResponse({
                    context: "log",
                    message: "Log file not found",
                    status: 404,
                });
            }
            logger.error("logs.file_open_failed", { error, file: logFileName });
            return routeFailureResponse({
                context: "log",
                message: "Failed to open log file",
                status: 500,
            });
        }

        let content: LogContent;
        try {
            const stat = await file.stat();
            if (!stat.isFile()) {
                return routeFailureResponse({
                    context: "log",
                    message: "Log file not found",
                    status: 404,
                });
            }
            if (!isOpenedLogPathWithinRoot(file, realRoot) || stat.nlink > 1) {
                return routeFailureResponse({
                    context: "log",
                    message: "Access denied",
                    status: 403,
                });
            }
            content = await lineContentWithIds(file, stat, lines);
        } finally {
            await file.close();
        }

        return json({
            content: content.content,
            file: logFile,
            lineIds: content.lineIds,
        } satisfies OpenClawLogContentResponse);
    } catch (error) {
        logger.error("logs.file_read_failed", { error, file: logFileName });
        return routeFailureResponse({
            context: "log",
            message: "Failed to read log file",
            status: 500,
        });
    }
}
