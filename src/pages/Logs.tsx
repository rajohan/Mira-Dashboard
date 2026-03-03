import { useVirtualizer } from "@tanstack/react-virtual";
import { format } from "date-fns";
import { RefreshCw, Terminal, Wifi, WifiOff, Download, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Checkbox } from "../components/ui/Checkbox";
import { Input } from "../components/ui/Input";
import { LogLine, LevelFilter } from "../components/features/logs";
import { Select } from "../components/ui/Select";
import { useLogFiles, useLogContent } from "../hooks";
import { type LogEntry } from "../types/log";
import { parseLogLine, LOG_LEVELS, LINE_OPTIONS } from "../utils/logUtils";

export function Logs() {
    const [autoFollow, setAutoFollow] = useState(true);
    const [selectedFile, setSelectedFile] = useState<string>("");
    const [lineCount, setLineCount] = useState<number>(100);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const logContainerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const historyBufferRef = useRef<LogEntry[]>([]);
    const isReceivingHistoryRef = useRef(true);
    const isAutoScrollingRef = useRef(false);

    // Queries
    const { data: logFiles = [] } = useLogFiles();
    const { refetch: refetchContent, isFetching: isLoadingContent } = useLogContent(
        selectedFile || null,
        lineCount,
        false // Don't auto-fetch, we use it manually
    );

    // Auto-select today's file
    useEffect(() => {
        if (logFiles.length > 0 && !selectedFile) {
            const sorted = [...logFiles].sort((a, b) => b.name.localeCompare(a.name));
            const today = format(new Date(), "yyyy-MM-dd");
            const todayFile = sorted.find((f) => f.name.includes(today));
            setSelectedFile(todayFile?.name || sorted[0]?.name || "");
        }
    }, [logFiles, selectedFile]);

    // Load log content
    const loadLogContent = async () => {
        if (!selectedFile) return;
        const result = await refetchContent();
        if (result.data) {
            const logLines = result.data.split("\n").filter((l) => l.trim());
            const parsedLogs = logLines
                .map((line) => parseLogLine(line))
                .filter((l): l is LogEntry => l !== null);
            setLogs(parsedLogs);
        }
    };

    // Load content when file changes
    useEffect(() => {
        if (selectedFile && logFiles.length > 0) {
            loadLogContent();
        }
    }, [selectedFile, lineCount]);

    const handleFileSelect = (file: string) => {
        setSelectedFile(file);
    };

    const handleLineSelect = (lines: number) => {
        setLineCount(lines);
    };

    const selectedFileRef = useRef<string>(selectedFile);
    const lineCountRef = useRef<number>(lineCount);

    useEffect(() => {
        selectedFileRef.current = selectedFile;
        lineCountRef.current = lineCount;
    }, [selectedFile, lineCount]);

    // WebSocket for real-time logs
    useEffect(() => {
        const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:${window.location.port || "5173" === window.location.port ? "3100" : window.location.port}/ws`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        isReceivingHistoryRef.current = true;
        historyBufferRef.current = [];

        ws.addEventListener("open", () => {
            setIsConnected(true);
            isReceivingHistoryRef.current = true;
            historyBufferRef.current = [];
            ws.send(JSON.stringify({ type: "subscribe", channel: "logs" }));
        });

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === "log_history_complete") {
                    isReceivingHistoryRef.current = false;
                    const maxLines = lineCountRef.current;
                    setLogs(historyBufferRef.current.slice(-maxLines));
                    historyBufferRef.current = [];
                    return;
                }

                if (
                    (data.type === "log_entry" || data.type === "log") &&
                    (data.line || data.raw)
                ) {
                    const line = (data.raw || data.line || "").trim();
                    const parsed = parseLogLine(line);
                    if (parsed) {
                        if (isReceivingHistoryRef.current) {
                            historyBufferRef.current.push(parsed);
                        } else {
                            setLogs((prev) => {
                                const maxLines = lineCountRef.current;
                                const exists = prev.some((l) => l.raw === parsed.raw);
                                if (exists) return prev;
                                return [...prev.slice(-(maxLines - 1)), parsed];
                            });
                        }
                    }
                }
            } catch {
                // Ignore parse errors
            }
        };

        ws.addEventListener("close", () => {
            setIsConnected(false);
            isReceivingHistoryRef.current = true;
            historyBufferRef.current = [];
        });
        ws.onerror = () => {
            setIsConnected(false);
            isReceivingHistoryRef.current = true;
            historyBufferRef.current = [];
        };

        return () => {
            ws.send(JSON.stringify({ type: "unsubscribe", channel: "logs" }));
            ws.close();
        };
    }, []);

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

    const handleRefresh = () => {
        loadLogContent();
    };

    const handleExport = () => {
        const content = filteredLogs.map((l) => l.raw).join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${selectedFile || "logs"}-${format(new Date(), "yyyy-MM-dd")}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleClear = () => setLogs([]);

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

    useEffect(() => {
        if (autoFollow && filteredLogs.length > 0 && logContainerRef.current) {
            isAutoScrollingRef.current = true;

            const scrollToBottom = () => {
                if (logContainerRef.current) {
                    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
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

    useEffect(() => {
        if (filteredLogs.length > 0 && autoFollow && logContainerRef.current) {
            isAutoScrollingRef.current = true;

            const scrollToBottom = () => {
                if (logContainerRef.current) {
                    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
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
    const isLoading = isLoadingContent;

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col p-6">
            <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Terminal className="h-6 w-6 text-slate-400" />
                    <h1 className="text-2xl font-bold">Logs</h1>
                </div>
                <div className="flex items-center gap-2">
                    {isConnected ? (
                        <span className="flex items-center gap-1 text-sm text-green-400">
                            <Wifi size={16} /> Connected
                        </span>
                    ) : (
                        <span className="flex items-center gap-1 text-sm text-red-400">
                            <WifiOff size={16} /> Disconnected
                        </span>
                    )}
                </div>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-3">
                <Select
                    value={selectedFile}
                    onChange={handleFileSelect}
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
                    onChange={(v) => handleLineSelect(parseInt(v, 10))}
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
                <div className="text-sm text-slate-400">
                    {isLoading
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
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleRefresh}
                            disabled={isLoading}
                        >
                            <RefreshCw
                                className={`mr-1 h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                            />
                            Refresh
                        </Button>
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
                            onClick={handleClear}
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
                    className="h-full overflow-y-auto bg-slate-900/50 font-mono text-xs"
                >
                    {filteredLogs.length === 0 ? (
                        <div className="py-8 text-center text-slate-400">
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