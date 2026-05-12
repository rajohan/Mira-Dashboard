/** Describes file node. */
export interface FileNode {
    name: string;
    path: string;
    type: "file" | "directory";
    size?: number;
    modified?: string;
    children?: FileNode[];
    loaded?: boolean;
}

/** Describes file content. */
export interface FileContent {
    content: string;
    path: string;
    size: number;
    modified: string;
    isBinary: boolean;
    isImage?: boolean;
    mimeType?: string;
}
