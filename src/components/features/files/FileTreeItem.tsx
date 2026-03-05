import { ChevronDown, ChevronRight, File, Folder, RefreshCw } from "lucide-react";

import type { FileNode } from "../../../types/file";
import { getFileExtension } from "../../../utils/fileUtils";

interface FileTreeItemProps {
    node: FileNode;
    selectedPath: string | null;
    expandedPaths: Set<string>;
    onSelect: (path: string) => void;
    onToggle: (path: string) => void;
    depth?: number;
}

function getFileIcon(filename: string, type: "file" | "directory") {
    if (type === "directory")
        return <Folder size={16} className="flex-shrink-0 text-yellow-400" />;

    const ext = getFileExtension(filename);
    const iconMap: Record<string, { icon: string; color: string }> = {
        ts: { icon: "TS", color: "text-blue-400" },
        tsx: { icon: "TSX", color: "text-blue-400" },
        js: { icon: "JS", color: "text-yellow-300" },
        jsx: { icon: "JSX", color: "text-yellow-300" },
        py: { icon: "PY", color: "text-green-400" },
        sh: { icon: "SH", color: "text-green-300" },
        bash: { icon: "SH", color: "text-green-300" },
        json: { icon: "{ }", color: "text-yellow-400" },
        json5: { icon: "{ }", color: "text-yellow-400" },
        md: { icon: "MD", color: "text-primary-400" },
        markdown: { icon: "MD", color: "text-primary-400" },
        go: { icon: "GO", color: "text-cyan-400" },
        rs: { icon: "RS", color: "text-orange-400" },
        java: { icon: "JV", color: "text-red-400" },
        c: { icon: "C", color: "text-blue-300" },
        cpp: { icon: "C++", color: "text-blue-300" },
        css: { icon: "CSS", color: "text-pink-400" },
        html: { icon: "HTML", color: "text-orange-400" },
        sql: { icon: "SQL", color: "text-purple-400" },
        png: { icon: "IMG", color: "text-purple-400" },
        jpg: { icon: "IMG", color: "text-purple-400" },
        jpeg: { icon: "IMG", color: "text-purple-400" },
        gif: { icon: "IMG", color: "text-purple-400" },
        svg: { icon: "IMG", color: "text-purple-400" },
        webp: { icon: "IMG", color: "text-purple-400" },
    };

    const iconInfo = iconMap[ext];
    if (iconInfo) {
        return (
            <span
                className={
                    "flex h-4 w-4 flex-shrink-0 items-center justify-center text-[10px] font-bold " +
                    iconInfo.color
                }
            >
                {iconInfo.icon}
            </span>
        );
    }

    return <File size={16} className="flex-shrink-0 text-primary-400" />;
}

export function FileTreeItem({
    node,
    selectedPath,
    expandedPaths,
    onSelect,
    onToggle,
    depth = 0,
}: FileTreeItemProps) {
    const isSelected = selectedPath === node.path;
    const isExpanded = expandedPaths.has(node.path);
    const hasChildren =
        node.type === "directory" && node.children && node.children.length > 0;
    const isLoading =
        node.type === "directory" && !node.loaded && expandedPaths.has(node.path);

    return (
        <div>
            <div
                className={
                    "flex cursor-pointer items-center gap-1 rounded px-2 py-1 hover:bg-primary-700/50 " +
                    (isSelected ? "bg-accent-500/20 text-accent-400" : "text-primary-200")
                }
                style={{ paddingLeft: depth * 12 + 8 }}
                onClick={() => {
                    if (node.type === "directory") {
                        onToggle(node.path);
                    } else {
                        onSelect(node.path);
                    }
                }}
            >
                {node.type === "directory" ? (
                    <>
                        {hasChildren ? (
                            isExpanded ? (
                                <ChevronDown size={14} className="text-primary-400" />
                            ) : (
                                <ChevronRight size={14} className="text-primary-400" />
                            )
                        ) : isLoading ? (
                            <RefreshCw
                                size={14}
                                className="animate-spin text-primary-400"
                            />
                        ) : (
                            <span className="w-3.5" />
                        )}
                        {getFileIcon(node.name, node.type)}
                    </>
                ) : (
                    <>
                        <span className="w-3.5" />
                        {getFileIcon(node.name, node.type)}
                    </>
                )}
                <span className="truncate text-sm">{node.name}</span>
            </div>
            {node.type === "directory" && isExpanded && node.children && (
                <div>
                    {node.children
                        .sort((a, b) => {
                            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        })
                        .map((child) => (
                            <FileTreeItem
                                key={child.path}
                                node={child}
                                selectedPath={selectedPath}
                                expandedPaths={expandedPaths}
                                onSelect={onSelect}
                                onToggle={onToggle}
                                depth={depth + 1}
                            />
                        ))}
                </div>
            )}
        </div>
    );
}
