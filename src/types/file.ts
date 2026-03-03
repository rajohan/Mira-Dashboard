export interface FileNode {
    name: string;
    path: string;
    type: "file" | "directory";
    size?: number;
    modified?: string;
    children?: FileNode[];
    loaded?: boolean;
}

export interface FileContent {
    content: string;
    path: string;
    size: number;
    modified: string;
    isBinary: boolean;
    isImage?: boolean;
    mimeType?: string;
}