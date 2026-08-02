import { Download, FileText, Trash2 } from "lucide-react";

import type { LogFile } from "../../../../../contracts/logs";
import { LINE_OPTIONS, LOG_LEVELS } from "../../../utils/logUtilities";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Input } from "../../ui/Input";
import { RefreshButton } from "../../ui/RefreshButton";
import { Select } from "../../ui/Select";
import { LevelFilter } from "./LevelFilter";

export type LogSource = "dashboard" | "openclaw";

interface LogControlsProperties {
    activeLevels: Set<string>;
    availableLogFiles: LogFile[];
    isLoading: boolean;
    lineCount: number;
    onClear: () => void;
    onExport: () => void;
    onLevelToggle: (level: string) => void;
    onLineCountChange: (lineCount: number) => void;
    onReload: () => void;
    onSearchChange: (search: string) => void;
    onSelectedFileChange: (file: string | undefined) => void;
    onSourceChange: (source: LogSource) => void;
    search: string;
    selectedFile: string | undefined;
    source: LogSource;
    totalCount: number;
    visibleCount: number;
}

function formatLogEntryCount(visibleCount: number, totalCount: number): string {
    const suffix = visibleCount === 1 ? "entry" : "entries";
    return visibleCount === totalCount
        ? `${visibleCount} ${suffix}`
        : `${visibleCount} of ${totalCount} ${totalCount === 1 ? "entry" : "entries"}`;
}

/**
 * Renders log-source selection, filters, and collection actions.
 * @param properties Log control state and callbacks.
 * @returns Rendered log controls.
 */
export function LogControls({
    activeLevels,
    availableLogFiles,
    isLoading,
    lineCount,
    onClear,
    onExport,
    onLevelToggle,
    onLineCountChange,
    onReload,
    onSearchChange,
    onSelectedFileChange,
    onSourceChange,
    search,
    selectedFile,
    source,
    totalCount,
    visibleCount,
}: LogControlsProperties) {
    return (
        <>
            <Card variant="bordered" className="mb-3 p-2 sm:mb-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button
                        type="button"
                        variant={source === "dashboard" ? "primary" : "ghost"}
                        aria-pressed={source === "dashboard"}
                        onClick={() => onSourceChange("dashboard")}
                        className="justify-center"
                    >
                        Dashboard logs
                    </Button>
                    <Button
                        type="button"
                        variant={source === "openclaw" ? "primary" : "ghost"}
                        aria-pressed={source === "openclaw"}
                        onClick={() => onSourceChange("openclaw")}
                        className="justify-center"
                    >
                        OpenClaw logs
                    </Button>
                </div>
            </Card>

            <div className="mb-3 flex flex-col gap-3 sm:mb-4 md:flex-row md:flex-wrap md:items-center xl:flex-nowrap">
                {source === "openclaw" ? (
                    <div className="min-w-0 md:min-w-64 md:flex-1">
                        <Select
                            value={selectedFile || ""}
                            onChange={(value) => onSelectedFileChange(value || undefined)}
                            options={availableLogFiles.map((file) => ({
                                value: file.name,
                                label: file.name,
                            }))}
                            placeholder="Select file..."
                            icon={<FileText className="size-4" />}
                            width="w-full"
                        />
                    </div>
                ) : undefined}

                <div className="w-full shrink-0 md:w-32">
                    <Select
                        value={lineCount.toString()}
                        onChange={(value) => onLineCountChange(Math.trunc(Number(value)))}
                        options={LINE_OPTIONS.map((lines) => ({
                            value: lines.toString(),
                            label: `${lines} lines`,
                        }))}
                        width="w-full"
                    />
                </div>

                <div className="min-w-0 md:min-w-64 md:flex-2">
                    <Input
                        placeholder="Search logs..."
                        value={search}
                        onChange={(event) => onSearchChange(event.target.value)}
                        className="w-full min-w-0"
                    />
                </div>

                <div className="min-w-0 md:w-full xl:w-auto xl:shrink-0">
                    <LevelFilter
                        levels={LOG_LEVELS}
                        activeLevels={activeLevels}
                        onToggle={onLevelToggle}
                    />
                </div>
            </div>

            <div className="mb-3 flex flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-primary-400">
                    {isLoading
                        ? "Loading..."
                        : formatLogEntryCount(visibleCount, totalCount)}
                </div>

                <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center">
                    <RefreshButton
                        onClick={onReload}
                        isLoading={isLoading}
                        label="Reload"
                        disabled={source === "openclaw" && !selectedFile}
                    />
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onExport}
                        disabled={visibleCount === 0}
                    >
                        <Download size={14} />
                        Export
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onClear}
                        disabled={totalCount === 0}
                    >
                        <Trash2 size={14} />
                        Clear
                    </Button>
                </div>
            </div>
        </>
    );
}
