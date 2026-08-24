import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    quotaProviderProjectionSchema,
    type QuotaProviderProjection,
} from "../../contracts/quota.ts";

const responseMaximumBytes = 512 * 1024;
const requestTimeoutMs = 10_000;
const terminationGraceMs = 250;

const rateWindowSchema = v.strictObject({
    resetsAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    usedPercent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
    windowDurationMins: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
const rateLimitSchema = v.object({
    primary: v.nullable(rateWindowSchema),
    secondary: v.nullable(rateWindowSchema),
});
const rateLimitResponseSchema = v.object({
    rateLimits: v.optional(v.nullable(rateLimitSchema)),
    rateLimitsByLimitId: v.optional(v.record(v.string(), rateLimitSchema)),
});

interface CodexAppServerChild {
    readonly exited: Promise<number>;
    readonly stdin: {
        end(): void;
        write(value: Uint8Array): number | Promise<number>;
    };
    readonly stdout: ReadableStream<Uint8Array>;
    kill(signal?: number | NodeJS.Signals): void;
}

export interface CodexQuotaCollectorOptions {
    readonly codexHome: string;
    readonly executable: string;
    readonly home: string;
    readonly launch?: (
        executable: string,
        environment: Readonly<Record<string, string>>
    ) => CodexAppServerChild;
}

/**
 * Resolves one installed Codex CLI and its account state from bounded user locations.
 * @param home Exact operator home that owns Codex installation and account state.
 * @returns A unique verified collector configuration, or undefined when unavailable.
 */
export async function resolveCodexQuotaCollectorOptions(
    home: string
): Promise<CodexQuotaCollectorOptions | undefined> {
    if (!validAbsolutePath(home) || typeof process.getuid !== "function") return;
    const codexHome = path.join(home, ".codex");
    try {
        const codexHomeStatus = await lstat(codexHome);
        if (
            !codexHomeStatus.isDirectory() ||
            codexHomeStatus.isSymbolicLink() ||
            codexHomeStatus.uid !== process.getuid() ||
            (codexHomeStatus.mode & 0o002) !== 0
        ) {
            return;
        }
    } catch {
        return;
    }
    const candidates = [
        path.join(home, ".npm-global/bin/codex"),
        path.join(home, ".local/bin/codex"),
        path.join(home, ".bun/bin/codex"),
        "/usr/local/bin/codex",
        "/usr/bin/codex",
    ];
    const resolved = new Set<string>();
    for (const candidate of candidates) {
        try {
            const canonical = await realpath(candidate);
            const status = await lstat(canonical);
            if (
                status.isFile() &&
                !status.isSymbolicLink() &&
                (status.mode & 0o111) !== 0 &&
                ((status.uid === process.getuid() && (status.mode & 0o002) === 0) ||
                    (status.uid === 0 && (status.mode & 0o022) === 0))
            ) {
                resolved.add(canonical);
            }
        } catch {
            // An absent candidate is expected on hosts using another reviewed location.
        }
    }
    if (resolved.size !== 1) return;
    return Object.freeze({
        codexHome,
        executable: [...resolved][0]!,
        home,
    });
}

function unavailable(): never {
    throw new Error("Codex quota is unavailable");
}

function validAbsolutePath(value: string): boolean {
    return (
        path.isAbsolute(value) &&
        value !== path.parse(value).root &&
        path.normalize(value) === value &&
        !value.includes("\0")
    );
}

const defaultLaunch: NonNullable<CodexQuotaCollectorOptions["launch"]> = (
    executable,
    environment
) =>
    Bun.spawn([executable, "app-server", "--listen", "stdio://"], {
        env: environment,
        stderr: "ignore",
        stdin: "pipe",
        stdout: "pipe",
    });

async function send(child: CodexAppServerChild, message: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if ((await child.stdin.write(bytes)) !== bytes.byteLength) unavailable();
}

async function readRateLimitResult(
    child: CodexAppServerChild,
    signal: AbortSignal
): Promise<unknown> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let bytesRead = 0;
    try {
        while (!signal.aborted) {
            const next = await reader.read();
            if (next.done) unavailable();
            bytesRead += next.value.byteLength;
            if (bytesRead > responseMaximumBytes) unavailable();
            buffered += decoder.decode(next.value, { stream: true });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
                if (line.length === 0) continue;
                let message: unknown;
                try {
                    message = JSON.parse(line) as unknown;
                } catch {
                    unavailable();
                }
                if (typeof message !== "object" || message === null) unavailable();
                const record = message as Record<string, unknown>;
                if (record.id === 1 && record.error !== undefined) unavailable();
                if (record.id === 2) {
                    if (record.error !== undefined || record.result === undefined) {
                        unavailable();
                    }
                    return record.result;
                }
            }
        }
        return unavailable();
    } finally {
        reader.releaseLock();
    }
}

