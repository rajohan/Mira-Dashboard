import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, FileText, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { logsCollection } from "../collections/logs";
import { LevelFilter, LogLine } from "../components/features/logs";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import { useLogContent, useLogFiles, useOpenClawSocket } from "../hooks";
import type { LogFile } from "../types/log";
import { formatDateStamp } from "../utils/format";
import { LINE_OPTIONS, LOG_LEVELS, parseLogLine } from "../utils/logUtilities";

const LOG_BOTTOM_THRESHOLD_PX = 24;
const logsPageState: { lastVisibleLogFiles: LogFile[] } = { lastVisibleLogFiles: [] };
const NO_LOG_SCROLL_ELEMENT = JSON.parse("null") as HTMLDivElement | null;

type LogViewportElement = Pick<
    HTMLDivElement,
    "clientHeight" | "scrollHeight" | "scrollTop"
>;

/** Returns whether a log viewport is currently scrolled near the bottom. */
export function isLogViewportAtBottom(viewport: LogViewportElement | undefined) {
    if (!viewport) {
        return false;
    }

    return (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        LOG_BOTTOM_THRESHOLD_PX
    );
}

/** Scrolls a log viewport to the bottom when present. */
export function scrollLogViewportToBottom(viewport: LogViewportElement | undefined) {
    if (!viewport) {
        return false;
    }

    viewport.scrollTop = viewport.scrollHeight;
    return true;
}

/** Scrolls a log viewport to the bottom and reports the new scroll position. */
export function scrollLogViewportToBottomAndReport(
    viewport: LogViewportElement | undefined,
    onScrolled: (scrollTop: number) => void
) {
    if (!viewport) {
        return false;
    }

    scrollLogViewportToBottom(viewport);
    onScrolled(viewport.scrollTop);
    return true;
}

/** Returns whether named log file. */
export function isNamedLogFile(file: unknown): file is LogFile {
    return (
        Boolean(file) &&
        typeof file === "object" &&
        typeof (file as { name?: unknown }).name === "string" &&
        (file as { name: string }).name.trim().length > 0
    );
}

/** Performs compare log file names descending. */
export function compareLogFileNamesDescending(
    a: { name?: unknown },
    b: { name?: unknown }
) {
    return String(b.name || "").localeCompare(String(a.name || ""));
}

export function compareLogEntriesByLineId(
    a: { lineId?: number | string },
    b: { lineId?: number | string }
) {
    const aLineId = readNumericLogLineId(a);
    const bLineId = readNumericLogLineId(b);

    if (aLineId !== undefined && bLineId !== undefined) {
        return aLineId - bLineId;
    }

    if (aLineId !== undefined) {
        return -1;
    }

    if (bLineId !== undefined) {
        return 1;
    }

    return 0;
}

export function formatLogEntryCount(visibleCount: number, totalCount: number) {
    const suffix = visibleCount === 1 ? "entry" : "entries";
    return visibleCount === totalCount
        ? `${visibleCount} ${suffix}`
        : `${visibleCount} of ${totalCount} ${totalCount === 1 ? "entry" : "entries"}`;
}

function readNumericLogLineId(log: { lineId?: number | string }) {
    const rawLineId = log.lineId;
    if (typeof rawLineId === "string" && !rawLineId.trim()) {
        return;
    }

    const lineId = Number(rawLineId);
    return Number.isFinite(lineId) ? lineId : undefined;
}

function logSnapshotRequestKey(file: string | undefined, lines: number) {
    return `${file ?? ""}:${lines}`;
}

