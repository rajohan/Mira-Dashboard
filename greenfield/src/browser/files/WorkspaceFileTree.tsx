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
import type { InfiniteScrollContinuation } from "../ui/InfiniteScrollTrigger.tsx";
import { Text } from "../ui/Text.tsx";
import { VirtualizedList } from "../ui/VirtualizedList.tsx";

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
    readonly pagination?: InfiniteScrollContinuation;
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

interface TreeRowsInput {
    readonly depth: number;
    readonly directoryId: string;
    readonly expandedDirectoryIds: ReadonlySet<string>;
    readonly loadingDirectoryId?: string;
    readonly snapshotById: ReadonlyMap<string, WorkspaceFileTreeSnapshot>;
}

type WorkspaceFileTreeRow =
    | Readonly<{
          depth: number;
          entry: WorkspaceFileEntry;
          key: string;
          kind: "entry";
          parentDirectoryId: string;
      }>
    | Readonly<{
          depth: number;
          key: string;
          kind: "status";
          label: string;
      }>;

function directoryRows({
    depth,
    directoryId,
    expandedDirectoryIds,
    loadingDirectoryId,
    snapshotById,
}: TreeRowsInput): WorkspaceFileTreeRow[] {
    const snapshot = snapshotById.get(directoryId);
    if (snapshot === undefined) {
        return [
            {
                depth,
                key: `status:${directoryId}`,
                kind: "status",
                label:
                    loadingDirectoryId === directoryId
                        ? "Loading folder…"
                        : "Open this folder to load its entries.",
            },
        ];
    }
    return sortedEntries(snapshot.entries).flatMap((entry) => {
        const row: WorkspaceFileTreeRow = {
            depth,
            entry,
            key: `entry:${directoryId}:${entry.resourceId}`,
            kind: "entry",
            parentDirectoryId: directoryId,
        };
        return entry.kind === "directory" && expandedDirectoryIds.has(entry.resourceId)
            ? [
                  row,
                  ...directoryRows({
                      depth: depth + 1,
                      directoryId: entry.resourceId,
                      expandedDirectoryIds,
                      loadingDirectoryId,
                      snapshotById,
                  }),
              ]
            : [row];
    });
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
    pagination,
    roots,
    selectedFileId,
    selectedRootId,
    snapshots,
}: WorkspaceFileTreeProps) {
    const snapshotById = new Map(
        snapshots.map((snapshot) => [snapshot.directory.resourceId, snapshot])
    );
    const selectedRoot = roots.find((root) => root.id === selectedRootId);
    const rows =
        selectedRoot === undefined
            ? []
            : directoryRows({
                  depth: 2,
                  directoryId: selectedRoot.resourceId,
                  expandedDirectoryIds,
                  loadingDirectoryId,
                  snapshotById,
              });
    return (
        <nav aria-label="Workspace file tree" className="flex min-h-0 flex-1 flex-col">
            <div className="p-2">
                {roots.map((root) => {
                    const selected = root.id === selectedRootId;
                    return (
                        <Button
                            aria-expanded={selected}
                            className={`min-h-10 w-full min-w-0 justify-start gap-2 rounded-md p-2 text-left font-medium ${
                                selected
                                    ? "bg-primary-700 text-primary-50 data-hover:bg-primary-700 data-hover:text-primary-50"
                                    : "text-primary-300 hover:bg-primary-700/60 data-hover:bg-primary-700/60"
                            }`}
                            key={root.id}
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
                    );
                })}
            </div>
            <VirtualizedList
                className="max-h-none min-h-0 flex-1 px-2 pb-2"
                estimateSize={() => 40}
                getKey={(row) => row.key}
                itemRole="treeitem"
                items={rows}
                label={`${selectedRoot?.label ?? "Workspace"} contents`}
                listRole="tree"
                pagination={pagination}
                renderItem={(row) => {
                    if (row.kind === "status") {
                        return (
                            <Text
                                aria-live="polite"
                                className="py-2 pr-3"
                                size="sm"
                                style={{
                                    paddingLeft: `${row.depth * 0.875 + 2.25}rem`,
                                }}
                                tone="muted"
                            >
                                {row.label}
                            </Text>
                        );
                    }
                    const directory = row.entry.kind === "directory";
                    const expanded =
                        directory && expandedDirectoryIds.has(row.entry.resourceId);
                    const selected =
                        !directory && selectedFileId === row.entry.resourceId;
                    return (
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
                                    onToggleDirectory(row.entry.resourceId);
                                    onOpenDirectory(row.entry, row.parentDirectoryId);
                                } else {
                                    onSelectFile(row.entry, row.parentDirectoryId);
                                }
                            }}
                            style={{ paddingLeft: `${row.depth * 0.875 + 0.5}rem` }}
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
                                icon={entryIcon(row.entry)}
                                size="sm"
                            />
                            <span className="min-w-0 truncate">{row.entry.name}</span>
                        </Button>
                    );
                }}
            />
        </nav>
    );
}