async function waitForExit(
    child: CodexAppServerChild,
    maximumWaitMs: number
): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), maximumWaitMs);
        timeout.unref?.();
    });
    try {
        return await Promise.race([
            child.exited.then(
                () => true as const,
                () => true as const
            ),
            deadline,
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

async function terminate(child: CodexAppServerChild): Promise<void> {
    try {
        child.stdin.end();
    } catch {
        // Process termination remains bounded even when stdin ownership is lost.
    }
    try {
        child.kill("SIGTERM");
    } catch {
        // The process may already have exited between the response and teardown.
    }
    if (await waitForExit(child, terminationGraceMs)) return;
    try {
        child.kill("SIGKILL");
    } catch {
        return;
    }
    await waitForExit(child, terminationGraceMs);
}

/**
 * Reads ChatGPT-managed Codex quota through the documented app-server JSON-RPC API.
 * @returns The normalized OpenAI quota window projection.
 */
export async function collectCodexQuota(
    options: CodexQuotaCollectorOptions,
    parentSignal?: AbortSignal
): Promise<QuotaProviderProjection> {
    parentSignal?.throwIfAborted();
    if (
        !validAbsolutePath(options.executable) ||
        !validAbsolutePath(options.codexHome) ||
        !validAbsolutePath(options.home)
    ) {
        throw new TypeError("Codex quota authority paths are invalid");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, requestTimeoutMs);
    let child: CodexAppServerChild | undefined;
    let kill: (() => void) | undefined;
    let projection: QuotaProviderProjection;
    try {
        parentSignal?.throwIfAborted();
        child = (options.launch ?? defaultLaunch)(options.executable, {
            CODEX_DISABLE_UPDATE_CHECK: "1",
            CODEX_HOME: options.codexHome,
            HOME: options.home,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            NO_UPDATE_NOTIFIER: "1",
            PATH: `${path.dirname(options.executable)}:/usr/bin:/bin`,
        });
        const activeChild = child;
        kill = () => activeChild.kill("SIGKILL");
        controller.signal.addEventListener("abort", kill, { once: true });
        await send(child, {
            id: 1,
            method: "initialize",
            params: {
                clientInfo: {
                    name: "mira_dashboard",
                    title: "Mira Dashboard",
                    version: "1.0.0",
                },
            },
        });
        await send(child, { method: "initialized", params: {} });
        await send(child, { id: 2, method: "account/rateLimits/read", params: {} });
        const result = v.parse(
            rateLimitResponseSchema,
            await readRateLimitResult(child, controller.signal)
        );
        const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
        if (bucket === undefined || bucket === null) unavailable();
        const windows = [bucket.primary, bucket.secondary]
            .filter((window): window is v.InferOutput<typeof rateWindowSchema> =>
                Boolean(window)
            )
            .toSorted((left, right) => left.windowDurationMins - right.windowDurationMins)
            .map((window) => ({
                resetsAtMs: window.resetsAt * 1000,
                usedPercent: window.usedPercent,
                windowDurationMinutes: window.windowDurationMins,
            }));
        if (windows.length === 0) unavailable();
        const usedPercent = Math.max(...windows.map((window) => window.usedPercent));
        projection = v.parse(quotaProviderProjectionSchema, {
            id: "openai",
            label: "OpenAI / Codex",
            remainingPercent: 100 - usedPercent,
            status: "available",
            usedPercent,
            windows,
        });
    } catch {
        parentSignal?.throwIfAborted();
        projection = v.parse(quotaProviderProjectionSchema, {
            id: "openai",
            label: "OpenAI / Codex",
            status: "unavailable",
        });
    } finally {
        clearTimeout(timeout);
        parentSignal?.removeEventListener("abort", abort);
        if (kill !== undefined) controller.signal.removeEventListener("abort", kill);
        if (child !== undefined) await terminate(child);
    }
    parentSignal?.throwIfAborted();
    return projection;
}
