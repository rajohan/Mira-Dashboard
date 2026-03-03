import { useCallback, useEffect, useRef, useState } from "react";

import type { LogEntry } from "../types/log";
import { parseLogLine } from "../utils/logUtils";
import { getWebSocketUrl } from "../utils/websocket";

interface UseLogStreamOptions {
    lineCount: number;
}

export function useLogStream({ lineCount }: UseLogStreamOptions) {
    const [isConnected, setIsConnected] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const wsRef = useRef<WebSocket | null>(null);
    const historyBufferRef = useRef<LogEntry[]>([]);
    const isReceivingHistoryRef = useRef(true);
    const lineCountRef = useRef(lineCount);

    useEffect(() => {
        lineCountRef.current = lineCount;
    }, [lineCount]);

    const clearLogs = useCallback(() => setLogs([]), []);

    const setLogsFromContent = useCallback(
        (content: string) => {
            const logLines = content.split("\n").filter((l) => l.trim());
            const parsedLogs = logLines
                .map((line) => parseLogLine(line))
                .filter((l): l is LogEntry => l !== null);
            setLogs(parsedLogs);
        },
        []
    );

    useEffect(() => {
        const wsUrl = getWebSocketUrl();
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

    return {
        isConnected,
        logs,
        clearLogs,
        setLogsFromContent,
    };
}
