import {
    infiniteQueryOptions,
    queryOptions,
    type QueryClient,
} from "@tanstack/react-query";

import {
    workspaceFileLimits,
    type ListWorkspaceFilesInput,
    type ListWorkspaceFilesOutput,
    type WorkspaceFileDirectory,
    type WorkspaceFileEntry,
} from "../../contracts/files.ts";
import type { WorkspaceFileClient } from "./workspaceFileClient.ts";

type WorkspaceFileCursor = NonNullable<ListWorkspaceFilesInput["cursor"]>;

export const workspaceFileQueryKey = ["files"] as const;
export const workspaceFileRootsQueryKey = [...workspaceFileQueryKey, "roots"] as const;
export const workspaceFileDirectoryQueryRoot = [
    ...workspaceFileQueryKey,
    "directories",
] as const;

const workspaceFileBrowserPageMaximum =
    Math.ceil(
        workspaceFileLimits.maximumDirectoryEntries / workspaceFileLimits.listPageDefault
    ) + 1;

export interface AccumulatedWorkspaceFileDirectory {
    readonly directory: WorkspaceFileDirectory;
    readonly entries: readonly WorkspaceFileEntry[];
    readonly nextCursor?: WorkspaceFileCursor;
    readonly stable: boolean;
}

function sameDirectory(
    left: WorkspaceFileDirectory,
    right: WorkspaceFileDirectory
): boolean {
    return (
        left.displayPath === right.displayPath &&
        left.name === right.name &&
        left.resourceId === right.resourceId &&
        left.revision === right.revision &&
        left.rootId === right.rootId &&
        left.writable === right.writable
    );
}

/**
 * Combines only pages from the same stable directory revision and rejects
 * repeated opaque identities instead of hiding a mid-pagination change.
 * @param pages Ordered cursor pages for one selected directory.
 * @returns Stable accumulated rows or the safe prefix before an inconsistency.
 */
export function accumulateWorkspaceFilePages(
    pages: readonly ListWorkspaceFilesOutput[]
): AccumulatedWorkspaceFileDirectory | undefined {
    const first = pages[0];
    if (first === undefined) return undefined;
    const entries: WorkspaceFileEntry[] = [];
    const resourceIds = new Set<string>();
    let nextCursor = first.nextCursor;

    for (const page of pages) {
        if (!sameDirectory(first.directory, page.directory)) {
            return { directory: first.directory, entries, stable: false };
        }
        for (const entry of page.entries) {
            if (resourceIds.has(entry.resourceId)) {
                return { directory: first.directory, entries, stable: false };
            }
            resourceIds.add(entry.resourceId);
            entries.push(entry);
        }
        nextCursor = page.nextCursor;
    }

    return {
        directory: first.directory,
        entries: Object.freeze(entries),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        stable: true,
    };
}

/** @returns Reviewed named-root inventory query options. */
export function workspaceFileRootsQueryOptions(client: WorkspaceFileClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("files.listRoots", {}, { signal }),
        queryKey: workspaceFileRootsQueryKey,
        retry: false,
        staleTime: 60_000,
    });
}

/** @returns Cursor-paginated options for one exact opaque directory reference. */
export function workspaceFileDirectoryQueryOptions(
    client: WorkspaceFileClient,
    directoryId: string | undefined
) {
    return infiniteQueryOptions({
        enabled: directoryId !== undefined,
        initialPageParam: undefined as WorkspaceFileCursor | undefined,
        queryFn: ({ pageParam, signal }): Promise<ListWorkspaceFilesOutput> => {
            if (directoryId === undefined) {
                return Promise.reject(
                    new TypeError("Workspace file directory is not selected")
                );
            }
            return client.query(
                "files.list",
                {
                    ...(pageParam === undefined ? {} : { cursor: pageParam }),
                    directoryId,
                    limit: workspaceFileLimits.listPageDefault,
                },
                { signal }
            );
        },
        getNextPageParam: (lastPage, pages) =>
            pages.length >= workspaceFileBrowserPageMaximum
                ? undefined
                : lastPage.nextCursor,
        queryKey: [...workspaceFileDirectoryQueryRoot, directoryId ?? null],
        retry: false,
        staleTime: 10_000,
    });
}

/** Invalidates only one selected directory projection after a queued write. */
export async function refreshWorkspaceFileDirectory(
    queryClient: QueryClient,
    directoryId: string
): Promise<void> {
    await queryClient.invalidateQueries({
        exact: true,
        queryKey: [...workspaceFileDirectoryQueryRoot, directoryId],
    });
}
