/** Represents chat image block. */
export interface ChatImageBlock {
    type: "image" | "image_url" | "input_image";
    alt?: string;
    mimeType?: string;
    data?: string;
    url?: string;
    openUrl?: string;
    image_url?:
        | string
        | {
              url?: string;
          };
    source?: {
        type?: string;
        media_type?: string;
        data?: string;
        url?: string;
    };
}

/** Represents chat attachment display. */
export interface ChatAttachmentDisplay {
    id: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    dataUrl?: string;
    url?: string;
    contentBase64?: string;
    kind: "image" | "text" | "file";
}

/** Represents chat preview item. */
export interface ChatPreviewItem {
    title: string;
    mimeType?: string;
    kind: "image" | "text" | "file";
    url?: string;
    text?: string;
    sizeBytes?: number;
}

/** Represents chat send attachment. */
export interface ChatSendAttachment {
    id: string;
    file: File;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    contentBase64: string;
    dataUrl?: string;
    kind: "image" | "text" | "file";
}

/** Identifies where files were added so validation feedback stays local. */
export type ChatAttachmentInputSource = "composer" | "picker";

/** Represents attachment validation feedback and its presentation target. */
export interface ChatAttachmentError {
    message: string;
    source: ChatAttachmentInputSource;
}
