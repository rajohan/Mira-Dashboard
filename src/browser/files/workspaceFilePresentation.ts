import type { WorkspaceFileEntry } from "../../contracts/files.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
} from "../api/trpcError.ts";

export class WorkspaceFileTransferError extends Error {
    public readonly category:
        | "conflict"
        | "expired"
        | "invalid"
        | "protocol"
        | "rate-limited"
        | "reconciliation-required"
        | "too-large"
        | "unavailable"
        | "unsupported";

    public constructor(category: WorkspaceFileTransferError["category"]) {
        super("Workspace file transfer failed");
        this.name = "WorkspaceFileTransferError";
        this.category = category;
    }
}

/** Compact language metadata used by the bounded source viewer. */
export interface WorkspaceFileLanguage {
    readonly id: string;
    readonly label: string;
}

const plainTextLanguage = Object.freeze({ id: "text", label: "Plain text" });

const workspaceFileLanguages = Object.freeze<Record<string, WorkspaceFileLanguage>>({
    bash: { id: "shell", label: "Shell" },
    c: { id: "c", label: "C" },
    cjs: { id: "javascript", label: "JavaScript" },
    conf: { id: "config", label: "Config" },
    cpp: { id: "cpp", label: "C++" },
    cs: { id: "csharp", label: "C#" },
    css: { id: "css", label: "CSS" },
    csv: { id: "csv", label: "CSV" },
    env: { id: "dotenv", label: "Environment" },
    fish: { id: "shell", label: "Shell" },
    go: { id: "go", label: "Go" },
    gql: { id: "graphql", label: "GraphQL" },
    graphql: { id: "graphql", label: "GraphQL" },
    h: { id: "c", label: "C" },
    hpp: { id: "cpp", label: "C++" },
    htm: { id: "html", label: "HTML" },
    html: { id: "html", label: "HTML" },
    ini: { id: "config", label: "Config" },
    java: { id: "java", label: "Java" },
    js: { id: "javascript", label: "JavaScript" },
    json: { id: "json", label: "JSON" },
    json5: { id: "json5", label: "JSON5" },
    jsx: { id: "javascript", label: "JavaScript" },
    kt: { id: "kotlin", label: "Kotlin" },
    kts: { id: "kotlin", label: "Kotlin" },
    log: { id: "log", label: "Log" },
    lua: { id: "lua", label: "Lua" },
    md: { id: "markdown", label: "Markdown" },
    mjs: { id: "javascript", label: "JavaScript" },
    php: { id: "php", label: "PHP" },
    proto: { id: "protobuf", label: "Protocol Buffers" },
    py: { id: "python", label: "Python" },
    rb: { id: "ruby", label: "Ruby" },
    rs: { id: "rust", label: "Rust" },
    sass: { id: "sass", label: "Sass" },
    scala: { id: "scala", label: "Scala" },
    scss: { id: "scss", label: "SCSS" },
    sh: { id: "shell", label: "Shell" },
    sql: { id: "sql", label: "SQL" },
    swift: { id: "swift", label: "Swift" },
    toml: { id: "toml", label: "TOML" },
    ts: { id: "typescript", label: "TypeScript" },
    tsx: { id: "typescript", label: "TypeScript" },
    xml: { id: "xml", label: "XML" },
    yaml: { id: "yaml", label: "YAML" },
    yml: { id: "yaml", label: "YAML" },
    zsh: { id: "shell", label: "Shell" },
});

const specialWorkspaceFileLanguages = Object.freeze<
    Record<string, WorkspaceFileLanguage>
>({
    dockerfile: { id: "dockerfile", label: "Dockerfile" },
    makefile: { id: "makefile", label: "Makefile" },
});

/**
 * @param entry Contract-valid file inventory row.
 * @returns A stable editor language identifier and operator-facing label.
 */
export function workspaceFileLanguage(entry: WorkspaceFileEntry): WorkspaceFileLanguage {
    const name = entry.name.toLowerCase();
    const special = specialWorkspaceFileLanguages[name];
    if (special !== undefined) return special;
    const separator = name.lastIndexOf(".");
    const extension = separator === -1 ? "" : name.slice(separator + 1);
    const byExtension = workspaceFileLanguages[extension];
    if (byExtension !== undefined) return byExtension;
    switch (entry.mimeType) {
        case "application/json": {
            return workspaceFileLanguages.json!;
        }
        case "application/xml":
        case "text/xml": {
            return workspaceFileLanguages.xml!;
        }
        case "text/css": {
            return workspaceFileLanguages.css!;
        }
        case "text/csv": {
            return workspaceFileLanguages.csv!;
        }
        case "text/html": {
            return workspaceFileLanguages.html!;
        }
        case "text/markdown": {
            return workspaceFileLanguages.md!;
        }
        default: {
            return plainTextLanguage;
        }
    }
}

const transferMessages: Readonly<Record<WorkspaceFileTransferError["category"], string>> =
    Object.freeze({
        conflict:
            "The file or directory changed before the transfer completed. Refresh and review it before trying again.",
        expired: "This file link expired. Start the action again.",
        invalid:
            "The selected file could not be accepted. Review its name and try again.",
        protocol:
            "The file service returned an invalid response. Reload before trying again.",
        "rate-limited":
            "Too many file transfers were requested. Wait before trying again.",
        "reconciliation-required":
            "The upload outcome could not be confirmed. Refresh this directory before choosing the file again.",
        "too-large": "The selected file exceeds the 16 MiB upload limit.",
        unavailable: "The file service is temporarily unavailable. Try again shortly.",
        unsupported: "That file type cannot be transferred by the Dashboard.",
    });

/**
 * @param error Unknown tRPC, raw transfer, or browser rejection.
 * @returns Fixed operator-facing copy without server or filesystem details.
 */
export function workspaceFileFailureMessage(error: unknown): string {
    if (error instanceof WorkspaceFileTransferError) {
        return transferMessages[error.category];
    }
    switch (classifyDashboardBrowserFailure(error)) {
        case "conflict": {
            return "The selected file or directory changed. Refresh and review it before trying again.";
        }
        case "not-found": {
            return "The selected file or directory no longer exists. Refresh the current folder.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}

/**
 * @param entry Contract-valid file inventory row.
 * @returns Human-readable entry kind for compact inventory cells.
 */
export function workspaceFileKindLabel(entry: WorkspaceFileEntry): string {
    if (entry.kind === "directory") return "Folder";
    if (entry.truncated === true) return "Prefix";
    switch (entry.previewKind) {
        case "audio": {
            return "Audio";
        }
        case "image": {
            return "Image";
        }
        case "pdf": {
            return "PDF";
        }
        case "text": {
            return "Text";
        }
        case "download-only":
        case undefined: {
            return "File";
        }
    }
}
