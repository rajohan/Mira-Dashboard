import { useState } from "react";

import { useOpenClawSocket } from "./useOpenClawSocket";

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

export interface AgentInfo {
    id: string;
    name: string;
    model?: string;
    status?: string;
}

export interface LogEntry {
    level: string;
    message: string;
    timestamp: number;
    [key: string]: unknown;
}

export function useOpenClaw(token: string | null) {
    const [status, setStatus] = useState<AgentStatus | null>(null);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [agents, setAgents] = useState<AgentInfo[]>([]);
    const [logs, setLogs] = useState<LogEntry[]>([]);

    const handleMessage = (method: string, params: Record<string, unknown>) => {
        switch (method) {
            case "status": {
                setStatus(params as unknown as AgentStatus);
                break;
            }
            case "agents": {
                setAgents(params as unknown as AgentInfo[]);
                break;
            }
            case "agents.list": {
                setAgents((params as { agents?: AgentInfo[] }).agents || []);
                break;
            }
            case "log": {
                setLogs((prev) => [...prev.slice(-100), params as unknown as LogEntry]);
                break;
            }
        }
    };

    const handleSessions = (sessionData: Record<string, unknown>[]) => {
        console.log("[useOpenClaw] Setting sessions:", sessionData.length);
        setSessions(sessionData as unknown as Session[]);
    };

    const { isConnected, error, connect, disconnect, request } = useOpenClawSocket({
        token: token || "",
        onMessage: handleMessage,
        onSessions: handleSessions,
    });

    const fetchStatus = async () => {
        if (!isConnected) return;
        try {
            const result = await request("status");
            setStatus(result as AgentStatus);
        } catch (error_) {
            console.error("Failed to fetch status:", error_);
        }
    };

    const fetchSessions = async () => {
        if (!isConnected) return;
        try {
            const result = (await request("sessions.list")) as { sessions?: Session[] };
            if (result?.sessions) {
                setSessions(result.sessions);
            }
        } catch (error_) {
            console.error("Failed to fetch sessions:", error_);
        }
    };

    const fetchAgents = async () => {
        if (!isConnected) return;
        try {
            const result = (await request("agents.list")) as { agents?: AgentInfo[] };
            setAgents(result?.agents || []);
        } catch (error_) {
            console.error("Failed to fetch agents:", error_);
        }
    };

    const deleteSession = async (sessionKey: string) => {
        if (!isConnected) throw new Error("Not connected");
        console.log("[useOpenClaw] Deleting session:", sessionKey);
        await request("sessions.delete", {
            key: sessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
        });
        await fetchSessions();
    };

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