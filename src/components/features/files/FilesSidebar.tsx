import { Folder, Settings } from "lucide-react";

import type { FileNode } from "../../../types/file";
import { Card, CardTitle } from "../../ui/Card";
import { ConfigSection } from "./ConfigSection";
import { FileTreeItem } from "./FileTreeItem";

/** Provides props for files sIDebar. */
interface FilesSidebarProps {
    files: FileNode[];
    rootLoading: boolean;
    selectedPath: string | null;
    expandedPaths: Set<string>;
    onSelect: (path: string) => void;
    onToggle: (path: string) => void;
}

/** Renders the files sidebar UI. */
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
                <div className="border-primary-700 border-b p-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                        <Folder size={14} />
                        Workspace
                    </CardTitle>
                </div>
                <div className="border-primary-700 min-h-0 flex-1 overflow-auto border-b p-2">
                    {rootLoading && files.length === 0 ? (
                        <div className="text-primary-400 p-2 text-sm">Loading...</div>
                    ) : files.length === 0 ? (
                        <div className="text-primary-400 p-2 text-sm">No files found</div>
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
                <div className="border-primary-700 max-h-44 flex-shrink-0 border-t lg:max-h-none">
                    <div className="border-primary-700 border-b p-3">
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
