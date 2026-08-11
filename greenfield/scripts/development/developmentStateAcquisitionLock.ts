import { guardedDevelopmentChildCommand } from "./developmentProcessGuard.ts";

const lockAcquireTimeoutMs = 5000;
const lockReleaseTimeoutMs = 5000;

interface OutputChunk {
    readonly done: boolean;
    readonly value?: Uint8Array;
}

export interface DevelopmentStateAcquisitionLock {
    release(): Promise<void>;
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
                    () =>
                        reject(
                            new Error(
                                "Development state lease acquisition lock timed out"
                            )
                        ),
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
    try {
        child.kill("SIGTERM");
    } catch {
        if (child.exitCode !== null) return;
        throw new Error("Development state lease acquisition lock could not stop");
    }
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
 * Serializes the short state-lease scan and publication window with a kernel lock.
 * The state directory itself is the lock target, so crashes leave no lock artifact.
 * @param stateRoot Owner-validated development state directory.
 * @returns A parent-death-guarded lock held until its idempotent release resolves.
 */
export async function acquireDevelopmentStateAcquisitionLock(
    stateRoot: string
): Promise<DevelopmentStateAcquisitionLock> {
    if (process.platform !== "linux") {
        throw new Error("Development state lease locking requires Linux");
    }
    const flock = Bun.which("flock");
    const shell = Bun.which("sh");
    if (flock === null || shell === null) {
        throw new Error("Development state lease locking requires flock and sh");
    }
    const child = Bun.spawn(
        [
            ...guardedDevelopmentChildCommand([
                flock,
                "--exclusive",
                "--no-fork",
                stateRoot,
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
        await stopLockHolder(child);
        await Promise.all([child.exited, new Response(child.stderr).text()]);
        throw new Error("Development state lease acquisition lock failed");
    }

    let releasePromise: Promise<void> | undefined;
    return Object.freeze({
        release(): Promise<void> {
            releasePromise ??= stopLockHolder(child);
            return releasePromise;
        },
    });
}
