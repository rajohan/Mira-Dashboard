import type { Session } from "./session";

/** Represents socket envelope. */
export interface SocketEnvelope {
    type?: string;
    id?: string;
    isOk?: boolean;
    error?: unknown;
    payload?: unknown;
    event?: string;
    sessions?: Session[];
    line?: string;
    lineId?: string;
    history?: boolean;
    gatewayConnected?: boolean;
}

/** Checks whether a value is a socket envelope with a string type. */
export function isSocketEnvelope(value: unknown): value is SocketEnvelope {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { type?: unknown }).type === "string"
    );
}

/** Reads a sessions array from an unknown payload shape. */
export function readSessionsPayload(value: unknown): unknown[] | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const sessions = (value as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? sessions : undefined;
}
