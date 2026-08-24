import { previewTailscaleOperatorUser } from "./policy.ts";

const tailscaleExecutable = "/usr/bin/tailscale";
const commandDeadlineMs = 15_000;
const outputMaximumBytes = 64 * 1024;
const failureMessage = "Preview Tailscale operator provisioning failed";
const usage = "Usage: bun operator.ts --mode=apply|verify";

export interface PreviewTailscaleOperatorProcessRequest {
    readonly command: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}

export interface PreviewTailscaleOperatorProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type PreviewTailscaleOperatorProcessRunner = (
    request: PreviewTailscaleOperatorProcessRequest
) => Promise<PreviewTailscaleOperatorProcessResult>;

export interface PreviewTailscaleOperatorDependencies {
    readonly processRunner?: PreviewTailscaleOperatorProcessRunner;
    readonly userId?: number;
}

function failure(): Error {
    return new Error(failureMessage);
}

function noValue(): void {}

function fixedEnvironment(): Readonly<Record<string, string>> {
    return Object.freeze({
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
    });
}

function safeCommand(command: readonly string[]): boolean {
    return (
        command.length > 0 &&
        command.length <= 8 &&
        command.every(
            (argument) =>
                argument.length > 0 && argument.length <= 256 && !argument.includes("\0")
        )
    );
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > outputMaximumBytes) throw failure();
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function defaultProcessRunner(
    request: PreviewTailscaleOperatorProcessRequest
): Promise<PreviewTailscaleOperatorProcessResult> {
    if (!safeCommand(request.command)) throw failure();
    const child = Bun.spawn([...request.command], {
        cwd: "/",
        env: { ...request.environment },
        killSignal: "SIGKILL",
        signal: request.signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stderr, stdout] = await Promise.all([
            child.exited,
            readBounded(child.stderr),
            readBounded(child.stdout),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(noValue);
        throw failure();
    }
}

async function run(
    runner: PreviewTailscaleOperatorProcessRunner,
    command: readonly string[]
): Promise<PreviewTailscaleOperatorProcessResult> {
    if (!safeCommand(command)) throw failure();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), commandDeadlineMs);
    timer.unref?.();
    try {
        return await runner({
            command,
            environment: fixedEnvironment(),
            signal: controller.signal,
        });
    } catch {
        throw failure();
    } finally {
        clearTimeout(timer);
    }
}

function parsePreferences(bytes: Uint8Array): Readonly<{ OperatorUser?: string }> {
    if (bytes.byteLength === 0 || bytes.byteLength > outputMaximumBytes) throw failure();
    try {
        const value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        ) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw failure();
        }
        const operatorUser = (value as Record<string, unknown>).OperatorUser;
        if (operatorUser !== undefined && typeof operatorUser !== "string") {
            throw failure();
        }
        return operatorUser === undefined ? {} : { OperatorUser: operatorUser };
    } catch {
        throw failure();
    }
}

/** Verifies the exact least-authority Tailscale CLI delegation needed by previews. */
export async function verifyPreviewTailscaleOperator(
    dependencies: PreviewTailscaleOperatorDependencies = {}
): Promise<void> {
    if (process.platform !== "linux") throw failure();
    const result = await run(dependencies.processRunner ?? defaultProcessRunner, [
        tailscaleExecutable,
        "debug",
        "prefs",
    ]);
    if (result.exitCode !== 0) throw failure();
    const preferences = parsePreferences(result.stdout);
    if (preferences.OperatorUser !== previewTailscaleOperatorUser) throw failure();
}

/** Applies and then verifies the one-time root-owned Tailscale operator delegation. */
export async function installPreviewTailscaleOperator(
    dependencies: PreviewTailscaleOperatorDependencies = {}
): Promise<void> {
    const userId = dependencies.userId ?? process.getuid?.();
    if (userId !== 0) throw failure();
    const runner = dependencies.processRunner ?? defaultProcessRunner;
    const result = await run(runner, [
        tailscaleExecutable,
        "set",
        `--operator=${previewTailscaleOperatorUser}`,
    ]);
    if (result.exitCode !== 0) throw failure();
    await verifyPreviewTailscaleOperator({ processRunner: runner, userId });
}

function parseMode(arguments_: readonly string[]): "apply" | "verify" {
    if (arguments_.length !== 1) throw new TypeError(usage);
    if (arguments_[0] === "--mode=apply") return "apply";
    if (arguments_[0] === "--mode=verify") return "verify";
    throw new TypeError(usage);
}

async function runMode(mode: "apply" | "verify"): Promise<void> {
    switch (mode) {
        case "apply": {
            await installPreviewTailscaleOperator();
            return;
        }
        case "verify": {
            await verifyPreviewTailscaleOperator();
        }
    }
}

if (import.meta.main) {
    try {
        const mode = parseMode(Bun.argv.slice(2));
        await runMode(mode);
        process.stdout.write(
            `${JSON.stringify({ operator: previewTailscaleOperatorUser, status: "VERIFIED" })}\n`
        );
    } catch (error) {
        process.stderr.write(
            `${error instanceof TypeError ? error.message : failureMessage}\n`
        );
        process.exitCode = 1;
    }
}
