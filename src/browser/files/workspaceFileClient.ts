import type { TRPCRequestOptions } from "@trpc/client";

import type {
    ListWorkspaceFilesInput,
    ListWorkspaceFilesOutput,
    PrepareWorkspaceFileContentInput,
    PrepareWorkspaceFileRevealInput,
    PrepareWorkspaceFileReferenceInput,
    PrepareWorkspaceFileUploadInput,
    PrepareWorkspaceFileWriteInput,
    WorkspaceFileContentTicket,
    WorkspaceFileRoot,
    WorkspaceFileUploadTicket,
    WorkspaceFileWriteStatus,
} from "../../contracts/files.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";

/** Browser-owned procedure surface for the workspace-files vertical. */
export interface WorkspaceFileClient {
    readonly mutation: {
        (
            name: "files.prepareReveal",
            input: PrepareWorkspaceFileRevealInput,
            options?: TRPCRequestOptions
        ): Promise<WorkspaceFileContentTicket>;
        (
            name: "files.prepareUpload",
            input: PrepareWorkspaceFileUploadInput,
            options?: TRPCRequestOptions
        ): Promise<WorkspaceFileUploadTicket>;
        (
            name: "files.prepareWrite",
            input: PrepareWorkspaceFileWriteInput,
            options?: TRPCRequestOptions
        ): Promise<WorkspaceFileUploadTicket>;
    };
    readonly query: {
        (
            name: "files.getWriteStatus",
            input: { readonly ticketId: string },
            options?: TRPCRequestOptions
        ): Promise<WorkspaceFileWriteStatus>;
        (
            name: "files.list",
            input: ListWorkspaceFilesInput,
            options?: TRPCRequestOptions
        ): Promise<ListWorkspaceFilesOutput>;
        (
            name: "files.listRoots",
            input: Record<string, never>,
            options?: TRPCRequestOptions
        ): Promise<{ readonly roots: readonly WorkspaceFileRoot[] }>;
        (
            name: "files.prepareContent",
            input: PrepareWorkspaceFileContentInput,
            options?: TRPCRequestOptions
        ): Promise<WorkspaceFileContentTicket>;
        (
            name: "files.prepareReference",
            input: PrepareWorkspaceFileReferenceInput,
            options?: TRPCRequestOptions
        ): Promise<WorkspaceFileContentTicket>;
    };
}

/**
 * Narrows the validated shared client to the registered Files procedures.
 * @param client Shared contract-validating Dashboard client.
 * @returns Files-only client view.
 */
export function workspaceFileClient(client: DashboardTrpcClient): WorkspaceFileClient {
    return Object.freeze({
        mutation: client.mutation.bind(client) as WorkspaceFileClient["mutation"],
        query: client.query.bind(client) as WorkspaceFileClient["query"],
    });
}
