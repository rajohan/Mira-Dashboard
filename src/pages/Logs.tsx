import { useVirtualizer } from "@tanstack/react-virtual";
import { format } from "date-fns";
import {
    ChevronDown,
    Download,
    FileText,
    RefreshCw,
    Terminal,
    Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { parseLogLine, formatLogTime, formatFileSize, getLevelColor, getSubsystemColor, LINE_OPTIONS, LOG_LEVELS } from "../utils/logUtils";
import { type LogEntry, type LogFile } from "../types/log";
import { useAuthStore } from "../stores/authStore";

export function Logs() {
    const { token } = useAuthStore();
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
                    const sorted = [...data.logs].sort((a: LogFile, b: LogFile) =>
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

    // Load log content from file
    const loadLogContent = useCallback(async (filename: string, lines: number) => {
        setIsLoading(true);
        try {
            const response = await fetch(
                `/api/logs/content?file=${encodeURIComponent(filename)}&lines=${lines}`
            );
            const data = await response.json();
            if (data.content) {
                const logLines = data.content.split("\n").filter((l: string) => l.trim());
                const parsedLogs = logLines
                    .map((line: string) => parseLogLine(line))
                    .filter((l: LogEntry | null): l is LogEntry => l !== null);
                setLogs(parsedLogs);
                historyBufferRef.current = [];
                isReceivingHistoryRef.current = true;
            }
        } catch (error) {
            console.error("Failed to load log content:", error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // WebSocket for live logs
    useEffect(() => {
        if (!token || selectedFile) return;

        const wsUrl = new URL(window.location.href);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.pathname = "/ws";

        const ws = new WebSocket(wsUrl.toString());
        wsRef.current = ws;

        ws.onopen = () => {
            setIsConnected(true);
            ws.send(JSON.stringify({ type: "auth", token }));
            ws.send(JSON.stringify({ type: "subscribe", channel: "logs" }));
            ws.send(JSON.stringify({ type: "history", channel: "logs" }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "history" && Array.isArray(data.messages)) {
                    historyBufferRef.current = data.messages
                        .map((m: { content?: string }) => m.content)
                        .filter((c: unknown): c is string => typeof c === "string")
                        .map((line: string) => parseLogLine(line))
                        .filter((l: LogEntry | null): l is LogEntry => l !== null)
                        .reverse();
                    setLogs([...historyBufferRef.current]);
                    isReceivingHistoryRef.current = false;
                } else if (data.type === "log") {
                    const content = data.data?.content || data.content;
                    if (content) {
                        const entry = parseLogLine(content);
                        if (entry) {
                            setLogs((prev) => {
                                if (isReceivingHistoryRef.current) {
                                    historyBufferRef.current.push(entry);
                                    return [...historyBufferRef.current];
                                }
                                return [...prev, entry];
                            });
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to parse WS message:", e);
            }
        };

        ws.onclose = () => setIsConnected(false);
        ws.onerror = () => setIsConnected(false);

        return () => {
            ws.close();
        };
    }, [token, selectedFile]);

    // Filter logs
    const filteredLogs = useMemo(() => {
        return logs.filter((log) => {
            if (!levelFilter.has(log.level || "info")) return false;
            if (search) {
                const s = search.toLowerCase();
                return (
                    log.msg.toLowerCase().includes(s) ||
                    (log.subsystem?.toLowerCase().includes(s) ?? false) ||
                    log.raw.toLowerCase().includes(s)
                );
            }
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

    // Virtualizer for efficient rendering
    const rowVirtualizer = useVirtualizer({
        count: filteredLogs.length,
        getScrollElement: () => logContainerRef.current,
        estimateSize: () => 22,
        overscan: 15,
    });

    // Handle scroll
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

    // Auto-scroll
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
    }, [filteredLogs.length, autoFollow, rowVirtualizer]);

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col p-6">
            <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Terminal className="h-6 w-6 text-slate-400" />
                    <h1 className="text-2xl font-bold">Logs</h1>
                </div>
                <div className="flex items-center gap-2">
                    {isConnected && !selectedFile && (
                        <span className="flex items-center gap-1 text-sm text-green-400">
                            <Wifi size={14} /> Live
                        </span>
                    )}
                    {selectedFile && (
                        <span className="flex items-center gap-1 text-sm text-blue-400">
                            <FileText size={14} /> {selectedFile}
                        </span>
                    )}
                </div>
            </div>

            {/* Controls */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
                {/* File dropdown */}
                <div className="relative">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            setShowFileDropdown(!showFileDropdown);
                            setShowLineDropdown(false);
                        }}
                    >
                        <FileText className="mr-1 h-4 w-4" />
                        {selectedFile || "Live Logs"}
                        <ChevronDown className="ml-1 h-3 w-3" />
                    </Button>
                    {showFileDropdown && (
                        <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-64 overflow-auto rounded-lg border border-slate-600 bg-slate-800 shadow-lg">
                            <button
                                className={
                                    "w-full px-3 py-2 text-left text-sm hover:bg-slate-700 " +
                                    (!selectedFile ? "bg-accent-500/20 text-accent-400" : "text-slate-200")
                                }
                                onClick={() => {
                                    setSelectedFile("");
                                    setShowFileDropdown(false);
                                    setLogs([]);
                                }}
                            >
                                Live Logs (WebSocket)
                            </button>
                            <div className="border-t border-slate-600" />
                            {logFiles.map((file) => (
                                <button
                                    key={file.name}
                                    className={
                                        "w-full px-3 py-2 text-left text-sm hover:bg-slate-700 " +
                                        (selectedFile === file.name
                                            ? "bg-accent-500/20 text-accent-400"
                                            : "text-slate-200")
                                    }
                                    onClick={() => {
                                        setSelectedFile(file.name);
                                        setShowFileDropdown(false);
                                        loadLogContent(file.name, lineCount);
                                    }}
                                >
                                    <div className="flex items-center justify-between">
                                        <span>{file.name}</span>
                                        <span className="text-xs text-slate-400">
                                            {formatFileSize(file.size)}
                                        </span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Line count dropdown */}
                <div className="relative">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            setShowLineDropdown(!showLineDropdown);
                            setShowFileDropdown(false);
                        }}
                    >
                        {lineCount} lines
                        <ChevronDown className="ml-1 h-3 w-3" />
                    </Button>
                    {showLineDropdown && (
                        <div className="absolute left-0 top-full z-50 mt-1 min-w-[100px] rounded-lg border border-slate-600 bg-slate-800 shadow-lg">
                            {LINE_OPTIONS.map((n) => (
                                <button
                                    key={n}
                                    className={
                                        "w-full px-3 py-2 text-left text-sm hover:bg-slate-700 " +
                                        (lineCount === n
                                            ? "bg-accent-500/20 text-accent-400"
                                            : "text-slate-200")
                                    }
                                    onClick={() => {
                                        setLineCount(n);
                                        setShowLineDropdown(false);
                                        if (selectedFile) {
                                            loadLogContent(selectedFile, n);
                                        }
                                    }}
                                >
                                    {n} lines
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Level filters */}
                {LOG_LEVELS.map((level) => (
                    <Button
                        key={level}
                        variant={levelFilter.has(level) ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => toggleLevel(level)}
                        className="text-xs"
                    >
                        {level.toUpperCase()}
                    </Button>
                ))}

                {/* Search */}
                <input
                    type="text"
                    placeholder="Search..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="rounded-lg border border-slate-600 bg-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:border-accent-500 focus:outline-none"
                />

                {/* Actions */}
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={isLoading}
                >
                    <RefreshCw className={"h-4 w-4 " + (isLoading ? "animate-spin" : "")} />
                </Button>
                <Button variant="secondary" size="sm" onClick={handleExport}>
                    <Download className="h-4 w-4" />
                </Button>
            </div>

            {/* Log display */}
            <Card
                variant="bordered"
                className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-900 p-0"
            >
                <div
                    ref={logContainerRef}
                    onScroll={handleScroll}
                    className="flex-1 overflow-auto font-mono text-xs"
                >
                    <div
                        style={{
                            height: rowVirtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const log = filteredLogs[virtualRow.index];
                            return (
                                <div
                                    key={virtualRow.key}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        height: virtualRow.size,
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                    className="flex items-start gap-2 border-b border-slate-800/50 px-2 py-0.5 hover:bg-slate-800/30"
                                >
                                    {log.ts && (
                                        <span className="flex-shrink-0 text-slate-500">
                                            {formatLogTime(log.ts)}
                                        </span>
                                    )}
                                    {log.level && (
                                        <span
                                            className={
                                                "flex-shrink-0 rounded px-1 py-0.5 text-xs font-medium " +
                                                getLevelColor(log.level)
                                            }
                                        >
                                            {log.level.toUpperCase()}
                                        </span>
                                    )}
                                    {log.subsystem && (
                                        <span
                                            className={
                                                "flex-shrink-0 " +
                                                getSubsystemColor(log.subsystem)
                                            }
                                        >
                                            [{log.subsystem}]
                                        </span>
                                    )}
                                    <span className="flex-1 break-all text-slate-200">
                                        {log.msg}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </Card>

            {/* Status */}
            <div className="mt-2 text-xs text-slate-400">
                {filteredLogs.length} logs
                {autoFollow && " • Auto-follow"}
            </div>
        </div>
    );
}