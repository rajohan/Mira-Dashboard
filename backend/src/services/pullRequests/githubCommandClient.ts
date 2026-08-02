import path from "node:path";

import type { ContractParser } from "../../../../contracts/runtime.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import { DASHBOARD_REPO, getDashboardRoot } from "./config.ts";

interface CommandResult {
    stdout: string;
    stderr: string;
}

export const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_JSON_LINE_LENGTH = 1024 * 1024;

export function trimOutput(value: string): string {
    return value.slice(-20_000);
}

/**
 * Splits an owner/name GitHub repository identifier.
 * @param repo Repo value.
 * @returns Parsed repo parts.
 */
export function parseRepoParts(repo: string): { owner: string; name: string } {
    const parts = repo.split("/");
    const [owner, name] = parts;
    if (!owner || !name || parts.length !== 2) {
        throw new Error("Dashboard repository must be configured as owner/name");
    }
    return { owner, name };
}

export function pullRequestStacksEndpoint(): string {
    const repo = parseRepoParts(DASHBOARD_REPO);
    return `repos/${repo.owner}/${repo.name}/stacks`;
}

/**
 * Builds GitHub command environment for one token.
 * @param githubToken Github token value.
 * @returns Built GitHub command environment for one token.
 */
function buildGithubCommandEnvironment(githubToken: string): NodeJS.ProcessEnv {
    const environment = { ...process.env };
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

/**
 * Builds command environment.
 * @returns Built command environment.
 */
export function buildCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken = configuredGithubReadToken();
    const environment = buildGithubCommandEnvironment(githubToken);
    const bunBinDirectory = path.join(
        nonEmptyEnvironmentFallback("HOME", "/home/ubuntu"),
        ".bun",
        "bin"
    );
    environment.PATH = [environment.PATH, bunBinDirectory]
        .filter(Boolean)
        .join(path.delimiter);
    return environment;
}

export function configuredGithubReadToken(): string {
    return (
        process.env.MIRA_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        ""
    );
}

/**
 * Builds reviewer command environment.
 * @returns Built reviewer command environment.
 */
export function buildReviewCommandEnvironment(): NodeJS.ProcessEnv {
    const githubToken = process.env.RAJOHAN_GITHUB_TOKEN?.trim() || "";
    if (!githubToken) {
        throw new Error("Rajohan GitHub review token is not configured");
    }
    return buildGithubCommandEnvironment(githubToken);
}

/**
 * Performs run command.
 * @param command Command value.
 * @param arguments_ Arguments value.
 * @param options Operation options.
 * @returns Run command result.
 */
