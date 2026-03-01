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
    key: string;
    type: string;
    agentType: string;
    hookName: string;
    kind: string;
    model: string;
    tokenCount: number;
    maxTokens: number;
    createdAt: string | null;
    updatedAt: number | null;
    displayName: string;
    label: string;
    displayLabel: string;
    channel: string;
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

    const handleSessions = useCallback((sessionData: any[]) => {
        console.log("[useOpenClaw] Setting sessions:", sessionData.length);
        setSessions(sessionData);
    }, []);

    const { isConnected, error, connect, disconnect, request } = useOpenClawSocket({
        token: token || "",
        onMessage: handleMessage,
        onSessions: handleSessions,
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
            if (result?.sessions) {
                setSessions(result.sessions);
            }
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

    const deleteSession = useCallback(async (sessionKey: string) => {
        if (!isConnected) throw new Error("Not connected");
        console.log("[useOpenClaw] Deleting session:", sessionKey);
        await request("sessions.delete", { 
            key: sessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
        });
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
        deleteSession,
        request,
    };
}
