import type { TRPCRequestOptions } from "@trpc/client";

import type {
    DockerGetContainerLogsInput,
    DockerGetContainerLogsResult,
    DockerOverview,
    DockerPreparePruneInput,
    DockerPreparePruneResult,
    DockerRequestOperationInput,
    DockerRequestOperationResult,
} from "../../contracts/docker.ts";
import type {
    DashboardTrpcClient,
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";

/** Browser-owned procedure surface for the Docker vertical. */
export interface DockerClient {
    readonly mutation: {
        (
            name: "docker.requestOperation",
            input: DockerRequestOperationInput,
            options?: TRPCRequestOptions
        ): Promise<DockerRequestOperationResult>;
        (
            name: "cache.refreshEntry",
            input: DashboardProcedureInput<"cache.refreshEntry">,
            options?: TRPCRequestOptions
        ): Promise<DashboardProcedureOutput<"cache.refreshEntry">>;
    };
    readonly query: {
        (
            name: "docker.overview",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<DockerOverview>;
        (
            name: "docker.getContainerLogs",
            input: DockerGetContainerLogsInput,
            options?: TRPCRequestOptions
        ): Promise<DockerGetContainerLogsResult>;
        (
            name: "docker.preparePrune",
            input: DockerPreparePruneInput,
            options?: TRPCRequestOptions
        ): Promise<DockerPreparePruneResult>;
    };
}

/** @returns A Docker-only view of the shared contract-validating tRPC client. */
export function dockerClient(client: DashboardTrpcClient): DockerClient {
    return Object.freeze({
        mutation: client.mutation.bind(client) as DockerClient["mutation"],
        query: client.query.bind(client) as DockerClient["query"],
    });
}
