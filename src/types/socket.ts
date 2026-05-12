import { z } from "zod";

import type { Session } from "./session";

/** Describes socket envelope. */
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

/** Stores socket envelope schema. */
export const socketEnvelopeSchema = z.object({
    type: z.string(),
});

/** Stores sessions payload schema. */
export const sessionsPayloadSchema = z.object({
    sessions: z.array(z.unknown()),
});
