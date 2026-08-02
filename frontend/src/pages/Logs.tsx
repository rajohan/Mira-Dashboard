import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import type { LogFile } from "../../../contracts/logs";
import { logsCollection } from "../collections/logs";
import { LogControls, type LogSource } from "../components/features/logs/LogControls";
import { LogLine } from "../components/features/logs/LogLine";
import { Card } from "../components/ui/Card";
import { useDashboardLogContent, useLogContent, useLogFiles } from "../hooks/useLogs";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { messageFromError } from "../lib/errorMessage";
import { formatDateStamp } from "../utils/format";
import { parseLogLine } from "../utils/logUtilities";
import {
    compareLogEntriesByLineId,
    compareLogFileNamesDescending,
    isLogViewportAtBottom,
    isNamedLogFile,
    readNumericLogLineId,
    scrollLogViewportToBottomAndReport,
} from "./logPageUtilities";

const logsPageState: { lastVisibleLogFiles: LogFile[] } = { lastVisibleLogFiles: [] };
function logSnapshotRequestKey(
    source: LogSource,
    file: string | undefined,
    lines: number
) {
    return `${source}:${file ?? ""}:${lines}`;
}

function clearLogCollection(): void {
    const existingKeys = Array.from(logsCollection, ([key]) => key);
    logsCollection.utils.writeDelete(existingKeys);
}

/**
 * Renders the logs UI.
 * @returns Rendered the logs UI.
 */
