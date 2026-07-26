import {
    chmodSync,
    cpSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_OPENCLAW_CONFIG_BYTES = 2 * 1024 * 1024;
const OMITTED_WORKSPACE_DIRECTORIES = new Set([
    ".aws",
    ".azure",
    ".credentials",
    ".git",
    ".gnupg",
    ".secrets",
    ".ssh",
    "credentials",
    "secrets",
]);
const SAFE_ENVIRONMENT_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template"]);
const SENSITIVE_WORKSPACE_FILE_NAMES = new Set([
    ".env",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
    "private.key",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
]);
const SENSITIVE_AGENT_CONFIG_KEY =
    /(?:^|[._-])(?:api[._-]?key|credential|credentials|password|secret|secrets|token)(?:$|[._-])/iu;

export type DevelopmentWorkspaceState = "copied" | "empty" | "reused";

export interface DevelopmentOpenClawSnapshotConfig {
    configSource?: string;
    openClawHome: string;
    workspaceSource?: string;
}

function isRealDirectory(directoryPath: string): boolean {
    try {
        const stat = lstatSync(directoryPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function isRealRegularFile(filePath: string): boolean {
    try {
        const stat = lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function ensurePrivateDirectory(directoryPath: string): void {
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    if (!isRealDirectory(directoryPath)) {
        throw new Error(`Development path must be a real directory: ${directoryPath}`);
    }
    chmodSync(directoryPath, 0o700);
}

function writePrivateJson(filePath: string, value: unknown): void {
    const stagingPath = `${filePath}.partial-${Bun.randomUUIDv7()}`;
    try {
        writeFileSync(stagingPath, `${JSON.stringify(value, undefined, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(stagingPath, filePath);
    } catch (error) {
        rmSync(stagingPath, { force: true });
        throw error;
    }
}

function defaultAgentsConfig(openClawHome: string) {
    return {
        defaults: {
            model: { primary: "unknown" },
            models: {},
            workspace: path.join(openClawHome, "workspace"),
        },
        list: [{ default: true, id: "main" }],
    };
}

function sanitizedAgentConfigValue(value: unknown, openClawHome: string): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => sanitizedAgentConfigValue(item, openClawHome));
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replaceAll(/([a-z\d])([A-Z])/gu, "$1_$2");
        if (SENSITIVE_AGENT_CONFIG_KEY.test(normalizedKey)) {
            continue;
        }
        sanitized[key] =
            key === "workspace"
                ? path.join(openClawHome, "workspace")
                : sanitizedAgentConfigValue(child, openClawHome);
    }
    return sanitized;
}

function snapshotAgentsConfig(config: DevelopmentOpenClawSnapshotConfig): unknown {
    if (!config.configSource) {
        return defaultAgentsConfig(config.openClawHome);
    }
    if (!isRealRegularFile(config.configSource)) {
        throw new Error(
            `MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE must be a real regular file: ${config.configSource}`
        );
    }
    const stat = lstatSync(config.configSource);
    if (stat.size > MAX_OPENCLAW_CONFIG_BYTES) {
        throw new Error("Development OpenClaw config source is too large");
    }
    const parsed = Bun.JSON5.parse(readFileSync(config.configSource, "utf8")) as {
        agents?: unknown;
    };
    if (!parsed.agents || typeof parsed.agents !== "object") {
        return defaultAgentsConfig(config.openClawHome);
    }
    return sanitizedAgentConfigValue(parsed.agents, config.openClawHome);
}

function isEnvironmentTemplate(fileName: string): boolean {
    if (!fileName.startsWith(".env.")) return false;
    const suffix = fileName.slice(".env.".length).toLowerCase();
    return SAFE_ENVIRONMENT_TEMPLATE_SUFFIXES.has(suffix);
}

function shouldCopyWorkspacePath(sourceRoot: string, candidate: string): boolean {
    const relativePath = path.relative(sourceRoot, candidate);
    if (!relativePath) return true;
    const segments = relativePath.split(path.sep);
    if (
        segments.some((segment) =>
            OMITTED_WORKSPACE_DIRECTORIES.has(segment.toLowerCase())
        )
    ) {
        return false;
    }
    const fileName = segments.at(-1)?.toLowerCase() || "";
    return !(
        SENSITIVE_WORKSPACE_FILE_NAMES.has(fileName) ||
        (fileName.startsWith(".env.") && !isEnvironmentTemplate(fileName)) ||
        fileName.endsWith(".token") ||
        fileName.endsWith(".secret")
    );
}

function copyWorkspaceSnapshot(sourcePath: string, targetPath: string): void {
    if (!isRealDirectory(sourcePath)) {
        throw new Error(
            `MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE must be a real directory: ${sourcePath}`
        );
    }
    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
        throw new Error("Development workspace source and target must be distinct");
    }
    const stagingPath = `${targetPath}.partial-${Bun.randomUUIDv7()}`;
    try {
        cpSync(sourcePath, stagingPath, {
            errorOnExist: true,
            filter(source) {
                const stat = lstatSync(source);
                if (stat.isSymbolicLink()) {
                    throw new Error(
                        `Development workspace source contains a symlink: ${source}`
                    );
                }
                return shouldCopyWorkspacePath(sourcePath, source);
            },
            force: false,
            preserveTimestamps: true,
            recursive: true,
        });
        renameSync(stagingPath, targetPath);
    } catch (error) {
        rmSync(stagingPath, { force: true, recursive: true });
        throw error;
    }
}

/** Creates a writable workspace snapshot and a secret-free agent config for dev. */
export function prepareDevelopmentOpenClawSnapshot(
    config: DevelopmentOpenClawSnapshotConfig
): DevelopmentWorkspaceState {
    ensurePrivateDirectory(config.openClawHome);
    ensurePrivateDirectory(path.join(config.openClawHome, "agents"));
    const targetWorkspace = path.join(config.openClawHome, "workspace");
    let workspaceState: DevelopmentWorkspaceState;
    if (isRealDirectory(targetWorkspace)) {
        workspaceState = "reused";
    } else if (config.workspaceSource) {
        copyWorkspaceSnapshot(config.workspaceSource, targetWorkspace);
        workspaceState = "copied";
    } else {
        ensurePrivateDirectory(targetWorkspace);
        workspaceState = "empty";
    }
    chmodSync(targetWorkspace, 0o700);

    const visibleConfigPath = path.join(config.openClawHome, "openclaw.json");
    if (isRealRegularFile(visibleConfigPath)) {
        chmodSync(visibleConfigPath, 0o600);
    } else {
        writePrivateJson(visibleConfigPath, {
            agents: snapshotAgentsConfig(config),
        });
    }
    return workspaceState;
}
