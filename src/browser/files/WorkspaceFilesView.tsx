import { ChevronRight, FileSearch, FolderTree, RefreshCw, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
    WorkspaceFileDirectory,
    WorkspaceFileEntry,
    WorkspaceFileRoot,
    WorkspaceFileWriteStatus,
} from "../../contracts/files.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import {
    WorkspaceFileEditorPane,
    type WorkspaceFilePanePreview,
    type WorkspaceFilePaneSelection,
} from "./WorkspaceFileEditorPane.tsx";
import { workspaceFileFailureMessage } from "./workspaceFilePresentation.ts";
import type { WorkspaceFilePreparedPreview } from "./workspaceFileTransfers.ts";
import {
    WorkspaceFileTree,
    type WorkspaceFileTreeSnapshot,
} from "./WorkspaceFileTree.tsx";
import {
    WorkspaceFileUploadDialog,
    type WorkspaceFileUploadIntent,
} from "./WorkspaceFileUploadDialog.tsx";

export interface WorkspaceFileBreadcrumb {
    readonly label: string;
    readonly resourceId: string;
}

export interface WorkspaceFilesViewProps {
    readonly backgroundError?: string;
    readonly breadcrumbs: readonly WorkspaceFileBreadcrumb[];
    readonly directory: WorkspaceFileDirectory;
    readonly directoryLoading?: boolean;
    readonly directoryUnavailable?: boolean;
    readonly entries: readonly WorkspaceFileEntry[];
    readonly hasNextPage: boolean;
    readonly loadingMore?: boolean;
    readonly paginationError?: string;
    readonly onDownload: (entry: WorkspaceFileEntry) => Promise<void>;
    readonly onLoadMore: () => void;
    readonly onNavigate: (breadcrumbIndex: number) => void;
    readonly onOpenDirectory: (
        entry: WorkspaceFileEntry,
        parentDirectoryId: string
    ) => void;
    readonly onPreview: (
        entry: WorkspaceFileEntry
    ) => Promise<WorkspaceFilePreparedPreview>;
    readonly onRefresh: () => void;
    readonly onReveal: (
        entry: WorkspaceFileEntry
    ) => Promise<WorkspaceFilePreparedPreview>;
    readonly onSelectRoot: (rootId: string) => void;
    readonly onUpload: (
        file: File,
        replacedEntry: WorkspaceFileEntry | undefined,
        parentDirectoryId?: string,
        revealTicketId?: string
    ) => Promise<WorkspaceFileWriteStatus>;
    readonly refreshing?: boolean;
    readonly roots: readonly WorkspaceFileRoot[];
    readonly selectedRootId: string;
    readonly stable: boolean;
    readonly treeSnapshots: readonly WorkspaceFileTreeSnapshot[];
}

interface SelectedPreviewState {
    readonly preview: WorkspaceFilePanePreview;
    readonly selection: WorkspaceFilePaneSelection;
}

function writeStatusMessage(
    status: WorkspaceFileWriteStatus
): Readonly<{ message: string; variant: "error" | "success" }> | undefined {
    switch (status.status) {
        case "accepted": {
            return {
                message:
                    "Your change is queued. It will appear after the folder refreshes.",
                variant: "success",
            };
        }
        case "pending": {
            return {
                message:
                    "This change is still being processed. Refresh before editing again.",
                variant: "error",
            };
        }
        case "reconciliation-required": {
            return {
                message:
                    "We could not confirm whether the change finished. Refresh before editing again.",
                variant: "error",
            };
        }
    }
}

/**
 * Persistent split-view workspace explorer with ticketed previews and CAS editing.
 * @returns Full workspace file workflow with tree and selected-file pane.
 */
