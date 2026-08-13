import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";
import { PreviewHostError } from "./previewTypes.ts";

const tailscaleExecutable = "/usr/bin/tailscale";
const flockExecutable = "/usr/bin/flock";
const teeExecutable = "/usr/bin/tee";
const commandDeadlineMs = 15_000;
const lockDeadlineMs = 5000;
const commandOutputMaximumBytes = 64 * 1024;
const privateFileMode = 0o600;
export const previewTailscaleHttpsPort = 3445;

const tailscaleStatusSchema = v.looseObject({
    Self: v.looseObject({
        DNSName: v.string("Tailscale status is invalid"),
    }),
});

const tailscaleProxyHandlerSchema = v.looseObject({
    Proxy: v.optional(v.string()),
});
const tailscaleWebServerSchema = v.looseObject({
    Handlers: v.optional(v.record(v.string(), tailscaleProxyHandlerSchema)),
});
const tailscaleServeStatusSchema = v.looseObject({
    AllowFunnel: v.optional(v.record(v.string(), v.boolean())),
    TCP: v.optional(
        v.record(v.string(), v.looseObject({ HTTPS: v.optional(v.boolean()) }))
    ),
    Web: v.optional(v.record(v.string(), tailscaleWebServerSchema)),
});

export interface PreviewTailscaleProcessRequest {
    readonly command: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}

export interface PreviewTailscaleProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type PreviewTailscaleProcessRunner = (
    request: PreviewTailscaleProcessRequest
) => Promise<PreviewTailscaleProcessResult>;

export interface PreviewTailscaleRouteStatus {
    readonly enabled: boolean;
    readonly origin: string;
    readonly target: string;
}

export interface PreviewTailscaleServePort {
    readonly inspect: (
        ingressSocket: string,
        signal?: AbortSignal
    ) => Promise<PreviewTailscaleRouteStatus>;
    readonly start: (
        ingressSocket: string,
        expectedOrigin: string,
        beforeMutation: () => Promise<void>,
        signal?: AbortSignal
    ) => Promise<PreviewTailscaleRouteStatus>;
    readonly stopOwned: (
        ingressSocket: string,
        expectedOrigin: string,
        signal?: AbortSignal
    ) => Promise<PreviewTailscaleRouteStatus>;
}

export interface PreviewTailscaleServeDependencies {
    readonly acquireLock?: (
        signal?: AbortSignal
    ) => Promise<Readonly<{ release: () => Promise<void> }>>;
    readonly processRunner?: PreviewTailscaleProcessRunner;
    readonly runtimeUserId?: number;
}

function fail(): never {
    throw new PreviewHostError({ reason: "operation-failed" });
}

function noValue(): undefined {
    return;
}

function requiredUserId(configured?: number): number {
    const value = configured ?? process.getuid?.();
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) fail();
    return value;
}

function fixedEnvironment(userId: number): Readonly<Record<string, string>> {
    const runtimeDirectory = `/run/user/${userId}`;
    return Object.freeze({
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: runtimeDirectory,
    });
}

function abortScope(parent: AbortSignal | undefined, deadlineMs: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, deadlineMs);
    timer.unref?.();
    return Object.freeze({
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener("abort", abort);
        },
        signal: controller.signal,
    });
}

function safeCommand(command: readonly string[]): boolean {
    return (
        command.length > 0 &&
        command.length <= 16 &&
        command.every(
            (argument) =>
                argument.length > 0 &&
                argument.length <= 4096 &&
                !argument.includes("\0") &&
                hasNoUnicodeControlOrFormat(argument)
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
            if (total > commandOutputMaximumBytes) fail();
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function defaultProcessRunner(
    request: PreviewTailscaleProcessRequest
): Promise<PreviewTailscaleProcessResult> {
    if (!safeCommand(request.command)) fail();
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
        return fail();
    }
}

async function run(
    runner: PreviewTailscaleProcessRunner,
    environment: Readonly<Record<string, string>>,
    command: readonly string[],
    signal?: AbortSignal
): Promise<PreviewTailscaleProcessResult> {
    if (!safeCommand(command)) fail();
    const scope = abortScope(signal, commandDeadlineMs);
    try {
        return await runner({ command, environment, signal: scope.signal });
    } catch {
        return fail();
    } finally {
        scope.dispose();
    }
}

function decodeJson(bytes: Uint8Array): unknown {
    if (bytes.byteLength === 0 || bytes.byteLength > commandOutputMaximumBytes) fail();
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        return fail();
    }
}

function ingressTarget(ingressSocket: string): string {
    if (
        !path.isAbsolute(ingressSocket) ||
        path.normalize(ingressSocket) !== ingressSocket ||
        ingressSocket.includes("\0") ||
        !hasNoUnicodeControlOrFormat(ingressSocket) ||
        Buffer.byteLength(ingressSocket) > 4096
    ) {
        fail();
    }
    return `unix:${ingressSocket}`;
}

function dnsName(input: unknown): string {
    let status: v.InferOutput<typeof tailscaleStatusSchema>;
    try {
        status = v.parse(tailscaleStatusSchema, input);
    } catch {
        return fail();
    }
    const name = status.Self.DNSName.trim().replace(/\.$/u, "").toLowerCase();
    if (
        name.length === 0 ||
        name.length > 253 ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name) ||
        name.split(".").some((label) => label.length === 0 || label.length > 63)
    ) {
        fail();
    }
    return name;
}

