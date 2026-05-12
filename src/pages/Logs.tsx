import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, FileText } from "lucide-react";
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
import { LINE_OPTIONS, LOG_LEVELS, parseLogLine } from "../utils/logUtils";

const LOG_BOTTOM_THRESHOLD_PX = 24;
let lastVisibleLogFiles: LogFile[] = [];

/** Handles is named log file. */
function isNamedLogFile(file: unknown): file is LogFile {
    return (
        Boolean(file) &&
        typeof file === "object" &&
        typeof (file as { name?: unknown }).name === "string" &&
        (file as { name: string }).name.trim().length > 0
    );
}

/** Handles compare log file names descending. */
function compareLogFileNamesDescending(a: { name?: unknown }, b: { name?: unknown }) {
    return String(b.name || "").localeCompare(String(a.name || ""));
}

/** Renders the logs UI. */
export function Logs() {
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState<number>(100);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const [isAtBottom, setIsAtBottom] = useState(true);

    const logContainerRef = useRef<HTMLDivElement>(null);
    const shouldStickToBottomRef = useRef(true);
    const lastKnownLogScrollTopRef = useRef(0);
    const subscribedConnectionIdRef = useRef<number | null>(null);
    const requestSeqRef = useRef(0);

    // OpenClaw connection (shared WebSocket)
    const { isConnected, connectionId, request } = useOpenClawSocket();

    // Logs from collection using live query
    const { data: logs = [] } = useLiveQuery((q) => q.from({ log: logsCollection }));
    const liveLogs = Array.isArray(logs) ? logs : [];

    // Queries
    const [availableLogFiles, setAvailableLogFiles] = useState<LogFile[]>(
        () => lastVisibleLogFiles
    );
    const { data: logFiles } = useLogFiles();
    const { refetch: refetchContent, isFetching: isLoadingContent } = useLogContent(
        selectedFile || null,
        lineCount,
        false
    );

    useEffect(() => {
        if (!Array.isArray(logFiles)) {
            return;
        }

        const nextLogFiles = logFiles.filter(isNamedLogFile);

        setAvailableLogFiles((previous) => {
            if (nextLogFiles.length === 0 && previous.length > 0) {
                return previous;
            }

            const previousKeys = previous.map((file) => file.name).join("\n");
            const nextKeys = nextLogFiles.map((file) => file.name).join("\n");
            const resolvedLogFiles = previousKeys === nextKeys ? previous : nextLogFiles;

            if (resolvedLogFiles.length > 0) {
                lastVisibleLogFiles = resolvedLogFiles;
            }

            return resolvedLogFiles;
        });
    }, [logFiles]);

    // Auto-select today's file
    useEffect(() => {
        if (availableLogFiles.length > 0 && !selectedFile) {
            const sorted = [...availableLogFiles].sort(compareLogFileNamesDescending);
            const today = formatDateStamp();
            const todayFile = sorted.find((f) => f.name.includes(today));
            setSelectedFile(todayFile?.name || sorted[0]?.name || "");
        }
    }, [availableLogFiles, selectedFile]);

    // Subscribe to log stream once per connection
    useEffect(() => {
        if (!isConnected) return;
        if (subscribedConnectionIdRef.current === connectionId) return;

        subscribedConnectionIdRef.current = connectionId;
        request("subscribe", { channel: "logs" }).catch((error_) => {
            console.error("Failed to subscribe to logs:", error_);
            subscribedConnectionIdRef.current = null;
        });
    }, [isConnected, connectionId, request]);

    /** Handles load log content. */
    const loadLogContent = async () => {
        if (!selectedFile) return;

        const seq = ++requestSeqRef.current;
        const result = await refetchContent();

        if (seq !== requestSeqRef.current) {
            return;
        }

        const content = result.data || "";
        const lines = content.split("\n").filter((line) => line.trim());
        const parsedLogs = lines
            .map((line, index) => parseLogLine(line, index))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        if (!logsCollection.isReady()) {
            return;
        }

        // Replace full snapshot without relying on stale array references.
        const existingKeys = Array.from(logsCollection, ([key]) => String(key));
        for (const key of existingKeys) {
            logsCollection.utils.writeDelete(key);
        }

        for (const parsed of parsedLogs) {
            logsCollection.utils.writeInsert(parsed);
        }
    };

    // Load on mount and when file/lineCount changes
    useEffect(() => {
        if (selectedFile && availableLogFiles.length > 0) {
            shouldStickToBottomRef.current = true;
            setIsAtBottom(true);
            void loadLogContent();
        }
    }, [selectedFile, lineCount, availableLogFiles.length]);

    const filteredLogs = liveLogs.filter((log) => {
        const level = typeof log.level === "string" ? log.level.toLowerCase() : null;
        const raw = typeof log.raw === "string" ? log.raw : String(log.msg || "");

        if (level && !levelFilter.has(level)) return false;
        if (search && !raw.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    /** Handles toggle level. */
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
        a.download = `${selectedFile || "logs"}-${formatDateStamp()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const rowVirtualizer = useVirtualizer({
        count: filteredLogs.length,
        getScrollElement: () => logContainerRef.current,
        estimateSize: () => 22,
        overscan: 15,
        getItemKey: (index) => filteredLogs[index]?.id ?? index,
        measureElement: (element) => Math.ceil(element.getBoundingClientRect().height),
    });

    /** Handles check is at bottom. */
    const checkIsAtBottom = () => {
        const el = logContainerRef.current;
        if (!el) return true;
        return (
            el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_BOTTOM_THRESHOLD_PX
        );
    };

    /** Updates scroll state when the log viewport scrolls. */
    const handleScroll = () => {
        const el = logContainerRef.current;
        if (el) {
            lastKnownLogScrollTopRef.current = el.scrollTop;
        }

        const atBottom = checkIsAtBottom();
        shouldStickToBottomRef.current = atBottom;
        setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
    };

    /** Handles scroll to bottom. */
    const scrollToBottom = () => {
        const el = logContainerRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        lastKnownLogScrollTopRef.current = el.scrollTop;
        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
    };

    useLayoutEffect(() => {
        if (filteredLogs.length === 0) return;

        if (!shouldStickToBottomRef.current) {
            /** Handles restore scroll top. */
            const restoreScrollTop = () => {
                const el = logContainerRef.current;
                if (!el || shouldStickToBottomRef.current) {
                    return;
                }

                el.scrollTop = lastKnownLogScrollTopRef.current;
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

    const sortedLogFiles = [...availableLogFiles].sort(compareLogFileNamesDescending);

    /** Handles clear logs. */
    const clearLogs = () => {
        const existingKeys = Array.from(logsCollection, ([key]) => String(key));
        for (const key of existingKeys) {
            logsCollection.utils.writeDelete(key);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col p-3 sm:p-4 lg:p-6">
            <div className="mb-3 grid grid-cols-1 gap-3 sm:mb-4 md:grid-cols-[minmax(0,1fr)_8rem] lg:grid-cols-[minmax(0,1fr)_8rem_minmax(12rem,24rem)] xl:grid-cols-[minmax(0,1fr)_8rem_minmax(12rem,24rem)_auto] xl:items-center">
                <Select
                    value={selectedFile || ""}
                    onChange={(v) => setSelectedFile(v || null)}
                    options={sortedLogFiles.map((f) => ({
                        value: f.name,
                        label: f.name,
                    }))}
                    placeholder="Select file..."
                    icon={<FileText className="h-4 w-4" />}
                    width="w-full"
                />

                <Select
                    value={lineCount.toString()}
                    onChange={(v) => setLineCount(Number.parseInt(v, 10))}
                    options={LINE_OPTIONS.map((n) => ({
                        value: n.toString(),
                        label: `${n} lines`,
                    }))}
                    width="w-full"
                />

                <Input
                    placeholder="Search logs..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
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
                <div className="text-primary-400 text-sm">
                    {isLoadingContent
                        ? "Loading..."
                        : `${filteredLogs.length} of ${liveLogs.length} entries`}
                </div>

                <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center">
                    <RefreshButton
                        onClick={() => void loadLogContent()}
                        isLoading={isLoadingContent}
                        label="Reload"
                    />
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleExport}
                        disabled={filteredLogs.length === 0}
                    >
                        <Download className="mr-1 h-4 w-4" />
                        Export
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={clearLogs}
                        disabled={liveLogs.length === 0}
                    >
                        Clear
                    </Button>
                </div>
            </div>

            <Card
                className="min-h-0 flex-1 overflow-hidden p-0 sm:p-4"
                variant="bordered"
            >
                <div
                    ref={logContainerRef}
                    onScroll={handleScroll}
                    className="bg-primary-900/50 relative h-full overflow-y-auto font-mono text-[11px] sm:text-xs"
                    style={{ overflowAnchor: "none" }}
                >
                    {!isAtBottom && filteredLogs.length > 0 && (
                        <button
                            type="button"
                            onClick={scrollToBottom}
                            className="bg-accent-500 hover:bg-accent-600 sticky top-2 z-10 float-right mr-2 mb-2 rounded-full px-3 py-1 text-xs text-white shadow-lg"
                        >
                            ↓ Follow
                        </button>
                    )}

                    {filteredLogs.length === 0 ? (
                        <div className="text-primary-400 py-8 text-center">
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
                                const log = filteredLogs[virtualRow.index];
                                if (!log) return null;

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
