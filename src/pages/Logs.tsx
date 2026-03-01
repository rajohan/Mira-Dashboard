import { useEffect, useState, useRef } from "react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Wifi, WifiOff, Terminal, RefreshCw, Download, FileText } from "lucide-react";

interface LogEntry {
    ts?: string;
    level?: string;
    subsystem?: string;
    msg: string;
    raw: string;
}

export function Logs() {
    const [isConnected, setIsConnected] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [autoFollow, setAutoFollow] = useState(true);
    const [logFile, setLogFile] = useState<string | null>(null);
    const [levelFilter, setLevelFilter] = useState<Set<string>>(
        new Set(["trace", "debug", "info", "warn", "error", "fatal"]),
    );
    const [search, setSearch] = useState("");
    const logContainerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const historyBufferRef = useRef<LogEntry[]>([]);
    const isReceivingHistoryRef = useRef(true);

    const levels = ["trace", "debug", "info", "warn", "error", "fatal"];

    const parseLogLine = (line: string): LogEntry | null => {
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
    };

    useEffect(() => {
        const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:${window.location.port || "5173" === window.location.port ? "3100" : window.location.port}/ws`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        isReceivingHistoryRef.current = true;
        historyBufferRef.current = [];

        ws.onopen = () => {
            setIsConnected(true);
            isReceivingHistoryRef.current = true;
            historyBufferRef.current = [];
            ws.send(JSON.stringify({ type: "subscribe", channel: "logs" }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === "log_file") {
                    setLogFile(data.file);
                    return;
                }

                if (data.type === "log_history_complete") {
                    console.log("[Logs] History complete, got", data.count, "lines");
                    isReceivingHistoryRef.current = false;
                    setLogs(historyBufferRef.current.slice(-2000));
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
                                const exists = prev.some((l) => l.raw === parsed.raw);
                                if (exists) return prev;
                                return [...prev.slice(-2000), parsed];
                            });
                        }
                    }
                }
            } catch {
                // Ignore parse errors
            }
        };

        ws.onclose = () => {
            setIsConnected(false);
            isReceivingHistoryRef.current = true;
            historyBufferRef.current = [];
        };
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

    useEffect(() => {
        if (autoFollow && logContainerRef.current) {
            requestAnimationFrame(() => {
                if (logContainerRef.current) {
                    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                }
            });
        }
    }, [logs, autoFollow]);

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

    const getLevelColor = (level?: string): string => {
        const l = (level || "info").toLowerCase();
        switch (l) {
            case "fatal":
                return "text-red-400 bg-red-500/20";
            case "error":
                return "text-red-400 bg-red-500/20";
            case "warn":
                return "text-yellow-400 bg-yellow-500/20";
            case "info":
                return "text-blue-400 bg-blue-500/20";
            case "debug":
                return "text-slate-400 bg-slate-500/20";
            case "trace":
                return "text-slate-500 bg-slate-500/10";
            default:
                return "text-slate-400 bg-slate-500/20";
        }
    };

    const getSubsystemColor = (subsystem?: string): string => {
        if (!subsystem) return "";
        const s = subsystem.toLowerCase();
        switch (s) {
            case "exec":
                return "text-green-400";
            case "tools":
                return "text-orange-400";
            case "agent":
                return "text-purple-400";
            case "gateway":
                return "text-cyan-400";
            case "cron":
                return "text-pink-400";
            case "session":
                return "text-indigo-400";
            case "http":
                return "text-teal-400";
            case "ws":
                return "text-amber-400";
            case "memory":
                return "text-emerald-400";
            default:
                return "text-purple-400";
        }
    };

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

    const handleRefresh = async () => {
        try {
            const response = await fetch("/api/logs/content?lines=100");
            const data = await response.json();
            if (data.content) {
                const lines = data.content.split("\n").filter((l: string) => l.trim());
                const parsedLogs = lines
                    .map((line: string) => parseLogLine(line))
                    .filter((l: LogEntry | null): l is LogEntry => l !== null);
                setLogs(parsedLogs);
            }
            if (data.file) {
                setLogFile(data.file);
            }
        } catch (e) {
            console.error("Failed to refresh logs:", e);
        }
    };

    const handleExport = () => {
        const content = filteredLogs.map((l) => l.raw).join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `logs-${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleClear = () => setLogs([]);

    return (
        <div className="p-6 h-[calc(100vh-2rem)] flex flex-col">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <Terminal className="w-6 h-6 text-slate-400" />
                    <div>
                        <h1 className="text-2xl font-bold">Logs</h1>
                        {logFile && (
                            <div className="flex items-center gap-1 text-sm text-slate-400">
                                <FileText className="w-3 h-3" />
                                <span>{logFile}</span>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {isConnected ? (
                        <span className="flex items-center gap-1 text-green-400 text-sm">
                            <Wifi size={16} /> Connected
                        </span>
                    ) : (
                        <span className="flex items-center gap-1 text-red-400 text-sm">
                            <WifiOff size={16} /> Disconnected
                        </span>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="relative flex-1 min-w-[200px] max-w-md">
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-indigo-500"
                    />
                </div>

                <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                        type="checkbox"
                        checked={autoFollow}
                        onChange={(e) => setAutoFollow(e.target.checked)}
                        className="rounded"
                    />
                    Auto-follow
                </label>

                <div className="flex items-center gap-1">
                    {levels.map((level) => (
                        <button
                            key={level}
                            onClick={() => toggleLevel(level)}
                            className={`px-2 py-0.5 text-xs rounded transition-colors ${
                                levelFilter.has(level)
                                    ? getLevelColor(level)
                                    : "bg-slate-700 text-slate-500"
                            }`}
                        >
                            {level}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={handleRefresh}>
                        <RefreshCw className="w-4 h-4 mr-1" />
                        Refresh
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleExport}
                        disabled={filteredLogs.length === 0}
                    >
                        <Download className="w-4 h-4 mr-1" />
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

            <div className="text-sm text-slate-400 mb-2">
                {filteredLogs.length} of {logs.length} entries
            </div>

            <Card className="flex-1 overflow-hidden" variant="bordered">
                <div
                    ref={logContainerRef}
                    className="h-full overflow-y-auto font-mono text-xs p-4 space-y-0.5 bg-slate-900/50"
                >
                    {filteredLogs.length === 0 ? (
                        <div className="text-slate-400 text-center py-8">
                            {logs.length === 0
                                ? "Waiting for logs..."
                                : "No logs match your filter."}
                        </div>
                    ) : (
                        filteredLogs.map((log, i) => (
                            <div
                                key={i}
                                className="flex items-start gap-2 py-0.5 px-1 -mx-1 rounded hover:bg-slate-800/50"
                            >
                                {log.ts && (
                                    <span className="text-slate-500 whitespace-nowrap flex-shrink-0">
                                        {formatTime(log.ts)}
                                    </span>
                                )}
                                {log.level && (
                                    <span
                                        className={`px-1 py-0.5 text-xs rounded flex-shrink-0 ${getLevelColor(log.level)}`}
                                    >
                                        {log.level.toUpperCase().slice(0, 5)}
                                    </span>
                                )}
                                {log.subsystem && (
                                    <span
                                        className={`whitespace-nowrap flex-shrink-0 ${getSubsystemColor(log.subsystem)}`}
                                    >
                                        [{log.subsystem}]
                                    </span>
                                )}
                                <span className="text-slate-200 flex-1 break-all">
                                    {log.msg}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </Card>
        </div>
    );
}
