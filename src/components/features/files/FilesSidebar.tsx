import { Folder, Settings } from "lucide-react";

import type { FileNode } from "../../../types/file";
import { Card, CardTitle } from "../../ui/Card";
import { ConfigSection } from "./ConfigSection";
import { FileTreeItem } from "./FileTreeItem";

interface FilesSidebarProps {
    files: FileNode[];
    rootLoading: boolean;
    selectedPath: string | null;
    expandedPaths: Set<string>;
    onSelect: (path: string) => void;
    onToggle: (path: string) => void;
}

export function FilesSidebar({
    files,
    rootLoading,
    selectedPath,
    expandedPaths,
    onSelect,
    onToggle,
}: FilesSidebarProps) {
    return (
        <div className="w-full lg:w-72 lg:flex-shrink-0">
            <Card
                variant="bordered"
                className="flex max-h-96 min-h-0 flex-col overflow-hidden p-0 lg:h-full lg:max-h-none"
            >
                <div className="border-b border-primary-700 p-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                        <Folder size={14} />
                        Workspace
                    </CardTitle>
                </div>
                <div className="min-h-0 flex-1 overflow-auto border-b border-primary-700 p-2">
                    {rootLoading && files.length === 0 ? (
                        <div className="p-2 text-sm text-primary-400">Loading...</div>
                    ) : files.length === 0 ? (
                        <div className="p-2 text-sm text-primary-400">No files found</div>
                    ) : (
                        files
                            .sort((a, b) => {
                                if (a.type !== b.type)
                                    return a.type === "directory" ? -1 : 1;
                                return a.name.localeCompare(b.name);
                            })
                            .map((node) => (
                                <FileTreeItem
                                    key={node.path}
                                    node={node}
                                    selectedPath={selectedPath}
                                    expandedPaths={expandedPaths}
                                    onSelect={onSelect}
                                    onToggle={onToggle}
                                />
                            ))
                    )}
                </div>
                <div className="max-h-44 flex-shrink-0 border-t border-primary-700 lg:max-h-none">
                    <div className="border-b border-primary-700 p-3">
                        <CardTitle className="flex items-center gap-2 text-sm">
                            <Settings size={14} />
                            Config
                        </CardTitle>
                    </div>
                    <div className="max-h-32 overflow-auto lg:max-h-64">
                        <ConfigSection selectedPath={selectedPath} onSelect={onSelect} />
                    </div>
                </div>
            </Card>
        </div>
    );
}
