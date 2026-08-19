import { createColumnHelper, useTable } from "@tanstack/react-table";
import {
    Download,
    Eye,
    File,
    FileAudio,
    FileImage,
    FileText,
    Folder,
    Pencil,
} from "lucide-react";

import type { WorkspaceFileEntry } from "../../contracts/files.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { dashboardTableFeatures } from "../ui/dashboardTableFeatures.ts";
import { DataTable } from "../ui/DataTable.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer, type VirtualizerRenderState } from "../ui/Virtualizer.tsx";
import { workspaceFileKindLabel } from "./workspaceFilePresentation.ts";

const minimumVirtualizedRows = 50;
const workspaceFileTableFeatures = dashboardTableFeatures;

interface WorkspaceFileTableRow {
    readonly entry: WorkspaceFileEntry;
    readonly onDownload: (entry: WorkspaceFileEntry) => void;
    readonly onOpenDirectory: (entry: WorkspaceFileEntry) => void;
    readonly onPreview: (entry: WorkspaceFileEntry) => void;
    readonly onReplace: (entry: WorkspaceFileEntry) => void;
}

const workspaceFileColumnHelper = createColumnHelper<
    typeof workspaceFileTableFeatures,
    WorkspaceFileTableRow
>();

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

function primaryActionLabel(entry: WorkspaceFileEntry): string {
    if (entry.kind === "directory") return `Open folder ${entry.name}`;
    if (entry.truncated === true) return `Preview prefix of ${entry.name}`;
    return entry.previewKind === undefined || entry.previewKind === "download-only"
        ? `Download ${entry.name}`
        : `Preview ${entry.name}`;
}

function previewAvailable(entry: WorkspaceFileEntry): boolean {
    return (
        entry.truncated === true ||
        (entry.previewKind !== undefined && entry.previewKind !== "download-only")
    );
}

const workspaceFileColumns = workspaceFileColumnHelper.columns([
    workspaceFileColumnHelper.accessor((row) => row.entry.name, {
        cell: ({ getValue, row }) => {
            const { entry } = row.original;
            return (
                <Button
                    aria-label={primaryActionLabel(entry)}
                    className="text-primary-100 hover:text-accent-300 data-hover:text-accent-300 max-w-full min-w-8 justify-start rounded bg-transparent px-1 text-left font-medium data-hover:bg-transparent"
                    onClick={() => {
                        if (entry.kind === "directory") {
                            row.original.onOpenDirectory(entry);
                        } else if (previewAvailable(entry)) {
                            row.original.onPreview(entry);
                        } else {
                            row.original.onDownload(entry);
                        }
                    }}
                    size="sm"
                    variant="ghost"
                >
                    <Icon className="shrink-0" icon={entryIcon(entry)} size="sm" />
                    <span className="min-w-0 wrap-anywhere">{getValue()}</span>
                </Button>
            );
        },
        header: "Name",
        id: "name",
    }),
    workspaceFileColumnHelper.accessor((row) => workspaceFileKindLabel(row.entry), {
        cell: ({ getValue }) => <Text>{getValue()}</Text>,
        header: "Kind",
        id: "kind",
    }),
    workspaceFileColumnHelper.accessor((row) => row.entry.sizeBytes, {
        cell: ({ getValue }) => {
            const sizeBytes = getValue();
            return (
                <Text tone="muted">
                    {sizeBytes === undefined ? "—" : formatByteCount(sizeBytes)}
                </Text>
            );
        },
        header: "Size",
        id: "sizeBytes",
    }),
    workspaceFileColumnHelper.accessor((row) => row.entry.modifiedAtMs, {
        cell: ({ getValue }) => {
            const modifiedAtMs = getValue();
            return modifiedAtMs === undefined ? (
                <Text tone="muted">—</Text>
            ) : (
                <time dateTime={new Date(modifiedAtMs).toISOString()}>
                    {formatDashboardDateTime(modifiedAtMs)}
                </time>
            );
        },
        header: "Modified",
        id: "modifiedAtMs",
    }),
    workspaceFileColumnHelper.accessor((row) => row.entry.writable, {
        cell: ({ getValue }) => (
            <Badge variant={getValue() ? "success" : "default"}>
                {getValue() ? "Writable" : "Read only"}
            </Badge>
        ),
        header: "Access",
        id: "writable",
    }),
    workspaceFileColumnHelper.display({
        cell: ({ row }) => {
            const { entry } = row.original;
            if (entry.kind === "directory") return null;
            const canPreview = previewAvailable(entry);
            return (
                <div className="flex flex-wrap gap-1">
                    {canPreview && (
                        <IconOnlyButton
                            icon={Eye}
                            label={
                                entry.truncated === true
                                    ? `Preview prefix of ${entry.name}`
                                    : `Preview ${entry.name}`
                            }
                            onClick={() => row.original.onPreview(entry)}
                            variant="ghost"
                        />
                    )}
                    {!(
                        entry.truncated === true && entry.requiresSecretReveal === true
                    ) && (
                        <IconOnlyButton
                            icon={Download}
                            label={
                                entry.truncated === true
                                    ? `Download prefix of ${entry.name}`
                                    : `Download ${entry.name}`
                            }
                            onClick={() => row.original.onDownload(entry)}
                            variant="ghost"
                        />
                    )}
                    {entry.writable && entry.truncated !== true && (
                        <IconOnlyButton
                            icon={Pencil}
                            label={`Replace ${entry.name}`}
                            onClick={() => row.original.onReplace(entry)}
                            variant="ghost"
                        />
                    )}
                </div>
            );
        },
        header: "Actions",
        id: "actions",
    }),
]);

export interface WorkspaceFileTableProps {
    readonly entries: readonly WorkspaceFileEntry[];
    readonly onDownload: (entry: WorkspaceFileEntry) => void;
    readonly onOpenDirectory: (entry: WorkspaceFileEntry) => void;
    readonly onPreview: (entry: WorkspaceFileEntry) => void;
    readonly onReplace: (entry: WorkspaceFileEntry) => void;
}

/** @returns Bounded, mobile-safe file inventory with optional virtualization. */
export function WorkspaceFileTable({
    entries,
    onDownload,
    onOpenDirectory,
    onPreview,
    onReplace,
}: WorkspaceFileTableProps) {
    const table = useTable({
        columns: workspaceFileColumns,
        data: entries.map((entry) => ({
            entry,
            onDownload,
            onOpenDirectory,
            onPreview,
            onReplace,
        })),
        features: workspaceFileTableFeatures,
        getRowId: ({ entry }) => entry.resourceId,
    });
    const rows = table.getRowModel().rows;
    const tableElement = (rowWindow?: VirtualizerRenderState<HTMLTableRowElement>) => (
        <DataTable
            label="Workspace files"
            rowWindow={rowWindow}
            scrollContainerRef={rowWindow?.scrollContainerRef}
            table={table}
            tableClassName="min-w-224"
        />
    );

    if (rows.length < minimumVirtualizedRows) return tableElement();
    return (
        <Virtualizer<HTMLTableRowElement>
            count={rows.length}
            estimateSize={() => 58}
            getItemKey={(index) => rows[index]?.id ?? `missing-file-${index}`}
        >
            {(virtualization) => tableElement(virtualization)}
        </Virtualizer>
    );
}
