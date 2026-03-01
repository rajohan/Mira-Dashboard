import { useEffect, useState, useRef } from "react";
import { useAuthStore } from "../stores/authStore";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import {
    Wifi,
    WifiOff,
    Search,
    Filter,
    Trash2,
    Play,
    Pause,
    Download,
} from "lucide-react";

interface LogEntry {
    id: string;
    timestamp: string;
    level: "info" | "warn" | "error" | "debug";
    source: string;
    message: string;
}

const LOG_LEVELS = ["all", "info", "warn", "error", "debug"] as const;
const LOG_LEVEL_COLORS: Record<string, string> = {
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
    debug: "text-slate-500",
};

const LOG_LEVEL_BG: Record<string, string> = {
    info: "bg-blue-500/20",
    warn: "bg-yellow-500/20",
    error: "bg-red-500/20",
    debug: "bg-slate-500/20",
};

function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("no-NO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

export function Logs() {
    const { token } = useAuthStore();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [filter, setFilter] = useState<string>("all");
    const [search, setSearch] = useState("");
    const [autoScroll, setAutoScroll] = useState(true);
    const logContainerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // Connect to log stream
    useEffect(() => {
        if (!token) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.hostname;
        const port = window.location.port || "5173";
        const wsUrl = protocol + "//" + host + ":" + (port === "5173" ? "3100" : port) + "/ws";

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            setIsConnected(true);
            // Subscribe to logs
            ws.send(JSON.stringify({ type: "subscribe", channel: "logs" }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // Handle log events
                if (data.type === "log" || data.event === "log") {
                    const logData = data.payload || data;
                    const entry: LogEntry = {
                        id: Date.now().toString() + Math.random(),
                        timestamp: logData.timestamp || new Date().toISOString(),
                        level: logData.level || "info",
                        source: logData.source || "system",
                        message: logData.message || JSON.stringify(logData),
                    };
                    
                    setLogs(prev => {
                        const newLogs = [...prev, entry];
                        // Keep last 1000 logs
                        return newLogs.slice(-1000);
                    });
                }
            } catch (e) {
                // Ignore parse errors
            }
        };

        ws.onclose = () => {
            setIsConnected(false);
        };

        ws.onerror = () => {
            setIsConnected(false);
        };

        return () => {
            ws.close();
        };
    }, [token]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (autoScroll && logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    // Filter and search logs
    const filteredLogs = logs.filter(log => {
        if (filter !== "all" && log.level !== filter) return false;
        if (search && !log.message.toLowerCase().includes(search.toLowerCase()) && 
            !log.source.toLowerCase().includes(search.toLowerCase())) {
            return false;
        }
        return true;
    });

    const handleClearLogs = () => {
        setLogs([]);
    };

    const handleExportLogs = () => {
        const content = filteredLogs.map(log => 
            `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`
        ).join("\n");
        
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `logs-${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="p-6 h-[calc(100vh-2rem)] flex flex-col">
            <div className="flex items-center justify-between mb-4">
                <h1 className="text-2xl font-bold">Logs</h1>
                <div className="flex items-center gap-4">
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
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-3 mb-4">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px] max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
                    />
                </div>

                {/* Level filter */}
                <div className="flex items-center gap-1">
                    <Filter className="w-4 h-4 text-slate-400 mr-1" />
                    {LOG_LEVELS.map((level) => (
                        <Button
                            key={level}
                            variant={filter === level ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setFilter(level)}
                        >
                            {level.charAt(0).toUpperCase() + level.slice(1)}
                        </Button>
                    ))}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setAutoScroll(!autoScroll)}
                    >
                        {autoScroll ? <Pause className="w-4 h-4 mr-1" /> : <Play className="w-4 h-4 mr-1" />}
                        {autoScroll ? "Pause" : "Follow"}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleExportLogs}
                        disabled={filteredLogs.length === 0}
                    >
                        <Download className="w-4 h-4 mr-1" />
                        Export
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleClearLogs}
                        disabled={logs.length === 0}
                    >
                        <Trash2 className="w-4 h-4 mr-1" />
                        Clear
                    </Button>
                </div>
            </div>

            {/* Log count */}
            <div className="text-sm text-slate-400 mb-2">
                {filteredLogs.length} of {logs.length} logs
            </div>

            {/* Log viewer */}
            <Card className="flex-1 overflow-hidden" variant="bordered">
                <div
                    ref={logContainerRef}
                    className="h-full overflow-y-auto font-mono text-sm p-4 space-y-1"
                >
                    {filteredLogs.length === 0 ? (
                        <div className="text-slate-400 text-center py-8">
                            {logs.length === 0 ? "No logs yet. Waiting for events..." : "No logs match your filter."}
                        </div>
                    ) : (
                        filteredLogs.map((log) => (
                            <div
                                key={log.id}
                                className="flex items-start gap-3 py-1 hover:bg-slate-800/50 px-2 -mx-2 rounded"
                            >
                                <span className="text-slate-500 text-xs whitespace-nowrap">
                                    {formatTimestamp(log.timestamp)}
                                </span>
                                <span className={"px-1.5 py-0.5 text-xs rounded " + LOG_LEVEL_BG[log.level] + " " + LOG_LEVEL_COLORS[log.level]}>
                                    {log.level.toUpperCase()}
                                </span>
                                <span className="text-slate-400 text-xs whitespace-nowrap">
                                    [{log.source}]
                                </span>
                                <span className="text-slate-200 flex-1 break-all">
                                    {log.message}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </Card>
        </div>
    );
}
