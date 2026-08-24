import type { TRPCRequestOptions } from "@trpc/client";

import type {
    GatewaySessionActionInput,
    GatewaySessionActionResult,
    GatewaySessionDeleteInput,
    ListGatewaySessionsInput,
    ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

export type GatewaySessionMutationName =
    | "gatewaySessions.compact"
    | "gatewaySessions.delete"
    | "gatewaySessions.reset";

/** Narrow browser transport used while the shared registry composes this domain. */
export interface GatewaySessionsClient {
    readonly mutation: (
        name: GatewaySessionMutationName,
        input: GatewaySessionActionInput | GatewaySessionDeleteInput,
        options?: TRPCRequestOptions
    ) => Promise<GatewaySessionActionResult>;
    readonly query: (
        name: "gatewaySessions.list",
        input: ListGatewaySessionsInput,
        options?: TRPCRequestOptions
    ) => Promise<ListGatewaySessionsResult>;
}

/**
 * Narrows the validated shared client to procedure names owned by this vertical.
 * The contract registry remains the runtime validation authority.
 * @param client Shared Dashboard contract client.
 * @returns Gateway-session-only client view.
 */
export function gatewaySessionsClient(
    client: DashboardTrpcClient
): GatewaySessionsClient {
    return client;
}
