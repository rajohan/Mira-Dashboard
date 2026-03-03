export function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function getFileExtension(filename: string): string {
    const parts = filename.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

export function isMarkdownFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return ext === "md" || ext === "markdown";
}

export function isJsonFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return ext === "json" || ext === "json5";
}

export function isCodeFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    const codeExts = [
        "js", "jsx", "ts", "tsx", "py", "sh", "bash", "zsh", "fish",
        "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php",
        "swift", "kt", "scala", "lua", "sql", "graphql", "proto",
    ];
    return codeExts.includes(ext);
}

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

export function isImageFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext);
}

export function isBinaryFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    const binaryExts = [
        "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
        "pdf", "zip", "tar", "gz", "rar", "7z",
        "exe", "dll", "so", "dylib",
        "mp3", "mp4", "wav", "avi", "mov",
    ];
    return binaryExts.includes(ext);
}