/** Renders the logs UI. */
export function Logs() {
    const [selectedFile, setSelectedFile] = useState<string | undefined>(undefined);
    const [lineCount, setLineCount] = useState<number>(100);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const [isAtBottom, setIsAtBottom] = useState(true);

    const logContainerReference = useRef<HTMLDivElement | undefined>(undefined);
    const shouldStickToBottomReference = useRef(true);
    const lastKnownLogScrollTopReference = useRef(0);
    const subscribedConnectionIdReference = useRef<number | undefined>(undefined);
    const requestSeqReference = useRef(0);
    const latestSnapshotRequestKeyReference = useRef("");
    const lastSnapshotFileReference = useRef<string | undefined>(undefined);
    const lastSnapshotMaxLineIdReference = useRef<number | undefined>(undefined);
    latestSnapshotRequestKeyReference.current = logSnapshotRequestKey(
        selectedFile,
        lineCount
    );

    // OpenClaw connection (shared WebSocket)
    const { isConnected, connectionId, request } = useOpenClawSocket();

    // Logs from collection using live query
    const { data: logs = [] } = useLiveQuery((q) => q.from({ log: logsCollection }));
    const liveLogs = Array.isArray(logs) ? logs : [];
    const orderedLogs = liveLogs.toSorted(compareLogEntriesByLineId);

    // Queries
    const [availableLogFiles, setAvailableLogFiles] = useState<LogFile[]>(
        () => logsPageState.lastVisibleLogFiles
    );
    const { data: logFiles } = useLogFiles();
    const { refetch: refetchContent, isFetching: isLoadingContent } = useLogContent(
        selectedFile || undefined,
        lineCount,
        false
    );

    useEffect(() => {
        if (!Array.isArray(logFiles)) {
            return;
        }

        const nextLogFiles = logFiles.filter(isNamedLogFile);

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
    }, [logFiles]);

    // Auto-select today's file
    useEffect(() => {
        if (availableLogFiles.length === 0 || selectedFile) {
            return;
        }

        const sorted = [...availableLogFiles].toSorted(compareLogFileNamesDescending);
        const today = formatDateStamp();
        const todayFile = sorted.find((f) => f.name.includes(today));
        setSelectedFile(todayFile?.name || sorted[0]!.name);
    }, [availableLogFiles, selectedFile]);

    // Subscribe to log stream once per connection
    useEffect(() => {
        if (!isConnected || subscribedConnectionIdReference.current === connectionId) {
            return;
        }

        subscribedConnectionIdReference.current = connectionId;
        void (async () => {
            try {
                await request("subscribe", { channel: "logs" });
            } catch (error) {
                console.error("Failed to subscribe to logs:", error);
                subscribedConnectionIdReference.current = undefined;
            }
        })();
    }, [isConnected, connectionId, request]);

    /** Performs load log content. */
    const loadLogContent = async () => {
        const seq = ++requestSeqReference.current;
        const requestedFile = selectedFile;
        const requestKey = logSnapshotRequestKey(requestedFile, lineCount);
        let result: Awaited<ReturnType<typeof refetchContent>>;

        try {
            result = await refetchContent();
        } catch (error) {
            console.error("Failed to load log content:", error);
            return;
        }

        if (
            seq === requestSeqReference.current &&
            requestKey === latestSnapshotRequestKeyReference.current
        ) {
            const content = result.data?.content || "";
            const lineIds = result.data?.lineIds || [];
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
                    lastSnapshotFileReference.current !== requestedFile;
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
                    requestedFile !== undefined &&
                    requestedFile !== latestVisibleFileName;
                const isReplacingTruncatedFile =
                    !isReplacingDifferentFile &&
                    snapshotMaxLineId !== undefined &&
                    lastSnapshotMaxLineIdReference.current !== undefined &&
                    snapshotMaxLineId < lastSnapshotMaxLineIdReference.current;
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
                    return { dedupeKey: log.dedupeKey, key: String(key), lineId };
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
                lastSnapshotFileReference.current = requestedFile;
                lastSnapshotMaxLineIdReference.current = snapshotMaxLineId;
            }
        }
    };

    // Load on mount and when file/lineCount changes
    useEffect(() => {
        if (!(selectedFile && availableLogFiles.length > 0)) {
            return;
        }

        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
        void loadLogContent();
    }, [selectedFile, lineCount, availableLogFiles.length]);

    const filteredLogs = orderedLogs.filter((log) => {
        const level = typeof log.level === "string" ? log.level.toLowerCase() : undefined;
        if (level && !levelFilter.has(level)) {
            return false;
        }

        const raw = typeof log.raw === "string" ? log.raw : String(log.msg || "");
        return !(search && !raw.toLowerCase().includes(search.toLowerCase()));
    });

    /** Performs toggle level. */
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
            .map((log) => (typeof log.raw === "string" ? log.raw : String(log.msg || "")))
            .join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const downloadName = selectedFile ?? "logs";
        a.download = `${downloadName}-${formatDateStamp()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const rowVirtualizer = useVirtualizer({
        count: filteredLogs.length,
        getScrollElement: () => logContainerReference.current ?? NO_LOG_SCROLL_ELEMENT,
        estimateSize: () => 22,
        overscan: 15,
        getItemKey: (index) => filteredLogs[index]!.id,
        measureElement: (element) => Math.ceil(element.getBoundingClientRect().height),
    });

    /** Performs check is at bottom. */
    const checkIsAtBottom = () => {
        return isLogViewportAtBottom(logContainerReference.current);
    };

    /** Updates scroll state when the log viewport scrolls. */
    const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        lastKnownLogScrollTopReference.current = element.scrollTop;

        const atBottom = checkIsAtBottom();
        shouldStickToBottomReference.current = atBottom;
        setIsAtBottom((wasPrevious) =>
            wasPrevious === atBottom ? wasPrevious : atBottom
        );
    };

    /** Performs scroll to bottom. */
    const scrollToBottom = () => {
        scrollLogViewportToBottomAndReport(logContainerReference.current, (scrollTop) => {
            lastKnownLogScrollTopReference.current = scrollTop;
            shouldStickToBottomReference.current = true;
            setIsAtBottom(true);
        });
    };

    useLayoutEffect(() => {
        if (filteredLogs.length === 0) return;

        if (!shouldStickToBottomReference.current) {
            /** Performs restore scroll top. */
            const restoreScrollTop = () => {
                const element = logContainerReference.current;
                if (!element || shouldStickToBottomReference.current) {
                    return;
                }

                element.scrollTop = lastKnownLogScrollTopReference.current;
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

    /** Performs clear logs. */
    const clearLogs = () => {
        const existingKeys = Array.from(logsCollection, ([key]) => String(key));
        logsCollection.utils.writeDelete(existingKeys);
    };

    return (
        <div className="flex h-full min-h-0 flex-col p-3 sm:p-4 lg:p-6">
            <div className="mb-3 grid grid-cols-1 gap-3 sm:mb-4 md:grid-cols-[minmax(0,1fr)_8rem] lg:grid-cols-[minmax(0,1fr)_8rem_minmax(12rem,24rem)] xl:grid-cols-[minmax(0,1fr)_8rem_minmax(12rem,24rem)_auto] xl:items-center">
                <Select
                    value={selectedFile || ""}
                    onChange={(v) => setSelectedFile(v || undefined)}
                    options={sortedLogFiles.map((f) => ({
                        value: f.name,
                        label: f.name,
                    }))}
                    placeholder="Select file..."
                    icon={<FileText className="size-4" />}
                    width="w-full"
                />

                <Select
                    value={lineCount.toString()}
                    onChange={(v) => setLineCount(Math.trunc(Number(v)))}
                    options={LINE_OPTIONS.map((n) => ({
                        value: n.toString(),
                        label: `${n} lines`,
                    }))}
                    width="w-full"
                />

                <Input
                    placeholder="Search logs..."
                    value={search}
                    onChange={(event_) => setSearch(event_.target.value)}
                    className="w-full min-w-0 md:col-span-2 lg:col-span-1"
                />

                <div className="min-w-0 md:col-span-2 lg:col-span-3 xl:col-span-1">
                    <LevelFilter
                        levels={LOG_LEVELS}
                        activeLevels={levelFilter}
                        onToggle={toggleLevel}
                    />
                </div>
            </div>

            <div className="mb-3 flex flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-primary-400">
                    {isLoadingContent
                        ? "Loading..."
                        : formatLogEntryCount(filteredLogs.length, liveLogs.length)}
                </div>

                <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center">
                    <RefreshButton
                        onClick={() => void loadLogContent()}
                        isLoading={isLoadingContent}
                        label="Reload"
                        disabled={!selectedFile}
                    />
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleExport}
                        disabled={filteredLogs.length === 0}
                    >
                        <Download size={14} />
                        Export
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={clearLogs}
                        disabled={liveLogs.length === 0}
                    >
                        <Trash2 size={14} />
                        Clear
                    </Button>
                </div>
            </div>

            <Card
                className="min-h-0 flex-1 overflow-hidden p-0 sm:p-4"
                variant="bordered"
            >
                <div
                    ref={(element) => {
                        logContainerReference.current = element ?? undefined;
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
                                ? "Waiting for logs..."
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
