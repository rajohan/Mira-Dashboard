import { useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { logsCollection } from "../collections/logs";
import { LevelFilter, LogLine } from "../components/features/logs";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Checkbox } from "../components/ui/Checkbox";
import { Input } from "../components/ui/Input";
import { RefreshButton } from "../components/ui/RefreshButton";
import { Select } from "../components/ui/Select";
import { useLogContent, useLogFiles, useOpenClawSocket } from "../hooks";
import { formatDateStamp } from "../utils/format";
import { LINE_OPTIONS, LOG_LEVELS, parseLogLine } from "../utils/logUtils";

export function Logs() {
    const [autoFollow, setAutoFollow] = useState(true);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState<number>(100);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const logContainerRef = useRef<HTMLDivElement>(null);
    const isAutoScrollingRef = useRef(false);
    const subscribedConnectionIdRef = useRef<number | null>(null);

    // OpenClaw connection (shared WebSocket)
    const { isConnected, connectionId, request } = useOpenClawSocket();

    // Logs from collection using live query
    const { data: logs = [] } = useLiveQuery((q) => q.from({ log: logsCollection }));

    // Queries
    const { data: logFiles = [] } = useLogFiles();
    const { refetch: refetchContent, isFetching: isLoadingContent } = useLogContent(
        selectedFile || null,
        lineCount,
        false
    );

    // Auto-select today's file
    useEffect(() => {
        if (logFiles.length > 0 && !selectedFile) {
            const sorted = [...logFiles].sort((a, b) => b.name.localeCompare(a.name));
            const today = formatDateStamp();
            const todayFile = sorted.find((f) => f.name.includes(today));
            setSelectedFile(todayFile?.name || sorted[0]?.name || "");
        }
    }, [logFiles, selectedFile]);

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

    // Load log content when file/lineCount changes
    const isLoadingRef = useRef(false);
    const initialLoadDoneRef = useRef(false);
    const prevFileRef = useRef<string | null>(null);
    const prevLineCountRef = useRef<number>(100);

    const loadLogContent = async () => {
        if (!selectedFile || isLoadingRef.current) return;
        isLoadingRef.current = true;
        try {
            const result = await refetchContent();
            if (result.data) {
                // Clear existing logs first
                logsCollection.utils.writeBatch(() => {
                    for (const log of logs) {
                        logsCollection.utils.writeDelete(log.ts || log.raw);
                    }
                });

                // Load new logs
                const lines = result.data.split("\n").filter((l) => l.trim());
                logsCollection.utils.writeBatch(() => {
                    for (const line of lines) {
                        const parsed = parseLogLine(line);
                        if (parsed) {
                            logsCollection.utils.writeInsert(parsed);
                        }
                    }
                });
            }
        } finally {
            isLoadingRef.current = false;
        }
    };

    useEffect(() => {
        // Only load if:
        // 1. We have a selected file
        // 2. logFiles are loaded
        // 3. Not already loading
        // 4. Either initial load hasn't happened OR file changed OR lineCount changed
        const fileChanged = selectedFile !== prevFileRef.current;
        const lineCountChanged = lineCount !== prevLineCountRef.current;

        if (
            selectedFile &&
            logFiles.length > 0 &&
            !isLoadingRef.current &&
            (!initialLoadDoneRef.current || fileChanged || lineCountChanged)
        ) {
            initialLoadDoneRef.current = true;
            prevFileRef.current = selectedFile;
            prevLineCountRef.current = lineCount;
            loadLogContent();
        }
    }, [selectedFile, lineCount]);

    const filteredLogs = logs.filter((log) => {
        if (log.level && !levelFilter.has(log.level.toLowerCase())) return false;
        if (search && !log.raw.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const toggleLevel = (level: string) => {
        const newFilter = new Set(levelFilter);
        if (newFilter.has(level)) {
            newFilter.delete(level);
        } else {
            newFilter.add(level);
        }
        setLevelFilter(newFilter);
    };

    const handleExport = () => {
        const content = filteredLogs.map((l) => l.raw).join("\n");
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
    });

    const handleScroll = () => {
        if (!logContainerRef.current || isAutoScrollingRef.current) return;

        const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;

        if (isAtBottom && !autoFollow) {
            setAutoFollow(true);
        } else if (!isAtBottom && autoFollow) {
            setAutoFollow(false);
        }
    };

    // Auto-scroll when new logs arrive
    useEffect(() => {
        if (autoFollow && filteredLogs.length > 0 && logContainerRef.current) {
            isAutoScrollingRef.current = true;

            const scrollToBottom = () => {
                if (logContainerRef.current) {
                    logContainerRef.current.scrollTop =
                        logContainerRef.current.scrollHeight;
                }
                rowVirtualizer.scrollToIndex(filteredLogs.length - 1, { align: "end" });
            };

            requestAnimationFrame(() => {
                scrollToBottom();
                setTimeout(() => {
                    scrollToBottom();
                    isAutoScrollingRef.current = false;
                }, 150);
            });
        }
    }, [filteredLogs.length, autoFollow]);

    // Scroll to bottom on file/lineCount change
    useEffect(() => {
        if (filteredLogs.length > 0 && autoFollow && logContainerRef.current) {
            isAutoScrollingRef.current = true;

            const scrollToBottom = () => {
                if (logContainerRef.current) {
                    logContainerRef.current.scrollTop =
                        logContainerRef.current.scrollHeight;
                }
                rowVirtualizer.scrollToIndex(filteredLogs.length - 1, { align: "end" });
            };

            requestAnimationFrame(() => {
                scrollToBottom();
                setTimeout(() => {
                    scrollToBottom();
                    isAutoScrollingRef.current = false;
                }, 150);
            });
        }
    }, [selectedFile, lineCount]);

    const sortedLogFiles = [...logFiles].sort((a, b) => b.name.localeCompare(a.name));

    const clearLogs = () => {
        // Get all current logs and delete them
        logsCollection.utils.writeBatch(() => {
            for (const log of logs) {
                logsCollection.utils.writeDelete(log.ts || log.raw);
            }
        });
    };

    return (
        <div className="flex h-full min-h-0 flex-col p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <Select
                    value={selectedFile || ""}
                    onChange={(v) => setSelectedFile(v || null)}
                    options={sortedLogFiles.map((f) => ({
                        value: f.name,
                        label: f.name,
                    }))}
                    placeholder="Select file..."
                    icon={<FileText className="h-4 w-4" />}
                    width="min-w-[220px]"
                />

                <Select
                    value={lineCount.toString()}
                    onChange={(v) => setLineCount(Number.parseInt(v, 10))}
                    options={LINE_OPTIONS.map((n) => ({
                        value: n.toString(),
                        label: `${n} lines`,
                    }))}
                    width="min-w-[100px]"
                />

                <Input
                    placeholder="Search logs..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="min-w-[200px] max-w-md"
                />

                <LevelFilter
                    levels={LOG_LEVELS}
                    activeLevels={levelFilter}
                    onToggle={toggleLevel}
                />
            </div>

            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-primary-400">
                    {isLoadingContent
                        ? "Loading..."
                        : `${filteredLogs.length} of ${logs.length} entries`}
                </div>

                <div className="flex items-center gap-3">
                    <Checkbox
                        checked={autoFollow}
                        onChange={setAutoFollow}
                        label="Auto-follow"
                    />

                    <div className="flex items-center gap-2">
                        <RefreshButton
                            onClick={() => {
                                void loadLogContent();
                            }}
                            isLoading={isLoadingContent}
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
                            disabled={logs.length === 0}
                        >
                            Clear
                        </Button>
                    </div>
                </div>
            </div>

            <Card className="flex-1 overflow-hidden" variant="bordered">
                <div
                    ref={logContainerRef}
                    onScroll={handleScroll}
                    className="relative h-full overflow-y-auto bg-primary-900/50 font-mono text-xs"
                >
                    {/* Follow button when scrolled up - inside scroll container */}
                    {!autoFollow && filteredLogs.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                setAutoFollow(true);
                                if (logContainerRef.current) {
                                    logContainerRef.current.scrollTop =
                                        logContainerRef.current.scrollHeight;
                                    rowVirtualizer.scrollToIndex(
                                        filteredLogs.length - 1,
                                        {
                                            align: "end",
                                        }
                                    );
                                }
                            }}
                            className="sticky top-2 z-10 float-right mb-2 mr-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600"
                        >
                            ↓ Follow
                        </button>
                    )}
                    {filteredLogs.length === 0 ? (
                        <div className="py-8 text-center text-primary-400">
                            {logs.length === 0
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
