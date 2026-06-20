import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useState } from "react";

import { CONFIG_TOP_FILES, HOOKS_DIR_FILES } from "./fileConstants";

/** Provides props for config section. */
interface ConfigSectionProperties {
    selectedPath: string | null;
    onSelect: (path: string) => void;
}

/** Renders the config section UI. */
export function ConfigSection({ selectedPath, onSelect }: ConfigSectionProperties) {
    const [hooksDirectoryExpanded, setHooksDirectoryExpanded] = useState(false);

    return (
        <div className="p-2">
            {/* hooks/ subdirectory */}
            <button
                type="button"
                aria-label="hooks"
                aria-expanded={hooksDirectoryExpanded}
                className="text-primary-200 hover:bg-primary-700/50 focus:ring-accent-400 flex w-full min-w-0 cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-left text-sm focus:ring-2 focus:outline-none sm:py-1"
                onClick={() => setHooksDirectoryExpanded(!hooksDirectoryExpanded)}
            >
                {hooksDirectoryExpanded ? (
                    <ChevronDown size={14} className="text-primary-400 shrink-0" />
                ) : (
                    <ChevronRight size={14} className="text-primary-400 shrink-0" />
                )}
                <Folder size={16} className="flex-shrink-0 text-yellow-400" />
                <span className="min-w-0 truncate">hooks</span>
            </button>
            {hooksDirectoryExpanded && (
                <>
                    <div
                        className="text-primary-200 flex min-w-0 items-center gap-1 px-2 py-1.5 text-sm sm:py-1"
                        style={{ paddingLeft: 20 }}
                    >
                        <ChevronDown size={14} className="text-primary-400 shrink-0" />
                        <Folder size={14} className="flex-shrink-0 text-yellow-400" />
                        <span className="min-w-0 truncate">transforms</span>
                    </div>
                    {HOOKS_DIR_FILES.map((file) => {
                        const isSelected = selectedPath === file.path;
                        return (
                            <button
                                type="button"
                                key={file.path}
                                aria-label={file.label}
                                aria-current={isSelected ? "true" : undefined}
                                className={
                                    "hover:bg-primary-700/50 focus:ring-accent-400 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm focus:ring-2 focus:outline-none sm:py-1 " +
                                    (isSelected
                                        ? "bg-accent-500/20 text-accent-400"
                                        : "text-primary-200")
                                }
                                style={{ paddingLeft: 44 }}
                                onClick={() => onSelect(file.path)}
                            >
                                <File
                                    size={14}
                                    className="text-primary-400 flex-shrink-0"
                                />
                                <span className="min-w-0 truncate font-mono">
                                    {file.label}
                                </span>
                            </button>
                        );
                    })}
                </>
            )}

            {/* Top-level files */}
            {CONFIG_TOP_FILES.map((file) => {
                const isSelected = selectedPath === file.path;
                return (
                    <button
                        type="button"
                        key={file.path}
                        aria-label={file.label}
                        aria-current={isSelected ? "true" : undefined}
                        className={
                            "hover:bg-primary-700/50 focus:ring-accent-400 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm focus:ring-2 focus:outline-none sm:py-1 " +
                            (isSelected
                                ? "bg-accent-500/20 text-accent-400"
                                : "text-primary-200")
                        }
                        style={{ paddingLeft: 22 }}
                        onClick={() => onSelect(file.path)}
                    >
                        <File size={14} className="text-primary-400 flex-shrink-0" />
                        <span className="min-w-0 truncate font-mono">{file.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
