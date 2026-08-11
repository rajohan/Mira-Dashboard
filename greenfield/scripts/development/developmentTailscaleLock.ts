import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { guardedDevelopmentChildCommand } from "./developmentProcessGuard.ts";

const lockAcquireTimeoutMs = 5000;
const lockReleaseTimeoutMs = 5000;
const privateFileMode = 0o600;

interface OutputChunk {
    readonly done: boolean;
    readonly value?: Uint8Array;
}

export interface DevelopmentTailscaleRouteLock {
    readonly httpsPort: number;
    release(): Promise<void>;
}

function errorCode(error: unknown): unknown {
    return typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
}

async function privateRuntimeDirectory(): Promise<string> {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw new Error("Tailscale development route locking requires Linux");
    }
    const userId = process.getuid();
    const runtimeDirectory = `/run/user/${userId}`;
    const [canonicalPath, status] = await Promise.all([
        realpath(runtimeDirectory),
        lstat(runtimeDirectory),
    ]);
    if (
        canonicalPath !== runtimeDirectory ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== userId ||
        (status.mode & 0o077) !== 0
    ) {
        throw new Error("Tailscale development runtime directory is invalid");
    }
    return runtimeDirectory;
}

async function prepareLockFile(lockPath: string): Promise<void> {
    try {
        const file = await open(lockPath, "wx", privateFileMode);
        await file.close();
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
    }
    const status = await lstat(lockPath);
    if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.uid !== process.getuid?.() ||
        (status.mode & 0o777) !== privateFileMode
    ) {
        throw new Error("Tailscale development route lock file is invalid");
    }
}

async function firstOutputChunk(
    stream: ReadableStream<Uint8Array>
): Promise<OutputChunk> {
    const reader = stream.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Tailscale route lock acquisition timed out")),
                    lockAcquireTimeoutMs
                );
                timeout.unref?.();
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        reader.releaseLock();
    }
}

async function stopLockHolder(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(lockReleaseTimeoutMs).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
    }
}

/**
 * Acquires one host-local advisory lock for a Tailscale HTTPS port.
 * @param httpsPort Validated Tailscale Serve port.
 * @returns A parent-death-guarded lock held until its idempotent release resolves.
 */
export async function acquireDevelopmentTailscaleRouteLock(
    httpsPort: number
): Promise<DevelopmentTailscaleRouteLock> {
    if (!Number.isSafeInteger(httpsPort) || httpsPort < 1 || httpsPort > 65_535) {
        throw new TypeError("Tailscale development route lock port is invalid");
    }
    const runtimeDirectory = await privateRuntimeDirectory();
    const lockPath = path.join(
        runtimeDirectory,
        `mira-dashboard-development-tailscale-${httpsPort}.lock`
    );
    await prepareLockFile(lockPath);
    const flock = Bun.which("flock");
    const shell = Bun.which("sh");
    if (flock === null || shell === null) {
        throw new Error("Tailscale development route locking requires flock and sh");
    }
    const child = Bun.spawn(
        [
            ...guardedDevelopmentChildCommand([
                flock,
                "--exclusive",
                "--nonblock",
                "--no-fork",
                lockPath,
                shell,
                "-c",
                'printf "LOCKED\\n"\nIFS= read -r _',
            ]),
        ],
        {
            env: {
                LANG: "C",
                LC_ALL: "C",
                PATH: process.env.PATH ?? "/usr/bin:/bin",
            },
            stderr: "pipe",
            stdin: "pipe",
            stdout: "pipe",
        }
    );
    let ready: OutputChunk;
    try {
        ready = await firstOutputChunk(child.stdout);
    } catch (error) {
        await stopLockHolder(child);
        throw error;
    }
    if (
        ready.done === true ||
        ready.value === undefined ||
        new TextDecoder().decode(ready.value) !== "LOCKED\n"
    ) {
        const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
        ]);
        throw new Error(
            exitCode === 1
                ? `Tailscale development route ${httpsPort} is already in use`
                : `Tailscale development route lock failed${
                      stderr.trim() === "" ? "" : ": flock failed"
                  }`
        );
    }

    let releasePromise: Promise<void> | undefined;
    return Object.freeze({
        httpsPort,
        release(): Promise<void> {
            releasePromise ??= stopLockHolder(child);
            return releasePromise;
        },
    });
}
