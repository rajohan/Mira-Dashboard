import { writeCliError, writeCliOutput } from "../../lib/cliOutput.ts";
import { errorMessage } from "../../lib/errors.ts";
import { resolveBunExecutable, runProcess } from "../../lib/processes.ts";
import { runLogRotationService } from "./core.ts";

const ELEVATED_LOG_ROTATION_TIMEOUT_MS = 5 * 60_000;
const ELEVATED_LOG_ROTATION_MAX_BUFFER = 16 * 1024 * 1024;
const ELEVATED_LOG_ROTATION_RUNTIME_ENVIRONMENT = [
    "LANG",
    "NODE_ENV",
    "TZ",
    "MIRA_DASHBOARD_PROJECT_ROOT",
] as const;
const ELEVATED_LOG_ROTATION_INTERNAL_ENVIRONMENT = [
    "MIRA_DASHBOARD_DB_PATH",
    "MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE",
] as const;

export interface ElevatedLogRotationResult {
    result: Record<string, unknown>;
    stderr: string;
}

function caughtMessage(error: unknown): string {
    return errorMessage(error, "Log rotation failed");
}

function elevatedLogRotationForwardedEnvironment(): readonly string[] {
    return process.env.NODE_ENV === "production"
        ? ELEVATED_LOG_ROTATION_RUNTIME_ENVIRONMENT
        : [
              ...ELEVATED_LOG_ROTATION_RUNTIME_ENVIRONMENT,
              ...ELEVATED_LOG_ROTATION_INTERNAL_ENVIRONMENT,
          ];
}

type ExecFileRunner = (
    file: string,
    arguments_: readonly string[],
    options: {
        encoding?: BufferEncoding;
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        signal?: AbortSignal;
        timeout?: number;
    }
) => Promise<{ stderr: string; stdout: string }>;

const elevatedLogRotationExecFileRunner: ExecFileRunner = async (
    file,
    arguments_,
    options
) => {
    const result = await runProcess(file, arguments_, {
        env: options.env,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        timeoutMs: options.timeout,
    });
    if (result.code !== 0) {
        throw Object.assign(
            new Error(result.stderr || `Command exited with code ${result.code}`),
            { stderr: result.stderr, stdout: result.stdout }
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
};

export async function runElevatedLogRotationService(options: {
    isDryRun: boolean;
    signal?: AbortSignal;
}): Promise<ElevatedLogRotationResult> {
    const modulePath = Bun.fileURLToPath(import.meta.url);
    const arguments_ = buildElevatedLogRotationCliArguments(modulePath, options);
    let stderr: string;
    let stdout: string;
    try {
        const output = await elevatedLogRotationExecFileRunner("sudo", arguments_, {
            encoding: "utf8",
            env: elevatedLogRotationEnvironment(),
            maxBuffer: ELEVATED_LOG_ROTATION_MAX_BUFFER,
            signal: options.signal,
            timeout: ELEVATED_LOG_ROTATION_TIMEOUT_MS,
        });
        stderr = output.stderr;
        stdout = output.stdout;
    } catch (error) {
        const failedOutput = error as { stderr?: unknown; stdout?: unknown };
        stderr = typeof failedOutput.stderr === "string" ? failedOutput.stderr : "";
        stdout = typeof failedOutput.stdout === "string" ? failedOutput.stdout : "";
        const trimmedFailure = stdout.trim();
        if (trimmedFailure) {
            const parsedFailure = parseJsonObjectFromOutput(trimmedFailure);
            if (parsedFailure) {
                return {
                    result: parsedFailure,
                    stderr,
                };
            }
        }
        const failureMessage = caughtMessage(error);
        return {
            result: { isOk: false, error: failureMessage, stdout: trimmedFailure },
            stderr: stderr ? `${stderr}\n${failureMessage}` : failureMessage,
        };
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
        const error = "Elevated log rotation returned empty JSON output";
        return {
            result: { isOk: false, error },
            stderr: stderr ? `${stderr}\n${error}` : error,
        };
    }
    try {
        const parsed = parseJsonObjectFromOutput(trimmed);
        if (parsed) {
            return {
                result: parsed,
                stderr,
            };
        }
        throw new Error("No JSON object found in stdout");
    } catch (error) {
        const parseError = caughtMessage(error);
        const parseContext = `Failed to parse elevated log rotation JSON: ${parseError}; stdout: ${trimmed}`;
        return {
            result: {
                isOk: false,
                error: "Failed to parse elevated log rotation JSON",
                parseError,
                stdout: trimmed,
            },
            stderr: stderr ? `${stderr}\n${parseContext}` : parseContext,
        };
    }
}

function parseJsonObjectFromOutput(output: string): Record<string, unknown> | undefined {
    const trimmed = output.trim();
    if (!trimmed) {
        return undefined;
    }

    for (let startIndex = 0; startIndex < trimmed.length; startIndex += 1) {
        if (trimmed[startIndex] !== "{") {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed.slice(startIndex)) as unknown;
            return asRecord(parsed);
        } catch {
            // Doppler can print a non-JSON banner before the real JSON payload.
        }
    }

    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function buildElevatedLogRotationCliArguments(
    modulePath: string,
    options: { isDryRun?: boolean } = {}
): string[] {
    const importLogRotationCli = [
        `import { runLogRotationCli } from ${JSON.stringify(Bun.pathToFileURL(modulePath).href)};`,
        "await runLogRotationCli();",
    ].join("\n");
    return [
        "-n",
        `--preserve-env=${elevatedLogRotationForwardedEnvironment().join(",")}`,
        resolveBunExecutable(),
        "--input-type=module",
        "--eval",
        importLogRotationCli,
        "--",
        "--json",
        ...(options.isDryRun ? ["--dry-run"] : []),
    ];
}

function elevatedLogRotationEnvironment(): NodeJS.ProcessEnv {
    const allowed = [
        "PATH",
        "HOME",
        ...elevatedLogRotationForwardedEnvironment(),
    ] as const;
    const environment: NodeJS.ProcessEnv = {};
    // Keep sudo environment preservation narrow: runtime lookup, locale, and state paths.
    for (const key of allowed) {
        if (process.env[key] !== undefined) {
            environment[key] = process.env[key];
        }
    }
    return environment;
}

export async function runLogRotationCli(): Promise<void> {
    try {
        const summary = await runLogRotationService({
            isDryRun: process.argv.includes("--dry-run"),
        });
        if (process.argv.includes("--json")) {
            writeCliOutput(JSON.stringify(summary));
        }
        if (!summary.isOk) {
            process.exitCode = 1;
        }
    } catch (error) {
        writeCliError(caughtMessage(error));
        process.exitCode = 1;
    }
}