export function projectPreviewTailscaleRoute(
    nodeStatus: unknown,
    serveStatusInput: unknown,
    ingressSocket: string,
    httpsPort = previewTailscaleHttpsPort
): PreviewTailscaleRouteStatus {
    if (!Number.isSafeInteger(httpsPort) || httpsPort < 1 || httpsPort > 65_535) {
        fail();
    }
    const name = dnsName(nodeStatus);
    const target = ingressTarget(ingressSocket);
    let serveStatus: v.InferOutput<typeof tailscaleServeStatusSchema>;
    try {
        serveStatus = v.parse(tailscaleServeStatusSchema, serveStatusInput);
    } catch {
        return fail();
    }
    const webKey = `${name}:${httpsPort}`;
    const webKeys = Object.keys(serveStatus.Web ?? {}).filter((key) =>
        key.endsWith(`:${httpsPort}`)
    );
    const handlers = serveStatus.Web?.[webKey]?.Handlers;
    const handlerKeys = Object.keys(handlers ?? {});
    const tcp = serveStatus.TCP?.[String(httpsPort)];
    const tcpKeys = Object.keys(tcp ?? {});
    const funnel = serveStatus.AllowFunnel?.[webKey] === true;
    const exact =
        !funnel &&
        tcpKeys.length === 1 &&
        tcpKeys[0] === "HTTPS" &&
        tcp?.HTTPS === true &&
        webKeys.length === 1 &&
        webKeys[0] === webKey &&
        handlerKeys.length === 1 &&
        handlerKeys[0] === "/" &&
        handlers?.["/"]?.Proxy === target;
    const occupied = tcp !== undefined || webKeys.length > 0 || funnel;
    if (occupied && !exact) fail();
    return Object.freeze({
        enabled: exact,
        origin: `https://${name}:${httpsPort}`,
        target,
    });
}

async function acquireProcessLock(
    userId: number,
    signal?: AbortSignal
): Promise<Readonly<{ release: () => Promise<void> }>> {
    if (process.platform !== "linux" || process.getuid?.() !== userId) fail();
    const runtimeDirectory = `/run/user/${userId}`;
    const [canonical, metadata] = await Promise.all([
        realpath(runtimeDirectory),
        lstat(runtimeDirectory),
    ]).catch(() => fail());
    if (
        canonical !== runtimeDirectory ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== userId ||
        (metadata.mode & 0o077) !== 0
    ) {
        fail();
    }
    const lockPath = path.join(
        runtimeDirectory,
        `mira-dashboard-preview-tailscale-${previewTailscaleHttpsPort}.lock`
    );
    let file;
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    try {
        file = await open(
            lockPath,
            constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
            privateFileMode
        );
        await file.chmod(privateFileMode);
        const status = await file.stat();
        if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.uid !== userId ||
            status.nlink !== 1 ||
            (status.mode & 0o777) !== privateFileMode
        ) {
            fail();
        }
        const environment = fixedEnvironment(userId);
        const scope = abortScope(signal, lockDeadlineMs);
        child = Bun.spawn<"pipe", "pipe", "pipe">(
            [
                flockExecutable,
                "--exclusive",
                "--nonblock",
                "--no-fork",
                "3",
                teeExecutable,
            ],
            {
                cwd: "/",
                env: { ...environment },
                killSignal: "SIGKILL",
                signal: scope.signal,
                stdio: ["pipe", "pipe", "pipe", file.fd],
            }
        );
        await file.close();
        file = undefined;
        let acquired = false;
        try {
            await child.stdin.write("LOCKED\n");
            await child.stdin.flush();
            const reader = child.stdout.getReader();
            try {
                const first = await reader.read();
                if (
                    first.done ||
                    first.value === undefined ||
                    new TextDecoder("utf-8", { fatal: true }).decode(first.value) !==
                        "LOCKED\n"
                ) {
                    fail();
                }
                acquired = true;
            } finally {
                reader.releaseLock();
            }
        } catch {
            child.kill();
            await child.exited.catch(noValue);
            scope.dispose();
            return fail();
        }
        if (!acquired) fail();
        let releasePromise: Promise<void> | undefined;
        return Object.freeze({
            release() {
                releasePromise ??= (async () => {
                    try {
                        await child!.stdin.end();
                        const exited = await Promise.race([
                            child!.exited.then(() => true),
                            Bun.sleep(2000).then(() => false),
                        ]);
                        if (!exited) {
                            child!.kill();
                            await child!.exited.catch(noValue);
                        }
                    } finally {
                        scope.dispose();
                    }
                })();
                return releasePromise;
            },
        });
    } catch (error) {
        child?.kill();
        await child?.exited.catch(noValue);
        if (error instanceof PreviewHostError) throw error;
        return fail();
    } finally {
        await file?.close().catch(noValue);
    }
}