export function WorkspaceFilesView({
    backgroundError,
    breadcrumbs,
    directory,
    directoryLoading = false,
    directoryUnavailable = false,
    entries,
    hasNextPage,
    loadingMore = false,
    paginationError,
    onDownload,
    onLoadMore,
    onNavigate,
    onOpenDirectory,
    onPreview,
    onRefresh,
    onReveal,
    onSelectRoot,
    onUpload,
    refreshing = false,
    roots,
    selectedRootId,
    stable,
    treeSnapshots,
}: WorkspaceFilesViewProps) {
    const [actionError, setActionError] = useState<string>();
    const [downloadingId, setDownloadingId] = useState<string>();
    const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(
        () => new Set([directory.resourceId])
    );
    const previewRequestSequence = useRef(0);
    const [selected, setSelected] = useState<SelectedPreviewState>();
    const [status, setStatus] =
        useState<Readonly<{ message: string; variant: "error" | "success" }>>();
    const [uploadIntent, setUploadIntent] = useState<WorkspaceFileUploadIntent>();
    const unavailableSelection =
        selected !== undefined &&
        !directoryLoading &&
        !directoryUnavailable &&
        stable &&
        !hasNextPage &&
        directory.resourceId === selected.selection.parentDirectoryId &&
        !entries.some((entry) => entry.resourceId === selected.selection.entry.resourceId)
            ? selected.selection
            : undefined;
    const unavailableParentDirectoryId = unavailableSelection?.parentDirectoryId;
    const unavailableResourceId = unavailableSelection?.entry.resourceId;
    const activeSelected = unavailableSelection === undefined ? selected : undefined;
    let uploadDialogKey = "closed";
    if (uploadIntent?.kind === "create") {
        uploadDialogKey = `create:${directory.resourceId}`;
    } else if (uploadIntent?.kind === "replace") {
        uploadDialogKey = `replace:${uploadIntent.entry.resourceId}`;
    }
    const rootOptions = roots.map((root) => ({
        description: root.writable ? "Writable" : "Read only",
        label: root.label,
        value: root.id,
    }));

    useEffect(() => {
        if (
            unavailableParentDirectoryId === undefined ||
            unavailableResourceId === undefined
        ) {
            return;
        }
        previewRequestSequence.current += 1;
        let active = true;
        queueMicrotask(() => {
            if (!active) return;
            setSelected((current) =>
                current?.selection.entry.resourceId === unavailableResourceId &&
                current.selection.parentDirectoryId === unavailableParentDirectoryId
                    ? undefined
                    : current
            );
            setUploadIntent((current) =>
                current?.kind === "replace" &&
                current.entry.resourceId === unavailableResourceId
                    ? undefined
                    : current
            );
        });
        return () => {
            active = false;
        };
    }, [unavailableParentDirectoryId, unavailableResourceId]);

    async function prepareSelection(
        selection: WorkspaceFilePaneSelection
    ): Promise<void> {
        const requestSequence = previewRequestSequence.current + 1;
        previewRequestSequence.current = requestSequence;
        setActionError(undefined);
        setSelected({ preview: { loading: true }, selection });
        try {
            const prepared = await onPreview(selection.entry);
            if (previewRequestSequence.current !== requestSequence) return;
            setSelected({ preview: { loading: false, prepared }, selection });
        } catch (error) {
            if (previewRequestSequence.current !== requestSequence) return;
            setSelected({
                preview: {
                    error: workspaceFileFailureMessage(error),
                    loading: false,
                },
                selection,
            });
        }
    }

    async function download(entry: WorkspaceFileEntry): Promise<void> {
        if (downloadingId !== undefined) return;
        setActionError(undefined);
        setDownloadingId(entry.resourceId);
        try {
            await onDownload(entry);
        } catch (error) {
            setActionError(workspaceFileFailureMessage(error));
        } finally {
            setDownloadingId(undefined);
        }
    }

    async function revealSecrets(selection: WorkspaceFilePaneSelection): Promise<void> {
        const requestSequence = previewRequestSequence.current + 1;
        previewRequestSequence.current = requestSequence;
        setActionError(undefined);
        setSelected((current) =>
            current?.selection.entry.resourceId === selection.entry.resourceId
                ? {
                      preview: { ...current.preview, revealLoading: true },
                      selection,
                  }
                : current
        );
        try {
            const prepared = await onReveal(selection.entry);
            if (previewRequestSequence.current !== requestSequence) return;
            setSelected({ preview: { loading: false, prepared }, selection });
        } catch (error) {
            if (previewRequestSequence.current !== requestSequence) return;
            setSelected((current) =>
                current?.selection.entry.resourceId === selection.entry.resourceId
                    ? {
                          preview: {
                              ...current.preview,
                              revealError: workspaceFileFailureMessage(error),
                              revealLoading: false,
                          },
                          selection,
                      }
                    : current
            );
        }
    }

    function completeUpload(writeStatus: WorkspaceFileWriteStatus) {
        setUploadIntent(undefined);
        setStatus(writeStatusMessage(writeStatus));
    }

    function selectRoot(rootId: string) {
        resetDirectoryActions();
        onSelectRoot(rootId);
    }

    function resetDirectoryActions() {
        setActionError(undefined);
        setStatus(undefined);
        setUploadIntent(undefined);
    }

    function renderFilePane() {
        if (activeSelected !== undefined) {
            return (
                <WorkspaceFileEditorPane
                    downloading={
                        downloadingId === activeSelected.selection.entry.resourceId
                    }
                    key={`${activeSelected.selection.entry.resourceId}:${activeSelected.selection.entry.revision}:${activeSelected.preview.prepared?.ticket.ticketId ?? "loading"}`}
                    onDownload={() => download(activeSelected.selection.entry)}
                    onRefreshPreview={() => prepareSelection(activeSelected.selection)}
                    onRevealSecrets={() => revealSecrets(activeSelected.selection)}
                    onReplace={() =>
                        setUploadIntent({
                            entry: activeSelected.selection.entry,
                            kind: "replace",
                        })
                    }
                    onSaveText={(content) => {
                        const entry = activeSelected.selection.entry;
                        return onUpload(
                            new File([content], entry.name, {
                                type: entry.mimeType ?? "text/plain",
                            }),
                            entry,
                            activeSelected.selection.parentDirectoryId,
                            activeSelected.preview.prepared?.revealTicketId
                        );
                    }}
                    onWriteComplete={completeUpload}
                    preview={activeSelected.preview}
                    selection={activeSelected.selection}
                />
            );
        }
        if (directoryLoading) {
            return (
                <div
                    aria-busy="true"
                    className="flex min-w-0 flex-1 items-center lg:min-h-0"
                    data-testid="workspace-folder-loading"
                >
                    <EmptyState
                        className="w-full py-4 sm:py-6 lg:py-10"
                        description="The file tree stays open while this folder loads."
                        headingLevel={2}
                        icon={FolderTree}
                        surface="plain"
                        title="Loading folder…"
                    />
                </div>
            );
        }
        if (directoryUnavailable) {
            return (
                <div className="flex min-w-0 flex-1 items-center lg:min-h-0">
                    <EmptyState
                        className="w-full py-4 sm:py-6 lg:py-10"
                        description={
                            backgroundError ??
                            "Refresh to retry loading this workspace folder."
                        }
                        headingLevel={2}
                        icon={FolderTree}
                        surface="plain"
                        title="Folder unavailable"
                    />
                </div>
            );
        }
        return (
            <div className="flex min-w-0 flex-1 items-center lg:min-h-0">
                <EmptyState
                    className="w-full py-4 sm:py-6 lg:py-10"
                    description="Choose a file from the tree to preview, download, or edit it without losing your place."
                    headingLevel={2}
                    icon={FileSearch}
                    surface="plain"
                    title="Select a file"
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
            <Card aria-labelledby="workspace-files-location-heading" className="p-4">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <Icon icon={FolderTree} tone="accent" />
                            <Heading
                                id="workspace-files-location-heading"
                                level={2}
                                size="subsection"
                            >
                                Workspace explorer
                            </Heading>
                        </div>
                        <nav aria-label="Workspace file path" className="mt-2">
                            <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
                                {breadcrumbs.map((breadcrumb, index) => {
                                    const current = index === breadcrumbs.length - 1;
                                    return (
                                        <li
                                            className="flex min-w-0 items-center gap-1"
                                            key={breadcrumb.resourceId}
                                        >
                                            {index > 0 && (
                                                <Icon
                                                    className="text-primary-500 shrink-0"
                                                    icon={ChevronRight}
                                                    size="sm"
                                                />
                                            )}
                                            {current ? (
                                                <span
                                                    aria-current="page"
                                                    className="text-primary-100 max-w-64 truncate font-medium"
                                                >
                                                    {breadcrumb.label}
                                                </span>
                                            ) : (
                                                <Button
                                                    className="text-primary-300 hover:text-accent-300 data-hover:text-accent-300 min-h-0 max-w-64 justify-start truncate rounded bg-transparent px-1 py-0.5 font-normal data-hover:bg-transparent"
                                                    onClick={() => {
                                                        resetDirectoryActions();
                                                        onNavigate(index);
                                                    }}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    {breadcrumb.label}
                                                </Button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ol>
                        </nav>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Text className="wrap-anywhere" size="sm" tone="muted">
                                {directory.displayPath}
                            </Text>
                            <Badge>
                                {directoryLoading
                                    ? "Loading folder…"
                                    : `${entries.length} loaded`}
                            </Badge>
                            <Badge variant={directory.writable ? "success" : "default"}>
                                {directory.writable ? "Writable" : "Read only"}
                            </Badge>
                            {hasNextPage && (
                                <Badge variant="warning">More available</Badge>
                            )}
                        </div>
                    </div>
                    <div className="flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
                        <div className="min-w-56 flex-1">
                            <Select
                                ariaLabel="Workspace file root"
                                onChange={selectRoot}
                                options={rootOptions}
                                value={selectedRootId}
                            />
                        </div>
                        <Button
                            busy={refreshing}
                            busyLabel="Refreshing…"
                            onClick={onRefresh}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Refresh
                        </Button>
                        {directory.writable && !directoryLoading && (
                            <Button
                                onClick={() =>
                                    setUploadIntent({
                                        directoryName: directory.name,
                                        kind: "create",
                                    })
                                }
                                size="sm"
                            >
                                <Icon icon={Upload} size="sm" tone="inherit" />
                                Upload file
                            </Button>
                        )}
                    </div>
                </div>
            </Card>

            <Alert focusOnError={false} message={backgroundError} />
            <Alert
                message={
                    stable
                        ? undefined
                        : "This folder changed while additional pages were loading. Refresh before continuing."
                }
            />
            <Alert message={actionError} onDismiss={() => setActionError(undefined)} />
            <Alert
                focusOnError={status?.variant === "error"}
                message={status?.message}
                onDismiss={() => setStatus(undefined)}
                variant={status?.variant ?? "success"}
            />

            <Card className="flex min-w-0 flex-col overflow-hidden p-0 lg:min-h-0 lg:flex-1 lg:flex-row">
                <aside className="border-primary-700 flex max-h-96 min-h-0 w-full shrink-0 flex-col border-b lg:max-h-none lg:w-72 lg:border-r lg:border-b-0">
                    <div className="border-primary-700 flex items-center gap-2 border-b px-4 py-3">
                        <Icon icon={FolderTree} size="sm" tone="accent" />
                        <Heading level={3} size="subsection">
                            Files
                        </Heading>
                    </div>
                    <WorkspaceFileTree
                        expandedDirectoryIds={expandedDirectoryIds}
                        loadingDirectoryId={
                            directoryLoading ? directory.resourceId : undefined
                        }
                        onOpenDirectory={(entry, parentDirectoryId) => {
                            resetDirectoryActions();
                            onOpenDirectory(entry, parentDirectoryId);
                        }}
                        onSelectFile={(entry, parentDirectoryId) =>
                            void prepareSelection({ entry, parentDirectoryId })
                        }
                        onSelectRoot={selectRoot}
                        onToggleDirectory={(directoryId) =>
                            setExpandedDirectoryIds((current) => {
                                const next = new Set(current);
                                if (next.has(directoryId)) next.delete(directoryId);
                                else next.add(directoryId);
                                return next;
                            })
                        }
                        pagination={{
                            ...(paginationError === undefined
                                ? {}
                                : { error: paginationError }),
                            hasMore: stable && hasNextPage,
                            loading: directoryLoading || loadingMore,
                            loadingLabel: "Loading more files…",
                            onLoadMore,
                        }}
                        roots={roots}
                        selectedFileId={activeSelected?.selection.entry.resourceId}
                        selectedRootId={selectedRootId}
                        snapshots={treeSnapshots}
                    />
                </aside>

                {renderFilePane()}
            </Card>

            <WorkspaceFileUploadDialog
                intent={uploadIntent}
                key={uploadDialogKey}
                onClose={() => setUploadIntent(undefined)}
                onComplete={completeUpload}
                onSubmit={(file, replacedEntry) =>
                    onUpload(
                        file,
                        replacedEntry,
                        replacedEntry === undefined
                            ? directory.resourceId
                            : activeSelected?.selection.parentDirectoryId,
                        replacedEntry === undefined
                            ? undefined
                            : activeSelected?.preview.prepared?.revealTicketId
                    )
                }
            />
        </div>
    );
}
