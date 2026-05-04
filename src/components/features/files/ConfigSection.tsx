import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useState } from "react";

import { CONFIG_TOP_FILES, CRON_DIR_FILES, HOOKS_DIR_FILES } from "./fileConstants";

interface ConfigSectionProps {
    selectedPath: string | null;
    onSelect: (path: string) => void;
}

export function ConfigSection({ selectedPath, onSelect }: ConfigSectionProps) {
    const [cronDirExpanded, setCronDirExpanded] = useState(false);
    const [hooksDirExpanded, setHooksDirExpanded] = useState(false);

    return (
        <div className="p-2">
            {/* cron/ subdirectory */}
            <div
                className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm text-primary-200 hover:bg-primary-700/50"
                onClick={() => setCronDirExpanded(!cronDirExpanded)}
            >
                {cronDirExpanded ? (
                    <ChevronDown size={14} className="text-primary-400" />
                ) : (
                    <ChevronRight size={14} className="text-primary-400" />
                )}
                <Folder size={16} className="flex-shrink-0 text-yellow-400" />
                <span className="truncate">cron</span>
            </div>
            {cronDirExpanded &&
                CRON_DIR_FILES.map((file) => {
                    const isSelected = selectedPath === file.path;
                    return (
                        <div
                            key={file.path}
                            className={
                                "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-primary-700/50 " +
                                (isSelected
                                    ? "bg-accent-500/20 text-accent-400"
                                    : "text-primary-200")
                            }
                            style={{ paddingLeft: 28 }}
                            onClick={() => onSelect(file.path)}
                        >
                            <File size={14} className="flex-shrink-0 text-primary-400" />
                            <span className="truncate font-mono">{file.label}</span>
                        </div>
                    );
                })}

            {/* hooks/ subdirectory */}
            <div
                className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm text-primary-200 hover:bg-primary-700/50"
                onClick={() => setHooksDirExpanded(!hooksDirExpanded)}
            >
                {hooksDirExpanded ? (
                    <ChevronDown size={14} className="text-primary-400" />
                ) : (
                    <ChevronRight size={14} className="text-primary-400" />
                )}
                <Folder size={16} className="flex-shrink-0 text-yellow-400" />
                <span className="truncate">hooks</span>
            </div>
            {hooksDirExpanded && (
                <>
                    <div
                        className="flex items-center gap-1 px-2 py-1 text-sm text-primary-200"
                        style={{ paddingLeft: 20 }}
                    >
                        <ChevronDown size={14} className="text-primary-400" />
                        <Folder size={14} className="flex-shrink-0 text-yellow-400" />
                        <span className="truncate">transforms</span>
                    </div>
                    {HOOKS_DIR_FILES.map((file) => {
                        const isSelected = selectedPath === file.path;
                        return (
                            <div
                                key={file.path}
                                className={
                                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-primary-700/50 " +
                                    (isSelected
                                        ? "bg-accent-500/20 text-accent-400"
                                        : "text-primary-200")
                                }
                                style={{ paddingLeft: 44 }}
                                onClick={() => onSelect(file.path)}
                            >
                                <File
                                    size={14}
                                    className="flex-shrink-0 text-primary-400"
                                />
                                <span className="truncate font-mono">{file.label}</span>
                            </div>
                        );
                    })}
                </>
            )}

            {/* Top-level files */}
            {CONFIG_TOP_FILES.map((file) => {
                const isSelected = selectedPath === file.path;
                return (
                    <div
                        key={file.path}
                        className={
                            "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-primary-700/50 " +
                            (isSelected
                                ? "bg-accent-500/20 text-accent-400"
                                : "text-primary-200")
                        }
                        style={{ paddingLeft: 22 }}
                        onClick={() => onSelect(file.path)}
                    >
                        <File size={14} className="flex-shrink-0 text-primary-400" />
                        <span className="truncate font-mono">{file.label}</span>
                    </div>
                );
            })}
        </div>
    );
}