/**
 * Creates the sole fixed, exact Tailscale Serve publication authority for previews.
 * @param dependencies Injectable process and lock boundaries for focused tests.
 * @returns Exact preview publication authority.
 */
export function createPreviewTailscaleServe(
    dependencies: PreviewTailscaleServeDependencies = {}
): PreviewTailscaleServePort {
    const userId = requiredUserId(dependencies.runtimeUserId);
    const environment = fixedEnvironment(userId);
    const runner = dependencies.processRunner ?? defaultProcessRunner;
    const acquireLock =
        dependencies.acquireLock ??
        ((signal?: AbortSignal) => acquireProcessLock(userId, signal));

    const inspect = async (
        ingressSocket: string,
        signal?: AbortSignal
    ): Promise<PreviewTailscaleRouteStatus> => {
        const [node, serve] = await Promise.all([
            run(runner, environment, [tailscaleExecutable, "status", "--json"], signal),
            run(
                runner,
                environment,
                [tailscaleExecutable, "serve", "status", "--json"],
                signal
            ),
        ]);
        if (node.exitCode !== 0 || serve.exitCode !== 0) fail();
        return projectPreviewTailscaleRoute(
            decodeJson(node.stdout),
            decodeJson(serve.stdout),
            ingressSocket
        );
    };

    const withLock = async <T>(
        signal: AbortSignal | undefined,
        operation: () => Promise<T>
    ): Promise<T> => {
        const lock = await acquireLock(signal).catch(() => fail());
        try {
            return await operation();
        } finally {
            await lock.release().catch(() => fail());
        }
    };

    const start: PreviewTailscaleServePort["start"] = (
        ingressSocket,
        expectedOrigin,
        beforeMutation,
        signal
    ) =>
        withLock(signal, async () => {
            const before = await inspect(ingressSocket, signal);
            if (before.enabled || before.origin !== expectedOrigin) fail();
            await beforeMutation().catch(() => fail());
            const command = [
                tailscaleExecutable,
                "serve",
                "--bg",
                `--https=${previewTailscaleHttpsPort}`,
                before.target,
            ] as const;
            const mutation = await run(runner, environment, command, signal);
            const after = await inspect(ingressSocket, signal);
            if (!after.enabled || after.origin !== expectedOrigin) fail();
            if (mutation.exitCode !== 0) {
                // Exact post-state attribution wins over a lost command settlement.
                return after;
            }
            return after;
        });

    const stopOwned: PreviewTailscaleServePort["stopOwned"] = (
        ingressSocket,
        expectedOrigin,
        signal
    ) =>
        withLock(signal, async () => {
            const before = await inspect(ingressSocket, signal);
            if (before.origin !== expectedOrigin) fail();
            if (!before.enabled) return before;
            const mutation = await run(
                runner,
                environment,
                [
                    tailscaleExecutable,
                    "serve",
                    `--https=${previewTailscaleHttpsPort}`,
                    "off",
                ],
                signal
            );
            const after = await inspect(ingressSocket, signal);
            if (after.enabled) fail();
            if (mutation.exitCode !== 0) return after;
            return after;
        });

    return Object.freeze({ inspect, start, stopOwned });
}
