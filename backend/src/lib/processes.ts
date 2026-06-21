export interface RunProcessOptions {
    cwd?: string;
    detached?: boolean;
    env?: Record<string, string | undefined>;
    killSignal?: NodeJS.Signals;
    maxBuffer?: number;
    timeoutMs?: number;
}

export interface RunProcessResult {
    code: number;
    stderr: string;
    stdout: string;
}

export type BunProcess = ReturnType<typeof Bun.spawn>;

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_FORCE_KILL_GRACE_MS = 3_000;

async function readProcessText(
    stream: ReadableStream<Uint8Array> | null | undefined,
    maxBuffer: number
): Promise<string> {
    if (!stream) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.length > maxBuffer) {
                throw new Error(`Process output exceeded maxBuffer (${maxBuffer})`);
            }
        }
        text += decoder.decode();
        if (text.length > maxBuffer) {
            throw new Error(`Process output exceeded maxBuffer (${maxBuffer})`);
        }
        return text;
    } finally {
        reader.releaseLock();
    }
}

export function spawnProcess(
    executable: string,
    arguments_: readonly string[],
    options: RunProcessOptions = {}
): BunProcess {
    return Bun.spawn({
        cmd: [executable, ...arguments_],
        cwd: options.cwd,
        detached: options.detached ?? true,
        env: options.env,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
}

export function killProcessGroup(process_: BunProcess, signal: NodeJS.Signals): void {
    try {
        if (typeof process_.pid === "number") {
            process.kill(-process_.pid, signal);
            return;
        }
    } catch {
        // Fall back to Bun's process handle when process groups are unavailable.
    }
    process_.kill(signal);
}

export async function runProcess(
    executable: string,
    arguments_: readonly string[],
    options: RunProcessOptions = {}
): Promise<RunProcessResult> {
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const process = spawnProcess(executable, arguments_, options);
    let timeout: Timer | undefined;
    let forceKillTimeout: Timer | undefined;
    let didTimeout = false;
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            didTimeout = true;
            try {
                killProcessGroup(process, options.killSignal ?? "SIGTERM");
            } catch {
                // The process may already have exited between scheduling and timeout.
            }
            forceKillTimeout = setTimeout(() => {
                try {
                    killProcessGroup(process, "SIGKILL");
                } catch {
                    // The process may already have exited during the grace period.
                }
            }, DEFAULT_FORCE_KILL_GRACE_MS);
            forceKillTimeout.unref();
        }, timeoutMs);
        timeout.unref();
    }

    try {
        const [stdout, stderr, code] = await Promise.all([
            readProcessText(
                process.stdout as ReadableStream<Uint8Array> | undefined,
                maxBuffer
            ),
            readProcessText(
                process.stderr as ReadableStream<Uint8Array> | undefined,
                maxBuffer
            ),
            process.exited,
        ]);
        return { code: didTimeout && code === 0 ? 1 : code, stderr, stdout };
    } catch (error) {
        try {
            killProcessGroup(process, "SIGKILL");
        } catch {
            // Preserve the original read/exit error.
        }
        throw error;
    } finally {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
    }
}

export async function pipeProcessOutput(
    stream: ReadableStream<Uint8Array> | null | undefined,
    onChunk: (chunk: string) => void
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            onChunk(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) onChunk(tail);
    } finally {
        reader.releaseLock();
    }
}
