import { useVirtualizer } from "@tanstack/react-virtual";
import { format } from "date-fns";
import { RefreshCw, Terminal, Wifi, WifiOff, Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { LogLine, FileSelector, LineSelector, LevelFilter } from "../components/features/logs";
import { type LogEntry, type LogFile } from "../types/log";
import { parseLogLine, LOG_LEVELS } from "../utils/logUtils";

export function Logs() {
    const [isConnected, setIsConnected] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [autoFollow, setAutoFollow] = useState(true);
    const [logFiles, setLogFiles] = useState<LogFile[]>([]);
    const [selectedFile, setSelectedFile] = useState<string>("");
    const [lineCount, setLineCount] = useState<number>(100);
    const [showFileDropdown, setShowFileDropdown] = useState(false);
    const [showLineDropdown, setShowLineDropdown] = useState(false);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"])
    );
    const [search, setSearch] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const logContainerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const historyBufferRef = useRef<LogEntry[]>([]);
    const isReceivingHistoryRef = useRef(true);
    const isAutoScrollingRef = useRef(false);

    // Fetch log files on mount
    useEffect(() => {
        const fetchLogFiles = async () => {
            try {
                const response = await fetch("/api/logs/info");
                const data = await response.json();
                if (data.logs) {
                    const sorted = [...data.logs].sort((a, b) =>
                        b.name.localeCompare(a.name)
                    );
                    setLogFiles(sorted);
                    const today = format(new Date(), "yyyy-MM-dd");
                    const todayFile = sorted.find((f: LogFile) => f.name.includes(today));
                    if (todayFile) {
                        setSelectedFile(todayFile.name);
                    } else if (sorted.length > 0) {
                        setSelectedFile(sorted[0].name);
                    }
                }
            } catch (error) {
                console.error("Failed to fetch log files:", error);
            }
        };
        fetchLogFiles();
    }, []);

    const loadLogContent = useCallback(
        async (file: string, lines: number) => {
            setIsLoading(true);
            try {
                const response = await fetch(
                    `/api/logs/content?file=${encodeURIComponent(file)}&lines=${lines}`
                );
                const data = await response.json();
                if (data.content) {
                    const logLines = data.content
                        .split("\n")
                        .filter((l: string) => l.trim());
                    const parsedLogs = logLines
                        .map((line: string) => parseLogLine(line))
                        .filter((l: LogEntry | null): l is LogEntry => l !== null);
                    setLogs(parsedLogs);
                }
            } catch (error) {
                console.error("Failed to load log content:", error);
            } finally {
                setIsLoading(false);
            }
        },
        []
    );

    const handleFileSelect = (file: string) => {
        setSelectedFile(file);
        setShowFileDropdown(false);
        loadLogContent(file, lineCount);
    };

    const handleLineSelect = (lines: number) => {
        setLineCount(lines);
        setShowLineDropdown(false);
        if (selectedFile) {
            loadLogContent(selectedFile, lines);
        }
    };

    const selectedFileRef = useRef<string>(selectedFile);
    const lineCountRef = useRef<number>(lineCount);

    useEffect(() => {
        selectedFileRef.current = selectedFile;
        lineCountRef.current = lineCount;
    }, [selectedFile, lineCount]);

    useEffect(() => {
        if (selectedFile && logFiles.length > 0) {
            loadLogContent(selectedFile, lineCount);
        }
    }, [selectedFile]);

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

    const filteredLogs = useMemo(() => {
        return logs.filter((log) => {
            if (log.level && !levelFilter.has(log.level.toLowerCase())) return false;
            if (search && !log.raw.toLowerCase().includes(search.toLowerCase()))
                return false;
            return true;
        });
    }, [logs, levelFilter, search]);

    const toggleLevel = (level: string) => {
        const newFilter = new Set(levelFilter);
        if (newFilter.has(level)) {
            newFilter.delete(level);
        } else {
            newFilter.add(level);
        }
        setLevelFilter(newFilter);
    };

    const handleRefresh = async () => {
        if (selectedFile) {
            await loadLogContent(selectedFile, lineCount);
        } else {
            try {
                const response = await fetch(`/api/logs/content?lines=${lineCount}`);
                const data = await response.json();
                if (data.content) {
                    const lines = data.content
                        .split("\n")
                        .filter((l: string) => l.trim());
                    const parsedLogs = lines
                        .map((line: string) => parseLogLine(line))
                        .filter((l: LogEntry | null): l is LogEntry => l !== null);
                    setLogs(parsedLogs);
                }
            } catch (error) {
                console.error("Failed to refresh logs:", error);
            }
        }
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

    const handleScroll = useCallback(() => {
        if (!logContainerRef.current || isAutoScrollingRef.current) return;

        const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;

        if (isAtBottom && !autoFollow) {
            setAutoFollow(true);
        } else if (!isAtBottom && autoFollow) {
            setAutoFollow(false);
        }
    }, [autoFollow]);

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
    }, [filteredLogs.length, autoFollow, rowVirtualizer]);

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
                <FileSelector
                    logFiles={logFiles}
                    selectedFile={selectedFile}
                    onSelect={handleFileSelect}
                    isOpen={showFileDropdown}
                    onToggle={() => setShowFileDropdown(!showFileDropdown)}
                />

                <LineSelector
                    lineCount={lineCount}
                    onSelect={handleLineSelect}
                    isOpen={showLineDropdown}
                    onToggle={() => setShowLineDropdown(!showLineDropdown)}
                />

                <div className="relative min-w-[200px] max-w-md flex-1">
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                </div>

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
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                        <input
                            type="checkbox"
                            checked={autoFollow}
                            onChange={(e) => setAutoFollow(e.target.checked)}
                            className="rounded"
                        />
                        Auto-follow
                    </label>

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