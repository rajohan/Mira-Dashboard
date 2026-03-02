import { useVirtualizer } from "@tanstack/react-virtual";
import {
    ChevronDown,
    Download,
    FileText,
    RefreshCw,
    Terminal,
    Wifi,
    WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

interface LogEntry {
    ts?: string;
    level?: string;
    subsystem?: string;
    msg: string;
    raw: string;
}

interface LogFile {
    name: string;
    size: number;
    modified: string;
}

const LINE_OPTIONS = [100, 500, 1000, 2000, 5000];

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
    const isAutoScrollingRef = useRef(false); // Track programmatic scroll

    const levels = ["trace", "debug", "info", "warn", "error", "fatal"];

    const parseLogLine = useCallback((line: string): LogEntry | null => {
        if (!line || !line.trim()) return null;

        let jsonStr = line;

        if (!line.startsWith("{")) {
            const braceIdx = line.indexOf("{");
            if (braceIdx !== -1) {
                jsonStr = line.slice(braceIdx);
            }
        }

        try {
            const parsed = JSON.parse(jsonStr);

            const level =
                parsed._meta?.logLevelName || parsed.level || parsed.lvl || "INFO";
            const ts = parsed._meta?.date || parsed.time || parsed.timestamp;

            let subsystem = "";
            let msg = "";

            if (parsed[0]) {
                if (typeof parsed[0] === "string" && parsed[0].startsWith("{")) {
                    try {
                        const subParsed = JSON.parse(parsed[0]);
                        subsystem = subParsed.subsystem || subParsed.module || "";
                    } catch {
                        msg = String(parsed[0]);
                    }
                } else if (typeof parsed[0] === "string") {
                    msg = parsed[0];
                }
            }

            if (parsed[1] && !msg) {
                if (typeof parsed[1] === "string") {
                    msg = parsed[1];
                } else if (parsed[2] && typeof parsed[2] === "string") {
                    msg = parsed[2];
                } else if (typeof parsed[1] === "object") {
                    msg = JSON.stringify(parsed[1]);
                }
            }

            if (!msg) {
                msg = parsed.msg || parsed.message || line;
            }

            // Ensure msg is always a string
            if (typeof msg !== "string") {
                msg = JSON.stringify(msg);
            }

            if (!subsystem && msg) {
                const bracketMatch = msg.match(/^\[(\w+)\]\s*/);
                if (bracketMatch) {
                    subsystem = bracketMatch[1];
                    msg = msg.slice(bracketMatch[0].length);
                } else {
                    const colonMatch = msg.match(/^(\w+):\s*/);
                    if (colonMatch) {
                        subsystem = colonMatch[1];
                        msg = msg.slice(colonMatch[0].length);
                    }
                }
            }

            return { ts, level: level.toLowerCase(), subsystem, msg, raw: line };
        } catch {
            return { msg: line, raw: line };
        }
    }, []);

    // Fetch log files on mount
    useEffect(() => {
        const fetchLogFiles = async () => {
            try {
                const response = await fetch("/api/logs/info");
                const data = await response.json();
                if (data.logs) {
                    // Sort by filename descending (newest first) - filenames are openclaw-YYYY-MM-DD.log
                    const sorted = [...data.logs].sort((a, b) =>
                        b.name.localeCompare(a.name)
                    );
                    setLogFiles(sorted);
                    // Select today's file by default
                    const today = new Date().toISOString().split("T")[0];
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

    // Load log content when file or line count changes
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
        [parseLogLine]
    );

    // Handle file selection
    const handleFileSelect = (file: string) => {
        setSelectedFile(file);
        setShowFileDropdown(false);
        loadLogContent(file, lineCount);
    };

    // Handle line count selection
    const handleLineSelect = (lines: number) => {
        setLineCount(lines);
        setShowLineDropdown(false);
        if (selectedFile) {
            loadLogContent(selectedFile, lines);
        }
    };

    // Track selected file and line count for WebSocket loading
    const selectedFileRef = useRef<string>(selectedFile);
    const lineCountRef = useRef<number>(lineCount);

    // Keep refs in sync
    useEffect(() => {
        selectedFileRef.current = selectedFile;
        lineCountRef.current = lineCount;
    }, [selectedFile, lineCount]);

    // Load log content when file selection changes
    useEffect(() => {
        if (selectedFile && logFiles.length > 0) {
            loadLogContent(selectedFile, lineCount);
        }
        // Intentionally only run when selectedFile changes
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
                    // Use lineCount from ref to respect user's selection
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
                                // Use lineCount from ref for live logs too
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
    }, [parseLogLine]);

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
        a.download = `${selectedFile || "logs"}-${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleClear = () => setLogs([]);

    const formatTime = (ts?: string): string => {
        if (!ts) return "";
        try {
            const date = new Date(ts);
            return date.toLocaleTimeString("no-NO", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        } catch {
            return ts;
        }
    };

    const formatFileSize = (bytes: number): string => {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    };

    const getLevelColor = (level?: string): string => {
        const l = (level || "info").toLowerCase();
        switch (l) {
            case "fatal": {
                return "text-red-400 bg-red-500/20";
            }
            case "error": {
                return "text-red-400 bg-red-500/20";
            }
            case "warn": {
                return "text-yellow-400 bg-yellow-500/20";
            }
            case "info": {
                return "text-blue-400 bg-blue-500/20";
            }
            case "debug": {
                return "text-slate-400 bg-slate-500/20";
            }
            case "trace": {
                return "text-slate-500 bg-slate-500/10";
            }
            default: {
                return "text-slate-400 bg-slate-500/20";
            }
        }
    };

    const getSubsystemColor = (subsystem?: string): string => {
        if (!subsystem) return "";
        const s = subsystem.toLowerCase();
        switch (s) {
            case "exec": {
                return "text-green-400";
            }
            case "tools": {
                return "text-orange-400";
            }
            case "agent": {
                return "text-purple-400";
            }
            case "gateway": {
                return "text-cyan-400";
            }
            case "cron": {
                return "text-pink-400";
            }
            case "session": {
                return "text-indigo-400";
            }
            case "http": {
                return "text-teal-400";
            }
            case "ws": {
                return "text-amber-400";
            }
            case "memory": {
                return "text-emerald-400";
            }
            default: {
                return "text-purple-400";
            }
        }
    };

    // Virtualizer for efficient rendering with variable row heights
    const rowVirtualizer = useVirtualizer({
        count: filteredLogs.length,
        getScrollElement: () => logContainerRef.current,
        estimateSize: () => 22, // Base height
        overscan: 15,
    });

    // Handle scroll - re-enable autoFollow when user scrolls to bottom
    const handleScroll = useCallback(() => {
        if (!logContainerRef.current || isAutoScrollingRef.current) return;

        const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 30; // 30px threshold

        if (isAtBottom && !autoFollow) {
            setAutoFollow(true);
        } else if (!isAtBottom && autoFollow) {
            // User scrolled up - disable autoFollow
            setAutoFollow(false);
        }
    }, [autoFollow]);

    // Auto-scroll to bottom when logs load or autoFollow is enabled
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

    // Handle file/line count changes - scroll to bottom after loading new content
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
                {/* File selector dropdown */}
                <div className="relative">
                    <button
                        onClick={() => setShowFileDropdown(!showFileDropdown)}
                        className="flex min-w-[220px] items-center gap-2 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm transition-colors hover:border-indigo-500"
                    >
                        <FileText className="h-4 w-4 flex-shrink-0 text-slate-400" />
                        <span className="flex-1 truncate text-left">
                            {selectedFile || "Select file..."}
                        </span>
                        <ChevronDown
                            className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${showFileDropdown ? "rotate-180" : ""}`}
                        />
                    </button>
                    {showFileDropdown && (
                        <div className="absolute left-0 top-full z-10 mt-1 max-h-60 min-w-[300px] overflow-y-auto rounded border border-slate-700 bg-slate-800 shadow-lg">
                            {logFiles.length === 0 ? (
                                <div className="px-3 py-2 text-sm text-slate-400">
                                    No log files found
                                </div>
                            ) : (
                                logFiles.map((file) => (
                                    <button
                                        key={file.name}
                                        onClick={() => handleFileSelect(file.name)}
                                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-700 ${
                                            selectedFile === file.name
                                                ? "bg-slate-700 text-indigo-400"
                                                : ""
                                        }`}
                                    >
                                        <span className="truncate">{file.name}</span>
                                        <span className="flex-shrink-0 text-xs text-slate-500">
                                            {formatFileSize(file.size)}
                                        </span>
                                    </button>
                                ))
                            )}
                        </div>
                    )}
                </div>

                {/* Line count selector dropdown */}
                <div className="relative">
                    <button
                        onClick={() => setShowLineDropdown(!showLineDropdown)}
                        className="flex min-w-[100px] items-center gap-2 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm transition-colors hover:border-indigo-500"
                    >
                        <span>{lineCount} lines</span>
                        <ChevronDown
                            className={`h-4 w-4 text-slate-400 transition-transform ${showLineDropdown ? "rotate-180" : ""}`}
                        />
                    </button>
                    {showLineDropdown && (
                        <div className="absolute left-0 top-full z-10 mt-1 rounded border border-slate-700 bg-slate-800 shadow-lg">
                            {LINE_OPTIONS.map((lines) => (
                                <button
                                    key={lines}
                                    onClick={() => handleLineSelect(lines)}
                                    className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-700 ${
                                        lineCount === lines
                                            ? "bg-slate-700 text-indigo-400"
                                            : ""
                                    }`}
                                >
                                    {lines} lines
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="relative min-w-[200px] max-w-md flex-1">
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                </div>

                {/* Level filters */}
                <div className="flex items-center gap-1">
                    {levels.map((level) => (
                        <button
                            key={level}
                            onClick={() => toggleLevel(level)}
                            className={`rounded px-2 py-0.5 text-xs transition-colors ${
                                levelFilter.has(level)
                                    ? getLevelColor(level)
                                    : "bg-slate-700 text-slate-500"
                            }`}
                        >
                            {level}
                        </button>
                    ))}
                </div>
            </div>

            {/* Second row: Auto-follow and action buttons */}
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
                                        className="flex items-start gap-2 px-4 py-0.5 hover:bg-slate-800/50"
                                    >
                                        {log.ts && (
                                            <span className="flex-shrink-0 whitespace-nowrap text-slate-500">
                                                {formatTime(log.ts)}
                                            </span>
                                        )}
                                        {log.level && (
                                            <span
                                                className={`flex-shrink-0 rounded px-1 py-0.5 text-xs ${getLevelColor(log.level)}`}
                                            >
                                                {log.level.toUpperCase().slice(0, 5)}
                                            </span>
                                        )}
                                        {log.subsystem && (
                                            <span
                                                className={`flex-shrink-0 whitespace-nowrap ${getSubsystemColor(log.subsystem)}`}
                                            >
                                                [{log.subsystem}]
                                            </span>
                                        )}
                                        <span className="flex-1 whitespace-pre-wrap break-all text-slate-200">
                                            {log.msg}
                                        </span>
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
