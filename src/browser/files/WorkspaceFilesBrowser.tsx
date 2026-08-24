import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
    WorkspaceFileDirectory,
    WorkspaceFileEntry,
} from "../../contracts/files.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { PageState } from "../ui/PageState.tsx";
import { workspaceFileClient } from "./workspaceFileClient.ts";
import { workspaceFileFailureMessage } from "./workspaceFilePresentation.ts";
import {
    accumulateWorkspaceFilePages,
    refreshWorkspaceFileDirectory,
    workspaceFileDirectoryQueryOptions,
    workspaceFileRootsQueryOptions,
} from "./workspaceFileQueries.ts";
import {
    WorkspaceFilesView,
    type WorkspaceFileBreadcrumb,
} from "./WorkspaceFilesView.tsx";
import {
    downloadWorkspaceFile,
    prepareWorkspaceFilePreview,
    revealWorkspaceFileSecrets,
    uploadWorkspaceFile,
} from "./workspaceFileTransfers.ts";
import type { WorkspaceFileTreeSnapshot } from "./WorkspaceFileTree.tsx";

interface WorkspaceFileNavigation {
    readonly breadcrumbs: readonly WorkspaceFileBreadcrumb[];
    readonly pendingDirectory?: WorkspaceFileDirectory;
    readonly rootId: string;
}

interface SavedWorkspaceFileTreeDirectory {
    readonly navigation: WorkspaceFileNavigation;
    readonly snapshot: WorkspaceFileTreeSnapshot;
}

