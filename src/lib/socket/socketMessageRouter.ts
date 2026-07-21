import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";
import type { AgentInfo, Session } from "../../types/session";
import type { SocketEnvelope } from "../../types/socket";
import { isSocketEnvelope, readSessionsPayload } from "../../types/socket";

/** Extracts sessions from payload. */
function extractSessionsFromPayload(payload: unknown): Session[] {
    if (Array.isArray(payload)) {
        return payload as Session[];
    }

    const sessions = readSessionsPayload(payload);
    if (sessions) {
        return sessions as Session[];
    }

    if (payload && typeof payload === "object") {
        const maybe = payload as { result?: unknown; data?: unknown };

        const fromResult = readSessionsPayload(maybe.result);
        if (fromResult) {
            return fromResult as Session[];
        }

        const fromData = readSessionsPayload(maybe.data);
        if (fromData) {
            return fromData as Session[];
        }
    }

    return [];
}

/** Performs read gateway connection state. */
function readGatewayConnectionState(data: SocketEnvelope): boolean | undefined {
    if (data.type === "state" || data.type === "connected") {
        return data.gatewayConnected ?? true;
    }

    if (data.type === "disconnected") {
        return false;
    }

    return undefined;
}

/** Responds to socket message events. */
export function handleSocketMessage(raw: unknown): boolean | undefined {
    if (!isSocketEnvelope(raw)) {
        return undefined;
    }

    const data = raw;

    if (data.type === "state" && data.sessions && data.gatewayConnected !== false) {
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

    if (data.type === "log" && data.line && data.history !== true) {
        writeLogFromWebSocket(data.line, data.lineId);
    }

    if (data.type === "response") {
        const sessions = extractSessionsFromPayload(data.payload);
        if (sessions.length > 0) {
            replaceSessionsFromWebSocket(sessions);
        }
    }

    return readGatewayConnectionState(data);
}
