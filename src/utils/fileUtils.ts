export { formatSize } from "./format";

/** Handles get file extension. */
export function getFileExtension(filename: string): string {
    const parts = filename.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/** Handles is markdown file. */
export function isMarkdownFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return ext === "md" || ext === "markdown";
}

/** Handles is json file. */
export function isJsonFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return ext === "json" || ext === "json5";
}

/** Handles is code file. */
export function isCodeFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    const codeExts = [
        "js",
        "jsx",
        "ts",
        "tsx",
        "py",
        "sh",
        "bash",
        "zsh",
        "fish",
        "go",
        "rs",
        "java",
        "c",
        "cpp",
        "h",
        "hpp",
        "cs",
        "rb",
        "php",
        "swift",
        "kt",
        "scala",
        "lua",
        "sql",
        "graphql",
        "proto",
    ];
    return codeExts.includes(ext);
}

/** Handles get language. */
export function getLanguage(filename: string): string {
    const ext = getFileExtension(filename);
    const langMap: Record<string, string> = {
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        py: "python",
        sh: "bash",
        bash: "bash",
        zsh: "bash",
        fish: "bash",
        go: "go",
        rs: "rust",
        java: "java",
        c: "c",
        cpp: "cpp",
        h: "c",
        hpp: "cpp",
        cs: "csharp",
        rb: "ruby",
        php: "php",
        swift: "swift",
        kt: "kotlin",
        scala: "scala",
        lua: "lua",
        sql: "sql",
        graphql: "graphql",
        proto: "protobuf",
        json: "json",
        json5: "json",
        md: "markdown",
        yaml: "yaml",
        yml: "yaml",
        xml: "xml",
        html: "html",
        css: "css",
        scss: "scss",
    };
    return langMap[ext] || "text";
}

/** Handles is image file. */
export function isImageFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext);
}

/** Handles is binary file. */
export function isBinaryFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    const binaryExts = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "ico",
        "pdf",
        "zip",
        "tar",
        "gz",
        "rar",
        "7z",
        "exe",
        "dll",
        "so",
        "dylib",
        "mp3",
        "mp4",
        "wav",
        "avi",
        "mov",
    ];
    return binaryExts.includes(ext);
}

/** Handles get syntax class. */
export function getSyntaxClass(filename: string): string {
    const ext = getFileExtension(filename);
    const syntaxMap: Record<string, string> = {
        js: "text-yellow-400",
        jsx: "text-yellow-400",
        ts: "text-blue-400",
        tsx: "text-blue-400",
        json: "text-green-400",
        json5: "text-green-400",
        md: "text-primary-300",
        html: "text-orange-400",
        css: "text-pink-400",
        py: "text-blue-300",
        go: "text-cyan-400",
        rs: "text-orange-300",
        sh: "text-green-300",
        yml: "text-purple-400",
        yaml: "text-purple-400",
    };
    return syntaxMap[ext] || "text-primary-300";
}