export function Logs() {
    const [source, setSource] = useState<LogSource>("dashboard");
    const [selectedFile, setSelectedFile] = useState<string | undefined>();
    const [lineCount, setLineCount] = useState<number>(100);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        () => new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [dashboardUnavailableReason, setDashboardUnavailableReason] = useState<
        string | undefined
    >();

    const logContainerRef = useRef<HTMLDivElement | undefined>(undefined);
    const shouldStickToBottomRef = useRef(true);
    const lastKnownLogScrollTopRef = useRef(0);
    const subscribedLogStreamRef = useRef<string | undefined>(undefined);
    const requestSeqRef = useRef(0);
    const latestSnapshotRequestKeyRef = useRef("");
    const lastSnapshotFileRef = useRef<string | undefined>(undefined);
    const lastSnapshotMaxLineIdRef = useRef<number | undefined>(undefined);
    latestSnapshotRequestKeyRef.current = logSnapshotRequestKey(
        source,
        source === "openclaw" ? selectedFile : undefined,
        lineCount
    );

    // OpenClaw connection (shared WebSocket)
    const { isConnected, connectionId, request } = useOpenClawSocket();

    // Logs from collection using live query
    const { data: logs } = useLiveQuery((q) => q.from({ log: logsCollection }));
    const liveLogs = logs;
    const orderedLogs = liveLogs.toSorted(compareLogEntriesByLineId);

    // Queries
    const [availableLogFiles, setAvailableLogFiles] = useState<LogFile[]>(
        () => logsPageState.lastVisibleLogFiles
    );
    const {
        data: logFiles,
        error: logFilesError,
        isError: isLogFilesError,
        isSuccess: isLogFilesLoaded,
        unavailableReason: openClawUnavailableReason,
    } = useLogFiles(source === "openclaw");
    const { refetch: refetchOpenClawContent, isFetching: isLoadingOpenClawContent } =
        useLogContent(selectedFile || undefined, lineCount, false);
    const { refetch: refetchDashboardContent, isFetching: isLoadingDashboardContent } =
        useDashboardLogContent(lineCount, false);
    const isLoadingContent = isLoadingDashboardContent || isLoadingOpenClawContent;

    useEffect(() => {
        if (!Array.isArray(logFiles)) {
            return;
        }

        if (openClawUnavailableReason) {
            logsPageState.lastVisibleLogFiles = [];
            setAvailableLogFiles([]);
            if (logsCollection.isReady()) {
                const keys = Array.from(logsCollection, ([key]) => key);
                logsCollection.utils.writeDelete(keys);
            }
            return;
        }

        const nextLogFiles = logFiles.filter((file) => isNamedLogFile(file));

        setAvailableLogFiles((wasPrevious) => {
            if (nextLogFiles.length === 0 && wasPrevious.length > 0) {
                return wasPrevious;
            }

            const previousKeys = wasPrevious.map((file) => file.name).join("\n");
            const nextKeys = nextLogFiles.map((file) => file.name).join("\n");
            const resolvedLogFiles =
                previousKeys === nextKeys ? wasPrevious : nextLogFiles;

            if (resolvedLogFiles.length > 0) {
                logsPageState.lastVisibleLogFiles = resolvedLogFiles;
            }

            return resolvedLogFiles;
        });
    }, [logFiles, openClawUnavailableReason]);

    // Auto-select today's file
    useEffect(() => {
        if (selectedFile || availableLogFiles.length === 0) {
            return;
        }

        const sorted = [...availableLogFiles].toSorted(compareLogFileNamesDescending);
        const today = formatDateStamp();
        const todayFile = sorted.find((f) => f.name.includes(today));
        setSelectedFile(todayFile?.name || sorted[0]!.name);
    }, [availableLogFiles, selectedFile]);

    // Subscribe to the selected live log stream once per connection.
    useEffect(() => {
        const channel = source === "dashboard" ? "dashboard-logs" : "logs";
        const subscriptionKey = `${connectionId}:${channel}`;
        if (
            !isConnected ||
            (source === "openclaw" &&
                (!isLogFilesLoaded || Boolean(openClawUnavailableReason))) ||
            subscribedLogStreamRef.current === subscriptionKey
        ) {
            return;
        }

        subscribedLogStreamRef.current = subscriptionKey;
        void (async () => {
            try {
                await request("subscribe", { channel });
            } catch (error) {
                console.error("Failed to subscribe to logs:", error);
                subscribedLogStreamRef.current = undefined;
            }
        })();
        return () => {
            if (subscribedLogStreamRef.current !== subscriptionKey) {
                return;
            }
            subscribedLogStreamRef.current = undefined;
            void request("unsubscribe", { channel }).catch(() => {});
        };
    }, [
        connectionId,
        isConnected,
        isLogFilesLoaded,
        openClawUnavailableReason,
        request,
        source,
    ]);

    useEffect(() => {
        requestSeqRef.current += 1;
        lastSnapshotFileRef.current = undefined;
        lastSnapshotMaxLineIdRef.current = undefined;
        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
        if (logsCollection.isReady()) {
            const keys = Array.from(logsCollection, ([key]) => key);
            logsCollection.utils.writeDelete(keys);
        }
    }, [source]);

    /** Performs load log content. */
    const loadLogContent = async () => {
        const seq = ++requestSeqRef.current;
        const requestedFile = source === "openclaw" ? selectedFile : undefined;
        const requestedSnapshot = `${source}:${requestedFile ?? ""}`;
        const requestKey = logSnapshotRequestKey(source, requestedFile, lineCount);

        try {
            const result =
                source === "dashboard"
                    ? await refetchDashboardContent()
                    : await refetchOpenClawContent();
            await logsCollection.preload();
            const content = result.data?.content || "";
            const lineIds = result.data?.lineIds || [];
            setDashboardUnavailableReason(
                source === "dashboard" &&
                    result.data &&
                    "unavailableReason" in result.data
                    ? result.data.unavailableReason
                    : undefined
            );

            if (
                seq !== requestSeqRef.current ||
                requestKey !== latestSnapshotRequestKeyRef.current
            ) {
                return;
            }
            const parsedLogs = content
                .split("\n")
                .map((line, index) =>
                    parseLogLine(
                        line,
                        typeof lineIds[index] === "string" ||
                            typeof lineIds[index] === "number"
                            ? lineIds[index]
                            : index
                    )
                )
                .filter(
                    (entry): entry is NonNullable<typeof entry> => entry !== undefined
                );

            if (logsCollection.isReady()) {
                // Replace the snapshot as one collection change so large tails do not
                // trigger thousands of intermediate live-query updates.
                const isReplacingDifferentFile =
                    lastSnapshotFileRef.current !== requestedSnapshot;
                let snapshotMaxLineId: number | undefined;
                for (const log of parsedLogs) {
                    const lineId = readNumericLogLineId(log);
                    if (lineId !== undefined) {
                        snapshotMaxLineId =
                            snapshotMaxLineId === undefined
                                ? lineId
                                : Math.max(snapshotMaxLineId, lineId);
                    }
                }
                const nextKeys = new Set(parsedLogs.map((log) => log.id));
                const latestVisibleFileName = [...availableLogFiles].toSorted(
                    compareLogFileNamesDescending
                )[0]?.name;
                const isReplacingOlderFile =
                    source === "openclaw" &&
                    requestedFile !== undefined &&
                    requestedFile !== latestVisibleFileName;
                const isReplacingTruncatedFile =
                    !isReplacingDifferentFile &&
                    snapshotMaxLineId !== undefined &&
                    lastSnapshotMaxLineIdRef.current !== undefined &&
                    snapshotMaxLineId < lastSnapshotMaxLineIdRef.current;
                const shouldDeleteAllMissing =
                    isReplacingDifferentFile ||
                    isReplacingOlderFile ||
                    isReplacingTruncatedFile ||
                    snapshotMaxLineId === undefined;
                const snapshotDedupeKeys = new Set(
                    parsedLogs
                        .map((log) => log.dedupeKey)
                        .filter((key): key is string => typeof key === "string")
                );
                const keysToDelete = Array.from(logsCollection, ([key, log]) => {
                    const lineId = readNumericLogLineId(log);
                    return { dedupeKey: log.dedupeKey, key: key, lineId };
                })
                    .filter(
                        (entry) =>
                            entry.key &&
                            !nextKeys.has(entry.key) &&
                            (shouldDeleteAllMissing ||
                                (entry.lineId === undefined &&
                                    entry.dedupeKey !== undefined &&
                                    snapshotDedupeKeys.has(entry.dedupeKey)) ||
                                (entry.lineId !== undefined &&
                                    snapshotMaxLineId !== undefined &&
                                    entry.lineId <= snapshotMaxLineId))
                    )
                    .map((entry) => entry.key);
                logsCollection.utils.writeBatch(() => {
                    logsCollection.utils.writeDelete(keysToDelete);
                    logsCollection.utils.writeUpsert(parsedLogs);
                });
                lastSnapshotFileRef.current = requestedSnapshot;
                lastSnapshotMaxLineIdRef.current = snapshotMaxLineId;
            }
        } catch (error) {
            console.error("Failed to load log content:", error);
        }
    };
    const loadLogContentFromEffect = useEffectEvent(loadLogContent);

    // Load on mount and when file/lineCount changes
    useEffect(() => {
        if (source === "openclaw" && !(selectedFile && availableLogFiles.length > 0)) {
            return;
        }

        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
        void loadLogContentFromEffect();
    }, [availableLogFiles.length, lineCount, selectedFile, source]);

    const normalizedSearch = search.trim().toLowerCase();
    const filteredLogs = orderedLogs.filter((log) => {
        const level = typeof log.level === "string" ? log.level.toLowerCase() : undefined;
        if (level && !levelFilter.has(level)) {
            return false;
        }

        const raw = typeof log.raw === "string" ? log.raw : log.msg || "";
        return !normalizedSearch || raw.toLowerCase().includes(normalizedSearch);
    });

    /**
     * Performs toggle level.
     * @param level Level value.
     */
    const toggleLevel = (level: string) => {
        const next = new Set(levelFilter);
        if (next.has(level)) {
            next.delete(level);
        } else {
            next.add(level);
        }
        setLevelFilter(next);
    };

    /** Exports the currently filtered log lines as a downloadable text file. */
    const handleExport = () => {
        const content = filteredLogs
            .map((log) => (typeof log.raw === "string" ? log.raw : log.msg || ""))
            .join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const downloadName =
            source === "dashboard" ? "mira-dashboard" : (selectedFile ?? "openclaw");
        a.download = `${downloadName}-${formatDateStamp()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const rowVirtualizer = useVirtualizer({
        count: filteredLogs.length,
        getScrollElement: () => logContainerRef.current ?? null,
        estimateSize: () => 22,
        overscan: 15,
        getItemKey: (index) => filteredLogs[index]!.id,
        measureElement: (element) => Math.ceil(element.getBoundingClientRect().height),
    });

    /**
     * Performs check is at bottom.
     * @returns Check is at bottom result.
     */
    const checkIsAtBottom = () => {
        return isLogViewportAtBottom(logContainerRef.current);
    };

    /** Updates scroll state when the log viewport scrolls. */
    const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        lastKnownLogScrollTopRef.current = element.scrollTop;

        const atBottom = checkIsAtBottom();
        shouldStickToBottomRef.current = atBottom;
        setIsAtBottom((wasPrevious) =>
            wasPrevious === atBottom ? wasPrevious : atBottom
        );
    };

    /** Performs scroll to bottom. */
    const scrollToBottom = () => {
        scrollLogViewportToBottomAndReport(logContainerRef.current, (scrollTop) => {
            lastKnownLogScrollTopRef.current = scrollTop;
            shouldStickToBottomRef.current = true;
            setIsAtBottom(true);
        });
    };

    useLayoutEffect(() => {
        if (filteredLogs.length === 0) return;

        if (!shouldStickToBottomRef.current) {
            /** Performs restore scroll top. */
            const restoreScrollTop = () => {
                const element = logContainerRef.current;
                if (!element || shouldStickToBottomRef.current) {
                    return;
                }

                element.scrollTop = lastKnownLogScrollTopRef.current;
            };

            restoreScrollTop();
            const restoreFrame = requestAnimationFrame(restoreScrollTop);
            return () => cancelAnimationFrame(restoreFrame);
        }

        const lastIndex = filteredLogs.length - 1;
        rowVirtualizer.scrollToIndex(lastIndex, { align: "end" });

        const followFrame = requestAnimationFrame(() => {
            rowVirtualizer.scrollToIndex(lastIndex, { align: "end" });
        });

        return () => cancelAnimationFrame(followFrame);
    }, [filteredLogs.length, rowVirtualizer]);

    const sortedLogFiles = [...availableLogFiles].toSorted(compareLogFileNamesDescending);
    let emptyLogMessage =
        dashboardUnavailableReason || "No Dashboard log entries are available.";
    if (source === "openclaw") {
        if (openClawUnavailableReason) {
            emptyLogMessage = openClawUnavailableReason;
        } else if (isLogFilesError) {
            emptyLogMessage = messageFromError(
                logFilesError,
                "Failed to load OpenClaw log files."
            );
        } else if (isLogFilesLoaded && availableLogFiles.length === 0) {
            emptyLogMessage = "No log files are available.";
        } else if (isLogFilesLoaded) {
            emptyLogMessage = "Waiting for logs...";
        } else {
            emptyLogMessage = "Checking log availability...";
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col p-3 sm:p-4 lg:p-6">
            <LogControls
                activeLevels={levelFilter}
                availableLogFiles={sortedLogFiles}
                isLoading={isLoadingContent}
                lineCount={lineCount}
                onClear={clearLogCollection}
                onExport={handleExport}
                onLevelToggle={toggleLevel}
                onLineCountChange={setLineCount}
                onReload={() => void loadLogContent()}
                onSearchChange={setSearch}
                onSelectedFileChange={setSelectedFile}
                onSourceChange={setSource}
                search={search}
                selectedFile={selectedFile}
                source={source}
                totalCount={liveLogs.length}
                visibleCount={filteredLogs.length}
            />
            <Card
                className="min-h-0 flex-1 overflow-hidden p-0 sm:p-4"
                variant="bordered"
            >
                <div
                    ref={(element) => {
                        logContainerRef.current = element ?? undefined;
                    }}
                    onScroll={handleScroll}
                    className="relative h-full overflow-y-auto bg-primary-900/50 font-mono text-[11px] sm:text-xs"
                    style={{ overflowAnchor: "none" }}
                >
                    {!isAtBottom && filteredLogs.length > 0 && (
                        <button
                            type="button"
                            onClick={scrollToBottom}
                            className="sticky top-2 z-10 float-right mr-2 mb-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600"
                        >
                            ↓ Follow
                        </button>
                    )}

                    {filteredLogs.length === 0 ? (
                        <div className="py-8 text-center text-primary-400">
                            {liveLogs.length === 0
                                ? emptyLogMessage
                                : "No logs match your filter."}
                        </div>
                    ) : (
                        <div
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`,
                                width: "100%",
                                position: "relative",
                            }}
                        >
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const log = filteredLogs[virtualRow.index]!;

                                return (
                                    <div
                                        key={virtualRow.key}
                                        data-index={virtualRow.index}
                                        ref={rowVirtualizer.measureElement}
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        <LogLine log={log} />
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </Card>
        </div>
    );
}

export default Logs;