/** @returns Auth-generation-scoped workspace file inventory and raw actions. */
export function WorkspaceFilesBrowser() {
    const client = workspaceFileClient(useDashboardTrpcClient());
    const queryClient = useQueryClient();
    const boundary = useAuthenticatedMutationBoundary();
    const rootsQuery = useQuery(workspaceFileRootsQueryOptions(client));
    const [navigation, setNavigation] = useState<WorkspaceFileNavigation>();
    const [savedTree, setSavedTree] = useState<
        ReadonlyMap<string, SavedWorkspaceFileTreeDirectory>
    >(() => new Map());
    const roots = rootsQuery.data?.roots ?? [];
    const selectedRoot = roots.find(({ id }) => id === navigation?.rootId) ?? roots[0];
    const selectedBreadcrumbs =
        navigation !== undefined && navigation.rootId === selectedRoot?.id
            ? navigation.breadcrumbs
            : [];
    const directoryId =
        selectedBreadcrumbs.at(-1)?.resourceId ?? selectedRoot?.resourceId;
    const directoryQuery = useInfiniteQuery(
        workspaceFileDirectoryQueryOptions(client, directoryId)
    );
    const accumulated = accumulateWorkspaceFilePages(directoryQuery.data?.pages ?? []);
    const savedSnapshot =
        directoryId === undefined ? undefined : savedTree.get(directoryId)?.snapshot;
    const fallbackDirectory = navigation?.pendingDirectory ?? savedSnapshot?.directory;
    const displayedDirectory = accumulated?.directory ?? fallbackDirectory;
    const directoryLoading =
        accumulated === undefined &&
        displayedDirectory !== undefined &&
        directoryQuery.isPending;
    const directoryUnavailable =
        accumulated === undefined &&
        displayedDirectory !== undefined &&
        directoryQuery.isError;

    if (rootsQuery.isPending && rootsQuery.data === undefined) {
        return <PageState label="Loading workspace file roots…" status="loading" />;
    }
    if (rootsQuery.data === undefined || selectedRoot === undefined) {
        return (
            <PageState
                message={workspaceFileFailureMessage(rootsQuery.error)}
                onRetry={() => void rootsQuery.refetch()}
                retryBusy={rootsQuery.isFetching}
                status="error"
                title="Workspace file roots unavailable"
            />
        );
    }
    if (directoryQuery.isPending && displayedDirectory === undefined) {
        return <PageState label="Loading workspace files…" status="loading" />;
    }
    if (displayedDirectory === undefined || directoryId === undefined) {
        return (
            <PageState
                message={workspaceFileFailureMessage(directoryQuery.error)}
                onRetry={() => {
                    setNavigation({ breadcrumbs: [], rootId: selectedRoot.id });
                    void Promise.allSettled([
                        rootsQuery.refetch(),
                        directoryQuery.refetch(),
                    ]);
                }}
                retryBusy={directoryQuery.isFetching || rootsQuery.isFetching}
                status="error"
                title="Workspace folder unavailable"
            />
        );
    }
    const currentDirectoryId: string = directoryId;

    const breadcrumbs: readonly WorkspaceFileBreadcrumb[] = [
        { label: selectedRoot.label, resourceId: selectedRoot.resourceId },
        ...selectedBreadcrumbs,
    ];
    const currentNavigation: WorkspaceFileNavigation = {
        breadcrumbs: selectedBreadcrumbs,
        rootId: selectedRoot.id,
    };
    const currentSnapshot: WorkspaceFileTreeSnapshot | undefined =
        accumulated === undefined
            ? undefined
            : {
                  directory: accumulated.directory,
                  entries: accumulated.entries,
                  hasNextPage: accumulated.nextCursor !== undefined,
              };
    const treeSnapshots = [
        ...[...savedTree.values()]
            .map(({ snapshot }) => snapshot)
            .filter(
                (snapshot) =>
                    snapshot.directory.resourceId !==
                    currentSnapshot?.directory.resourceId
            ),
        ...(currentSnapshot === undefined ? [] : [currentSnapshot]),
    ];

    function navigate(next: WorkspaceFileNavigation) {
        if (currentSnapshot !== undefined) {
            setSavedTree((current) => {
                return new Map([
                    ...current,
                    [
                        currentDirectoryId,
                        {
                            navigation: currentNavigation,
                            snapshot: currentSnapshot,
                        },
                    ],
                ]);
            });
        }
        setNavigation(next);
    }

    async function upload(
        file: File,
        replacedEntry: WorkspaceFileEntry | undefined,
        parentDirectoryId?: string,
        revealTicketId?: string
    ) {
        const result = await boundary.run((signal) =>
            replacedEntry === undefined
                ? uploadWorkspaceFile(
                      client,
                      { directoryId: currentDirectoryId, file, kind: "create" },
                      signal
                  )
                : uploadWorkspaceFile(
                      client,
                      {
                          expectedRevision: replacedEntry.revision,
                          file,
                          kind: "replace",
                          mimeType: replacedEntry.mimeType,
                          ...(revealTicketId === undefined ? {} : { revealTicketId }),
                          resourceId: replacedEntry.resourceId,
                      },
                      signal
                  )
        );
        if (boundary.completionIsCurrent()) {
            const refreshDirectoryId =
                replacedEntry === undefined
                    ? currentDirectoryId
                    : (parentDirectoryId ?? currentDirectoryId);
            void refreshWorkspaceFileDirectory(queryClient, refreshDirectoryId).catch(
                () => {
                    // The accepted worker job remains authoritative; manual refresh remains.
                }
            );
        }
        return result;
    }

    return (
        <WorkspaceFilesView
            backgroundError={
                directoryQuery.error === null || directoryQuery.isFetchNextPageError
                    ? undefined
                    : workspaceFileFailureMessage(directoryQuery.error)
            }
            breadcrumbs={breadcrumbs}
            directory={displayedDirectory}
            directoryLoading={directoryLoading}
            directoryUnavailable={directoryUnavailable}
            entries={accumulated?.entries ?? []}
            hasNextPage={accumulated?.nextCursor !== undefined}
            loadingMore={directoryQuery.isFetchingNextPage}
            paginationError={
                directoryQuery.isFetchNextPageError
                    ? workspaceFileFailureMessage(directoryQuery.error)
                    : undefined
            }
            onDownload={(entry) =>
                boundary.run((signal) => downloadWorkspaceFile(client, entry, signal))
            }
            onLoadMore={() => void directoryQuery.fetchNextPage()}
            onNavigate={(breadcrumbIndex) => {
                navigate({
                    breadcrumbs:
                        breadcrumbIndex === 0
                            ? []
                            : selectedBreadcrumbs.slice(0, breadcrumbIndex),
                    rootId: selectedRoot.id,
                });
            }}
            onOpenDirectory={(entry, parentDirectoryId) => {
                const parentNavigation =
                    parentDirectoryId === currentDirectoryId
                        ? currentNavigation
                        : savedTree.get(parentDirectoryId)?.navigation;
                if (parentNavigation === undefined) return;
                const parentDirectory =
                    parentDirectoryId === displayedDirectory.resourceId
                        ? displayedDirectory
                        : savedTree.get(parentDirectoryId)?.snapshot.directory;
                if (parentDirectory === undefined) return;
                navigate({
                    breadcrumbs: [
                        ...parentNavigation.breadcrumbs,
                        { label: entry.name, resourceId: entry.resourceId },
                    ],
                    pendingDirectory: {
                        displayPath:
                            parentDirectory.displayPath === "/"
                                ? `/${entry.name}`
                                : `${parentDirectory.displayPath}/${entry.name}`,
                        name: entry.name,
                        resourceId: entry.resourceId,
                        revision: entry.revision,
                        rootId: parentNavigation.rootId,
                        writable: entry.writable,
                    },
                    rootId: parentNavigation.rootId,
                });
            }}
            onPreview={(entry) =>
                boundary.run((signal) =>
                    prepareWorkspaceFilePreview(client, entry, signal)
                )
            }
            onRefresh={() => void directoryQuery.refetch()}
            onReveal={(entry) =>
                boundary.run((signal) =>
                    revealWorkspaceFileSecrets(client, entry, signal)
                )
            }
            onSelectRoot={(rootId) => navigate({ breadcrumbs: [], rootId })}
            onUpload={upload}
            refreshing={directoryQuery.isRefetching}
            roots={roots}
            selectedRootId={selectedRoot.id}
            stable={accumulated?.stable ?? true}
            treeSnapshots={treeSnapshots}
        />
    );
}
