import { useOpenClawSocket } from "./useOpenClawSocket";
import { useState, useCallback } from "react";

export interface AgentStatus {
    version: string;
    uptime: number;
    model: string;
    sessionCount: number;
    tokenUsage: {
        total: number;
        byModel: Record<string, number>;
    };
}

export interface Session {
    id: string;
    agentId: string;
    agentName: string;
    type: "main" | "hook" | "cron" | "subagent";
    model: string;
    tokenCount: number;
    createdAt: string;
    updatedAt: string;
}

export function useOpenClaw(token: string | null) {
    const [status, setStatus] = useState<AgentStatus | null>(null);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [agents, setAgents] = useState<any[]>([]);
    const [logs, setLogs] = useState<any[]>([]);

    const handleMessage = useCallback((method: string, params: any) => {
        switch (method) {
            case "status":
                setStatus(params);
                break;
            case "sessions":
                setSessions(params);
                break;
            case "sessions.list":
                setSessions(params?.sessions || []);
                break;
            case "agents":
                setAgents(params);
                break;
            case "agents.list":
                setAgents(params?.agents || []);
                break;
            case "log":
                setLogs(prev => [...prev.slice(-100), params]);
                break;
        }
    }, []);

    const { isConnected, error, connect, disconnect, request } = useOpenClawSocket({
        token: token || "",
        onMessage: handleMessage,
    });

    const fetchStatus = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await request("status");
            setStatus(result);
        } catch (e) {
            console.error("Failed to fetch status:", e);
        }
    }, [isConnected, request]);

    const fetchSessions = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await request("sessions.list");
            setSessions(result?.sessions || []);
        } catch (e) {
            console.error("Failed to fetch sessions:", e);
        }
    }, [isConnected, request]);

    const fetchAgents = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await request("agents.list");
            setAgents(result?.agents || []);
        } catch (e) {
            console.error("Failed to fetch agents:", e);
        }
    }, [isConnected, request]);

    const killSession = useCallback(async (sessionId: string) => {
        if (!isConnected) return;
        await request("sessions.kill", { sessionId });
        await fetchSessions();
    }, [isConnected, request, fetchSessions]);

    return {
        isConnected,
        error,
        connect,
        disconnect,
        status,
        sessions,
        agents,
        logs,
        fetchStatus,
        fetchSessions,
        fetchAgents,
        killSession,
        request,
    };
}