export async function runCommand(
    command: string,
    arguments_: string[],
    options: {
        cwd?: string;
        environment?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {}
): Promise<CommandResult> {
    const { code, stderr, stdout } = await runProcess(command, arguments_, {
        cwd: options.cwd || getDashboardRoot(),
        env: options.environment || buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal: options.signal,
        timeoutMs: options.timeoutMs || 120_000,
    });
    if (code !== 0) {
        throw new Error(
            `${command} ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }

    return {
        stdout: trimOutput(String(stdout || "")),
        stderr: trimOutput(String(stderr || "")),
    };
}

/**
 * Runs a GitHub CLI command and parses its JSON output.
 * @param arguments_ Arguments value.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @param timeoutMs Maximum command runtime.
 * @returns Promise resolving to the run gh json result.
 */
export async function runGhJson<T>(
    arguments_: string[],
    parser: ContractParser<T>,
    signal?: AbortSignal,
    timeoutMs = 60_000
): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs,
    });
    if (code !== 0) {
        throw new Error(
            `gh ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }
    const output = stdout.trim();
    if (!output) {
        throw new Error("GitHub CLI returned an empty JSON response");
    }
    return parser(JSON.parse(output));
}

export class GitHubRestApiError extends Error {
    readonly endpoint: string;
    readonly statusCode: number | undefined;

    constructor(endpoint: string, statusCode: number | undefined, message: string) {
        super(message);
        this.name = "GitHubRestApiError";
        this.endpoint = endpoint;
        this.statusCode = statusCode;
    }
}

function parseIncludedGitHubResponse(output: string): {
    body: string;
    statusCode?: number;
} {
    const normalizedOutput = output.replaceAll("\r\n", "\n").trim();
    const statusMatch = /^HTTP\/\S+\s+(\d{3})[^\n]*\n/u.exec(normalizedOutput);
    if (!statusMatch) return { body: normalizedOutput };
    const bodySeparator = normalizedOutput.indexOf("\n\n", statusMatch[0].length);
    if (bodySeparator === -1) {
        throw new Error("GitHub CLI included response was missing its body separator");
    }
    return {
        body: normalizedOutput.slice(bodySeparator + 2).trim(),
        statusCode: Number(statusMatch[1]),
    };
}

/**
 * Runs one REST API request with `gh --include` so capability decisions use the
 * HTTP status line rather than mutable CLI error prose.
 * @param arguments_ GitHub CLI arguments, including `--include`.
 * @param endpoint REST endpoint used to scope capability errors.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @returns Parsed GitHub REST response.
 */
export async function runGhRestJson<T>(
    arguments_: string[],
    endpoint: string,
    parser: ContractParser<T>,
    signal?: AbortSignal
): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs: 60_000,
    });
    const response = parseIncludedGitHubResponse(stdout);
    if (code !== 0 || (response.statusCode !== undefined && response.statusCode >= 400)) {
        throw new GitHubRestApiError(
            endpoint,
            response.statusCode,
            `GitHub API ${endpoint} failed${
                response.statusCode === undefined
                    ? ` with exit code ${code}`
                    : ` with status ${response.statusCode}`
            }: ${stderr.trim() || response.body || "GitHub CLI returned no result"}`
        );
    }
    if (!response.body) {
        throw new Error("GitHub CLI returned an empty JSON response");
    }
    return parser(JSON.parse(response.body));
}

/**
 * Runs a GitHub API command whose documented terminal error states use JSON bodies.
 * @param arguments_ GitHub CLI arguments.
 * @param parser Runtime value parser.
 * @param signal Signal used to cancel the operation.
 * @param timeoutMs Maximum command runtime.
 * @returns Parsed GitHub response, including a documented non-2xx result body.
 */
export async function runGhJsonWithResultBody<T>(
    arguments_: string[],
    parser: ContractParser<T>,
    signal?: AbortSignal,
    timeoutMs = 60_000
): Promise<T> {
    const { code, stderr, stdout } = await runProcess("gh", arguments_, {
        cwd: getDashboardRoot(),
        env: buildCommandEnvironment(),
        maxBuffer: MAX_BUFFER,
        signal,
        timeoutMs,
    });
    const output = stdout.trim();
    if (output) {
        try {
            return parser(JSON.parse(output));
        } catch (error) {
            if (code === 0) throw error;
        }
    }
    throw new Error(
        `gh ${arguments_.join(" ")} failed with exit code ${code}: ${
            stderr.trim() || output || "GitHub CLI returned no result"
        }`
    );
}

/**
 * Appends one GitHub JSON-lines output row after size and blank-line validation.
 * @param line Line value.
 * @param rows Rows value.
 * @param parser Runtime value parser.
 */
function parseGhJsonLine<T>(line: string, rows: T[], parser: ContractParser<T>): void {
    if (!line.trim()) {
        return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_LENGTH) {
        throw new Error("GitHub CLI JSON line was too large");
    }
    rows.push(parser(JSON.parse(line)));
}

function toGhJsonParseError(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error(errorMessage(error, "Failed to parse GitHub CLI output"));
}

function clearForceKillTimerIfAllowed(
    forceKillTimer: NodeJS.Timeout | undefined,
    options: { keepForceKillTimer?: boolean },
    shouldPreserveForceKillTimer: boolean,
    clearTimer: (timer: NodeJS.Timeout) => void = clearTimeout
): NodeJS.Timeout | undefined {
    if (!forceKillTimer || shouldPreserveForceKillTimer || options.keepForceKillTimer) {
        return forceKillTimer;
    }
    clearTimer(forceKillTimer);
    return undefined;
}

/**
 * Streams newline-delimited JSON values from a GitHub CLI command.
 * @param arguments_ Arguments value.
 * @param parser Runtime value parser.
 * @param options Operation options.
 * @returns Promise resolving to the run gh json lines result.
 */
