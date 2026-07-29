import { parseSocketEnvelope, type SocketEnvelope } from "../../../../contracts/socket";
import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";

/**
 * Performs read gateway connection state.
 * @returns Read gateway connection state result.
 */
function readGatewayConnectionState(data: SocketEnvelope): boolean | undefined {
    if (data.type === "state" || data.type === "connected") {
        return data.gatewayConnected ?? true;
    }

    if (data.type === "disconnected") {
        return false;
    }

    return undefined;
}

/**
 * Responds to socket message events.
 * @param raw Raw value.
 * @returns Handle socket message result.
 */
export function handleSocketMessage(raw: unknown): boolean | undefined {
    let data: SocketEnvelope;
    try {
        data = parseSocketEnvelope(raw);
    } catch {
        return undefined;
    }

    if (data.type === "state" && data.sessions && data.gatewayConnected !== false) {
        replaceSessionsFromWebSocket(data.sessions);
    }

    if (data.type === "sessions" && data.sessions && data.gatewayConnected !== false) {
        replaceSessionsFromWebSocket(data.sessions);
    }

    if (
        data.type === "event" &&
        (data.event === "agents" || data.event === "agents.list") &&
        Array.isArray(data.payload)
    ) {
        writeAgentsFromWebSocket(data.payload);
    }

    if ((data.type === "log" && data.history !== true) || data.type === "dashboard_log") {
        if (!data.line) return readGatewayConnectionState(data);
        writeLogFromWebSocket(data.line, data.lineId);
    }

    return readGatewayConnectionState(data);
}
