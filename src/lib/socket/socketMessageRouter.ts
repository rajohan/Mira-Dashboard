import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";
import type { AgentInfo, Session } from "../../types/session";
import type { SocketEnvelope } from "../../types/socket";
import { sessionsPayloadSchema, socketEnvelopeSchema } from "../../types/socket";

function extractSessionsFromPayload(payload: unknown): Session[] {
    if (Array.isArray(payload)) {
        return payload as Session[];
    }

    const parsed = sessionsPayloadSchema.safeParse(payload);
    if (parsed.success) {
        return parsed.data.sessions as Session[];
    }

    if (payload && typeof payload === "object") {
        const maybe = payload as { result?: unknown; data?: unknown };

        const fromResult = sessionsPayloadSchema.safeParse(maybe.result);
        if (fromResult.success) {
            return fromResult.data.sessions as Session[];
        }

        const fromData = sessionsPayloadSchema.safeParse(maybe.data);
        if (fromData.success) {
            return fromData.data.sessions as Session[];
        }
    }

    return [];
}

function readGatewayConnectionState(data: SocketEnvelope): boolean | null {
    if (data.type === "state" || data.type === "connected") {
        return data.gatewayConnected ?? true;
    }

    if (data.type === "disconnected") {
        return false;
    }

    return null;
}

export function handleSocketMessage(raw: unknown): boolean | null {
    const validated = socketEnvelopeSchema.safeParse(raw);
    if (!validated.success) {
        return null;
    }

    const data = raw as SocketEnvelope;

    if (data.type === "state" && data.sessions) {
        replaceSessionsFromWebSocket(data.sessions);
    }

    if (data.type === "sessions" && data.sessions) {
        replaceSessionsFromWebSocket(data.sessions);
    }

    if (
        data.type === "event" &&
        (data.event === "agents" || data.event === "agents.list") &&
        Array.isArray(data.payload)
    ) {
        writeAgentsFromWebSocket(data.payload as AgentInfo[]);
    }

    if (data.type === "log" && data.line) {
        writeLogFromWebSocket(data.line);
    }

    if (data.type === "res") {
        const sessions = extractSessionsFromPayload(data.payload);
        if (sessions.length > 0) {
            replaceSessionsFromWebSocket(sessions);
        }
    }

    return readGatewayConnectionState(data);
}
