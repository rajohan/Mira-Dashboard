import { z } from "zod";

import type { Session } from "./session";

/** Represents socket envelope. */
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

/** Defines socket envelope schema. */
export const socketEnvelopeSchema = z.object({
    type: z.string(),
});

/** Defines sessions payload schema. */
export const sessionsPayloadSchema = z.object({
    sessions: z.array(z.unknown()),
});
