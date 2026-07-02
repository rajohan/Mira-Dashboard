import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useState } from "react";

import { CONFIG_TOP_FILES, HOOKS_DIR_FILES } from "./fileConstants";

/** Provides props for config section. */
interface ConfigSectionProperties {
    selectedPath: string | undefined;
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
                className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-left text-sm text-primary-200 hover:bg-primary-700/50 focus:ring-2 focus:ring-accent-400 focus:outline-none sm:py-1"
                onClick={() => setHooksDirectoryExpanded(!hooksDirectoryExpanded)}
            >
                {hooksDirectoryExpanded ? (
                    <ChevronDown size={14} className="shrink-0 text-primary-400" />
                ) : (
                    <ChevronRight size={14} className="shrink-0 text-primary-400" />
                )}
                <Folder size={16} className="shrink-0 text-yellow-400" />
                <span className="min-w-0 truncate">hooks</span>
            </button>
            {hooksDirectoryExpanded && (
                <>
                    <div
                        className="flex min-w-0 items-center gap-1 px-2 py-1.5 text-sm text-primary-200 sm:py-1"
                        style={{ paddingLeft: 20 }}
                    >
                        <ChevronDown size={14} className="shrink-0 text-primary-400" />
                        <Folder size={14} className="shrink-0 text-yellow-400" />
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
                                    "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-primary-700/50 focus:ring-2 focus:ring-accent-400 focus:outline-none sm:py-1 " +
                                    (isSelected
                                        ? "bg-accent-500/20 text-accent-400"
                                        : "text-primary-200")
                                }
                                style={{ paddingLeft: 44 }}
                                onClick={() => onSelect(file.path)}
                            >
                                <File size={14} className="shrink-0 text-primary-400" />
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
                            "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-primary-700/50 focus:ring-2 focus:ring-accent-400 focus:outline-none sm:py-1 " +
                            (isSelected
                                ? "bg-accent-500/20 text-accent-400"
                                : "text-primary-200")
                        }
                        style={{ paddingLeft: 22 }}
                        onClick={() => onSelect(file.path)}
                    >
                        <File size={14} className="shrink-0 text-primary-400" />
                        <span className="min-w-0 truncate font-mono">{file.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