export async function runGhJsonLines<T>(
    arguments_: string[],
    parser: ContractParser<T>,
    options: { timeoutMs?: number } = {}
): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const child = spawnProcess("gh", arguments_, {
            cwd: getDashboardRoot(),
            env: buildCommandEnvironment(),
        });
        const rows: T[] = [];
        let stdoutBuffer = "";
        let stderr = "";
        let isSettled = false;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let isPreserveForceKillTimer = false;
        const terminateGhProcess = (signal: NodeJS.Signals) => {
            try {
                killProcessGroup(child, signal);
            } catch {
                // The process may already have exited or the process group may be gone.
            }
        };
        const armForceKillTimer = () => {
            if (forceKillTimer) {
                return;
            }

            forceKillTimer = setTimeout(() => {
                terminateGhProcess("SIGKILL");
            }, 5000);
            forceKillTimer.unref();
        };
        const timeout = setTimeout(() => {
            terminateGhProcess("SIGTERM");
            armForceKillTimer();
            isPreserveForceKillTimer = true;
            settle(() => reject(new Error("GitHub CLI command timed out")), {
                keepForceKillTimer: true,
            });
        }, options.timeoutMs || 60_000);

        const settle = (
            callback: () => void,
            options: { keepForceKillTimer?: boolean } = {}
        ) => {
            if (isSettled) {
                isPreserveForceKillTimer ||= Boolean(options.keepForceKillTimer);
                forceKillTimer = clearForceKillTimerIfAllowed(
                    forceKillTimer,
                    options,
                    isPreserveForceKillTimer
                );
                return;
            }
            isSettled = true;
            clearTimeout(timeout);
            isPreserveForceKillTimer ||= Boolean(options.keepForceKillTimer);
            forceKillTimer = clearForceKillTimerIfAllowed(
                forceKillTimer,
                options,
                isPreserveForceKillTimer
            );
            callback();
        };

        const stdoutDone = pipeProcessOutput(
            child.stdout as ReadableStream<Uint8Array> | undefined,
            (chunk) => {
                if (isSettled) return;
                stdoutBuffer += chunk;

                const lines = stdoutBuffer.split("\n");
                stdoutBuffer = lines.pop() || "";
                if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_LINE_LENGTH) {
                    terminateGhProcess("SIGTERM");
                    armForceKillTimer();
                    settle(
                        () => reject(new Error("GitHub CLI JSON line was too large")),
                        {
                            keepForceKillTimer: true,
                        }
                    );
                    return;
                }
                try {
                    for (const line of lines) {
                        if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_LENGTH) {
                            terminateGhProcess("SIGTERM");
                            armForceKillTimer();
                            settle(
                                () =>
                                    reject(
                                        new Error("GitHub CLI JSON line was too large")
                                    ),
                                {
                                    keepForceKillTimer: true,
                                }
                            );
                            return;
                        }
                        parseGhJsonLine(line, rows, parser);
                    }
                } catch (error) {
                    terminateGhProcess("SIGTERM");
                    armForceKillTimer();
                    settle(() => reject(toGhJsonParseError(error)), {
                        keepForceKillTimer: true,
                    });
                }
            }
        );

        const stderrDone = pipeProcessOutput(
            child.stderr as ReadableStream<Uint8Array> | undefined,
            (chunk) => {
                if (isSettled) return;
                stderr = trimOutput(stderr + chunk);
            }
        );

        void (async () => {
            try {
                const code = await child.exited;
                await Promise.all([stdoutDone, stderrDone]);
                isPreserveForceKillTimer = false;
                forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
                settle(() => {
                    if (code !== 0) {
                        reject(
                            new Error(stderr || `GitHub CLI exited with code ${code}`)
                        );
                        return;
                    }
                    try {
                        parseGhJsonLine(stdoutBuffer, rows, parser);
                        resolve(rows);
                    } catch (error) {
                        reject(toGhJsonParseError(error));
                    }
                });
            } catch (error) {
                isPreserveForceKillTimer = false;
                forceKillTimer = clearForceKillTimerIfAllowed(forceKillTimer, {}, false);
                settle(() =>
                    reject(
                        error instanceof Error
                            ? error
                            : new Error("GitHub CLI request failed", { cause: error })
                    )
                );
            }
        })();
    });
}
