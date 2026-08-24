import { guardedDevelopmentChildCommand } from "./developmentProcessGuard.ts";

const lockAcquireTimeoutMs = 5000;
const lockReleaseTimeoutMs = 5000;
const lockReadySignal = "LOCKED\n";

export interface DevelopmentStateAcquisitionLock {
    release(): Promise<void>;
}

/**
 * Waits for the complete lock-holder readiness signal across arbitrary stream chunks.
 * @param stream Lock-holder standard output.
 * @returns Completion after the exact readiness signal has been observed.
 */
export async function waitForDevelopmentStateLockReadiness(
    stream: ReadableStream<Uint8Array>
): Promise<void> {
    const reader = stream.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const readSignal = async (): Promise<void> => {
        const decoder = new TextDecoder();
        let output = "";
        while (output.length < lockReadySignal.length) {
            const chunk = await reader.read();
            if (chunk.done === true || chunk.value === undefined) {
                throw new Error("Development state lease acquisition lock failed");
            }
            output += decoder.decode(chunk.value, { stream: true });
            if (!lockReadySignal.startsWith(output)) {
                throw new Error("Development state lease acquisition lock failed");
            }
        }
        output += decoder.decode();
        if (output !== lockReadySignal) {
            throw new Error("Development state lease acquisition lock failed");
        }
    };
    try {
        await Promise.race([
            readSignal(),
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
    try {
        await waitForDevelopmentStateLockReadiness(child.stdout);
    } catch (error) {
        await stopLockHolder(child);
        throw error;
    }

    let releasePromise: Promise<void> | undefined;
    return Object.freeze({
        release(): Promise<void> {
            releasePromise ??= stopLockHolder(child);
            return releasePromise;
        },
    });
}
