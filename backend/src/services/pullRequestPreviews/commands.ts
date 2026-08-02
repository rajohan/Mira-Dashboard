import path from "node:path";

import { runProcess } from "../../lib/processes.ts";
import { ensureRealDirectory } from "./fileSystem.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

const MAX_COMMAND_BUFFER = 10 * 1024 * 1024;
const SAFE_INSTALL_ENVIRONMENT_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "TZ",
] as const;

interface CommandOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export async function runCommand(
    executable: string,
    arguments_: string[],
    options: CommandOptions = {}
): Promise<{ stderr: string; stdout: string }> {
    const result = await runProcess(executable, arguments_, {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: MAX_COMMAND_BUFFER,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 120_000,
    });
    if (result.code !== 0) {
        throw new Error(
            `${path.basename(executable)} exited ${result.code}: ${
                result.stderr.trim() || result.stdout.trim()
            }`
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

export async function runJsonCommand<T>(
    executable: string,
    arguments_: string[],
    options: CommandOptions = {}
): Promise<T> {
    const { stdout } = await runCommand(executable, arguments_, options);
    try {
        return JSON.parse(stdout) as T;
    } catch {
        throw new Error(`${path.basename(executable)} returned invalid JSON`);
    }
}

export function safeInstallEnvironment(
    config: PullRequestPreviewConfig
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of SAFE_INSTALL_ENVIRONMENT_KEYS) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
    }
    const installerHome = path.join(config.previewRoot, "installer-home");
    const cacheDirectory = path.join(config.previewRoot, "bun-cache");
    ensureRealDirectory(installerHome);
    ensureRealDirectory(cacheDirectory);
    environment.BUN_INSTALL_CACHE_DIR = cacheDirectory;
    environment.HOME = installerHome;
    environment.MIRA_DASHBOARD_PROJECT_ROOT = config.projectRoot;
    return environment;
}

export function githubCommandEnvironment(): Record<string, string | undefined> {
    const environment = { ...process.env };
    const githubToken =
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim();
    for (const key of Object.keys(environment)) {
        if (
            key === "MIRA_GITHUB_TOKEN" ||
            key === "RAJOHAN_GITHUB_TOKEN" ||
            key.startsWith("MIRA_GITHUB_TOKEN_") ||
            key.startsWith("RAJOHAN_GITHUB_TOKEN_")
        ) {
            delete environment[key];
        }
    }
    delete environment.GITHUB_TOKEN;
    if (githubToken) {
        environment.GH_TOKEN = githubToken;
    } else {
        delete environment.GH_TOKEN;
    }
    return environment;
}
