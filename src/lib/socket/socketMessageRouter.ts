import { z } from "zod";

import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";
import type { AgentInfo, Session } from "../../types/session";

const baseMessageSchema = z.object({
    type: z.string(),
});

const responsePayloadWithSessionsSchema = z.object({
    sessions: z.array(z.unknown()),
});

interface SocketMessage {
    type?: string;
    event?: string;
    payload?: unknown;
    sessions?: Session[];
    line?: string;
    gatewayConnected?: boolean;
}

function extractSessionsFromPayload(payload: unknown): Session[] {
    if (Array.isArray(payload)) {
        return payload as Session[];
    }

    const parsed = responsePayloadWithSessionsSchema.safeParse(payload);
    if (parsed.success) {
        return parsed.data.sessions as Session[];
    }

    if (payload && typeof payload === "object") {
        const maybe = payload as { result?: unknown; data?: unknown };

        const fromResult = responsePayloadWithSessionsSchema.safeParse(maybe.result);
        if (fromResult.success) {
            return fromResult.data.sessions as Session[];
        }

        const fromData = responsePayloadWithSessionsSchema.safeParse(maybe.data);
        if (fromData.success) {
            return fromData.data.sessions as Session[];
        }
    }

    return [];
}

export function routeSocketMessage(raw: unknown): boolean | undefined {
    const validated = baseMessageSchema.safeParse(raw);
    if (!validated.success) {
        return undefined;
    }

    const data = raw as SocketMessage;

    if (data.type === "state") {
        if (data.sessions) {
            replaceSessionsFromWebSocket(data.sessions);
        }
        return data.gatewayConnected ?? true;
    }

    if (data.type === "connected") {
        return data.gatewayConnected ?? true;
    }

    if (data.type === "disconnected") {
        return false;
    }

    if (data.type === "sessions" && data.sessions) {
        replaceSessionsFromWebSocket(data.sessions);
        return undefined;
    }

    if (data.type === "event") {
        if (
            (data.event === "agents" || data.event === "agents.list") &&
            Array.isArray(data.payload)
        ) {
            writeAgentsFromWebSocket(data.payload as AgentInfo[]);
        }
        return undefined;
    }

    if (data.type === "log" && data.line) {
        writeLogFromWebSocket(data.line);
        return undefined;
    }

    if (data.type === "res") {
        const sessions = extractSessionsFromPayload(data.payload);
        if (sessions.length > 0) {
            replaceSessionsFromWebSocket(sessions);
        }
    }

    return undefined;
}
