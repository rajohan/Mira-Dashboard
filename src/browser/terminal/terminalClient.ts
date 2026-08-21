import type { TRPCRequestOptions } from "@trpc/client";

import type {
    GetActiveTerminalSessionOutput,
    PrepareTerminalSessionInput,
    TerminalConnectionTicket,
    TerminalRuntime,
    TerminalSessionSummary,
} from "../../contracts/terminal.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

/** Browser-owned, contract-validated lifecycle surface for interactive PTY sessions. */
export interface TerminalClient {
    readonly mutation: {
        (
            name: "terminal.prepareResume",
            input: { readonly afterSequence: number; readonly sessionId: string },
            options?: TRPCRequestOptions
        ): Promise<TerminalConnectionTicket>;
        (
            name: "terminal.prepareSession",
            input: PrepareTerminalSessionInput,
            options?: TRPCRequestOptions
        ): Promise<TerminalConnectionTicket>;
        (
            name: "terminal.terminateSession",
            input: { readonly sessionId: string },
            options?: TRPCRequestOptions
        ): Promise<{ readonly sessionId: string; readonly terminated: true }>;
    };
    readonly query: {
        (
            name: "terminal.getActiveSession",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<GetActiveTerminalSessionOutput>;
        (
            name: "terminal.getRuntime",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<TerminalRuntime>;
    };
}

/** Minimal active-session projection used while reconciling reconnect attempts. */
export type ActiveTerminalSession = Readonly<{
    session: TerminalSessionSummary;
    status: "active";
}>;

/** @returns A terminal-only view of the shared validated Dashboard client. */
export function terminalClient(client: DashboardTrpcClient): TerminalClient {
    return Object.freeze({
        mutation: client.mutation.bind(client) as TerminalClient["mutation"],
        query: client.query.bind(client) as TerminalClient["query"],
    });
}
