import path from "node:path";

export const MAX_MEDIA_SIZE = 16 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_SIZE = 1024 * 1024;
export const TEXT_PREVIEW_EXTENSIONS = new Set([".csv", ".json", ".md", ".txt"]);
export const SVG_PREVIEW_CONTENT_SECURITY_POLICY =
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const MIME_TYPES: Record<string, string> = {
    ".aac": "audio/aac",
    ".bmp": "image/bmp",
    ".csv": "text/csv; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".m4a": "audio/mp4",
    ".md": "text/markdown; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
};

export function mimeTypeFromPath(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}
