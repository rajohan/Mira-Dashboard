import { z } from "zod";

import type { Session } from "./session";

export interface SocketEnvelope {
    type?: string;
    id?: string;
    ok?: boolean;
    error?: unknown;
    payload?: unknown;
    event?: string;
    sessions?: Session[];
    line?: string;
    gatewayConnected?: boolean;
}

export const socketEnvelopeSchema = z.object({
    type: z.string(),
});

export const sessionsPayloadSchema = z.object({
    sessions: z.array(z.unknown()),
});
