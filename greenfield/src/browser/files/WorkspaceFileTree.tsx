import {
    ChevronDown,
    ChevronRight,
    File,
    FileAudio,
    FileImage,
    FileText,
    Folder,
    HardDrive,
} from "lucide-react";

import type {
    WorkspaceFileDirectory,
    WorkspaceFileEntry,
    WorkspaceFileRoot,
} from "../../contracts/files.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

export interface WorkspaceFileTreeSnapshot {
    readonly directory: WorkspaceFileDirectory;
    readonly entries: readonly WorkspaceFileEntry[];
    readonly hasNextPage: boolean;
}

interface WorkspaceFileTreeProps {
    readonly expandedDirectoryIds: ReadonlySet<string>;
    readonly loadingDirectoryId?: string;
    readonly onOpenDirectory: (
        entry: WorkspaceFileEntry,
        parentDirectoryId: string
    ) => void;
    readonly onSelectFile: (entry: WorkspaceFileEntry, parentDirectoryId: string) => void;
    readonly onSelectRoot: (rootId: string) => void;
    readonly onToggleDirectory: (directoryId: string) => void;
    readonly roots: readonly WorkspaceFileRoot[];
    readonly selectedFileId?: string;
    readonly selectedRootId: string;
    readonly snapshots: readonly WorkspaceFileTreeSnapshot[];
}

function entryIcon(entry: WorkspaceFileEntry) {
    if (entry.kind === "directory") return Folder;
    switch (entry.previewKind) {
        case "audio": {
            return FileAudio;
        }
        case "image": {
            return FileImage;
        }
        case "pdf":
        case "text": {
            return FileText;
        }
        case "download-only":
        case undefined: {
            return File;
        }
    }
}

