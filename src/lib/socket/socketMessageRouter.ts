import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";
import type { AgentInfo } from "../../types/session";
import type { SocketEnvelope } from "../../types/socket";
import { isSocketEnvelope, readSessionsResponsePayload } from "../../types/socket";

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
        const sessions = readSessionsResponsePayload(data.payload);
        if (sessions !== undefined) {
            replaceSessionsFromWebSocket(sessions);
        }
    }

    return readGatewayConnectionState(data);
}
