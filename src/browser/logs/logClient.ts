import type { TRPCRequestOptions } from "@trpc/client";

import type {
    ListLogSourcesOutput,
    LogMaintenanceStatusOutput,
    LogSnapshotOutput,
    RequestLogMaintenanceInput,
    RequestLogMaintenanceOutput,
    SearchLogsInput,
    TailLogsInput,
} from "../../contracts/logs.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

/** Browser-owned, contract-validated procedure surface for bounded log access. */
export interface LogClient {
    readonly mutation: (
        name: "logs.requestMaintenance",
        input: RequestLogMaintenanceInput,
        options?: TRPCRequestOptions
    ) => Promise<RequestLogMaintenanceOutput>;
    readonly query: {
        (
            name: "logs.listSources",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<ListLogSourcesOutput>;
        (
            name: "logs.maintenanceStatus",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<LogMaintenanceStatusOutput>;
        (
            name: "logs.search",
            input: SearchLogsInput,
            options?: TRPCRequestOptions
        ): Promise<LogSnapshotOutput>;
        (
            name: "logs.tail",
            input: TailLogsInput,
            options?: TRPCRequestOptions
        ): Promise<LogSnapshotOutput>;
    };
}

/** @returns A logs-only view of the shared validated tRPC client. */
export function logClient(client: DashboardTrpcClient): LogClient {
    return Object.freeze({
        mutation: client.mutation.bind(client),
        query: client.query.bind(client) as LogClient["query"],
    });
}