function sortedEntries(entries: readonly WorkspaceFileEntry[]) {
    return entries.toSorted((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}

interface TreeDirectoryEntriesProps {
    readonly depth: number;
    readonly directoryId: string;
    readonly expandedDirectoryIds: ReadonlySet<string>;
    readonly loadingDirectoryId?: string;
    readonly onOpenDirectory: WorkspaceFileTreeProps["onOpenDirectory"];
    readonly onSelectFile: WorkspaceFileTreeProps["onSelectFile"];
    readonly onToggleDirectory: WorkspaceFileTreeProps["onToggleDirectory"];
    readonly selectedFileId?: string;
    readonly snapshotById: ReadonlyMap<string, WorkspaceFileTreeSnapshot>;
}

function TreeDirectoryEntries({
    depth,
    directoryId,
    expandedDirectoryIds,
    loadingDirectoryId,
    onOpenDirectory,
    onSelectFile,
    onToggleDirectory,
    selectedFileId,
    snapshotById,
}: TreeDirectoryEntriesProps) {
    const snapshot = snapshotById.get(directoryId);
    if (snapshot === undefined) {
        return (
            <output aria-live="polite">
                <Text className="px-3 py-2" size="sm" tone="muted">
                    {loadingDirectoryId === directoryId
                        ? "Loading folder…"
                        : "Open this folder to load its entries."}
                </Text>
            </output>
        );
    }
    return (
        <ul aria-label={`${snapshot.directory.name} contents`}>
            {sortedEntries(snapshot.entries).map((entry) => {
                const directory = entry.kind === "directory";
                const expanded = directory && expandedDirectoryIds.has(entry.resourceId);
                const selected = !directory && selectedFileId === entry.resourceId;
                return (
                    <li key={entry.resourceId}>
                        <Button
                            aria-current={selected ? "true" : undefined}
                            aria-expanded={directory ? expanded : undefined}
                            className={`min-h-9 w-full min-w-0 justify-start gap-1.5 rounded-md py-1.5 pr-2 text-left font-normal ${
                                selected
                                    ? "bg-accent-500/20 text-accent-200 data-hover:bg-accent-500/20 data-hover:text-accent-200"
                                    : "text-primary-200 hover:bg-primary-700/70 hover:text-primary-50 data-hover:bg-primary-700/70 data-hover:text-primary-50"
                            }`}
                            onClick={() => {
                                if (directory) {
                                    onToggleDirectory(entry.resourceId);
                                    onOpenDirectory(entry, directoryId);
                                } else {
                                    onSelectFile(entry, directoryId);
                                }
                            }}
                            style={{ paddingLeft: `${depth * 0.875 + 0.5}rem` }}
                            variant="ghost"
                        >
                            {directory ? (
                                <Icon
                                    className="text-primary-400 shrink-0"
                                    icon={expanded ? ChevronDown : ChevronRight}
                                    size="sm"
                                />
                            ) : (
                                <span className="w-4 shrink-0" />
                            )}
                            <Icon
                                className={
                                    directory
                                        ? "shrink-0 text-amber-300"
                                        : "text-primary-400 shrink-0"
                                }
                                icon={entryIcon(entry)}
                                size="sm"
                            />
                            <span className="min-w-0 truncate">{entry.name}</span>
                        </Button>
                        {directory && expanded && (
                            <TreeDirectoryEntries
                                depth={depth + 1}
                                directoryId={entry.resourceId}
                                expandedDirectoryIds={expandedDirectoryIds}
                                loadingDirectoryId={loadingDirectoryId}
                                onOpenDirectory={onOpenDirectory}
                                onSelectFile={onSelectFile}
                                onToggleDirectory={onToggleDirectory}
                                selectedFileId={selectedFileId}
                                snapshotById={snapshotById}
                            />
                        )}
                    </li>
                );
            })}
            {snapshot.hasNextPage && (
                <li className="text-primary-400 px-3 py-2 text-xs">
                    More entries are available in the open folder.
                </li>
            )}
        </ul>
    );
}

/**
 * Persistent opaque-reference tree for visited workspace directories.
 * @returns Accessible expandable workspace file tree.
 */
export function WorkspaceFileTree({
    expandedDirectoryIds,
    loadingDirectoryId,
    onOpenDirectory,
    onSelectFile,
    onSelectRoot,
    onToggleDirectory,
    roots,
    selectedFileId,
    selectedRootId,
    snapshots,
}: WorkspaceFileTreeProps) {
    const snapshotById = new Map(
        snapshots.map((snapshot) => [snapshot.directory.resourceId, snapshot])
    );
    return (
        <nav aria-label="Workspace file tree" className="min-h-0 overflow-auto p-2">
            <ul role="tree">
                {roots.map((root) => {
                    const selected = root.id === selectedRootId;
                    return (
                        <li key={root.id} role="treeitem">
                            <Button
                                aria-expanded={selected}
                                className={`min-h-10 w-full min-w-0 justify-start gap-2 rounded-md p-2 text-left font-medium ${
                                    selected
                                        ? "bg-primary-700 text-primary-50 data-hover:bg-primary-700 data-hover:text-primary-50"
                                        : "text-primary-300 hover:bg-primary-700/60 data-hover:bg-primary-700/60"
                                }`}
                                onClick={() => onSelectRoot(root.id)}
                                variant="ghost"
                            >
                                <Icon
                                    className="text-accent-300 shrink-0"
                                    icon={selected ? ChevronDown : ChevronRight}
                                    size="sm"
                                />
                                <Icon icon={HardDrive} size="sm" />
                                <span className="min-w-0 truncate">{root.label}</span>
                            </Button>
                            {selected && (
                                <TreeDirectoryEntries
                                    depth={1}
                                    directoryId={root.resourceId}
                                    expandedDirectoryIds={expandedDirectoryIds}
                                    loadingDirectoryId={loadingDirectoryId}
                                    onOpenDirectory={onOpenDirectory}
                                    onSelectFile={onSelectFile}
                                    onToggleDirectory={onToggleDirectory}
                                    selectedFileId={selectedFileId}
                                    snapshotById={snapshotById}
                                />
                            )}
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
