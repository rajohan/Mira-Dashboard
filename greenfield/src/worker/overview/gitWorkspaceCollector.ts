import * as v from "valibot";

import {
    type GitWorkspaceCachePayload,
    type ManagedGitRepository,
    gitWorkspaceCachePayloadSchema,
    managedGitRepositorySchema,
} from "../../contracts/gitWorkspace.ts";

const gitExecutable = "/usr/bin/git";
const gitOutputMaximumBytes = 256 * 1024;
const gitTerminationWaitMs = 250;
const gitTimeoutMs = 10_000;

interface GitProcessResult {
    readonly exitCode: number;
    readonly stdout: Uint8Array;
}

export type GitWorkspaceProcess = (
    executable: string,
    arguments_: readonly string[],
    signal: AbortSignal,
    maximumBytes: number
) => Promise<GitProcessResult>;

interface GitWorkspaceChild {
    readonly exited: Promise<number>;
    readonly stdout: ReadableStream<Uint8Array>;
    kill(signal: "SIGKILL"): void;
}

type GitWorkspaceLaunch = (
    executable: string,
    arguments_: readonly string[],
    signal: AbortSignal
) => GitWorkspaceChild;

export interface ManagedGitRepositoryRoot {
    readonly id: ManagedGitRepository["id"];
    readonly root: string;
}

export interface GitWorkspaceCollectorOptions {
    readonly launch?: GitWorkspaceLaunch;
    readonly nowMs?: () => number;
    readonly process?: GitWorkspaceProcess;
}

async function readBoundedStream(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value;
            length += chunk.byteLength;
            if (length > maximumBytes) throw new Error("Git output exceeded its budget");
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

const defaultLaunch: GitWorkspaceLaunch = (executable, arguments_, signal) =>
    Bun.spawn([executable, ...arguments_], {
        env: {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            HOME: "/nonexistent",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: "/usr/bin:/bin",
        },
        killSignal: "SIGKILL",
        signal,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "pipe",
    });

async function waitForExit(child: GitWorkspaceChild): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, gitTerminationWaitMs);
        timeout.unref?.();
    });
    try {
        await Promise.race([
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

async function terminate(child: GitWorkspaceChild): Promise<void> {
    try {
        child.kill("SIGKILL");
    } catch {
        // The child may already have exited after its stream failed.
    }
    await waitForExit(child);
}

function createDefaultGitProcess(launch: GitWorkspaceLaunch): GitWorkspaceProcess {
    return async (executable, arguments_, signal, maximumBytes) => {
        if (signal.aborted) throw new Error("Git collection was aborted");
        const child = launch(executable, arguments_, signal);
        let rejectAborted: ((reason?: unknown) => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAborted = reject;
        });
        const abort = () => rejectAborted?.(new Error("Git collection was aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
            const [exitCode, stdout] = await Promise.race([
                Promise.all([
                    child.exited,
                    readBoundedStream(child.stdout, maximumBytes),
                ]),
                aborted,
            ]);
            return { exitCode, stdout };
        } catch (error) {
            await terminate(child);
            throw error;
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };
}

function emptyRepository(
    id: ManagedGitRepository["id"],
    state: "missing" | "unavailable"
): ManagedGitRepository {
    return {
        changedFileCount: 0,
        detached: false,
        id,
        stagedFileCount: 0,
        state,
        untrackedFileCount: 0,
    };
}

function parseGitStatus(
    id: ManagedGitRepository["id"],
    output: Uint8Array
): ManagedGitRepository {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
    const records = text.split("\0").filter((record) => record.length > 0);
    let branch: string | undefined;
    let headSha: string | undefined;
    let detached = false;
    let changedFileCount = 0;
    let stagedFileCount = 0;
    let untrackedFileCount = 0;

    for (const record of records) {
        if (record.startsWith("# branch.oid ")) {
            const candidate = record.slice("# branch.oid ".length);
            if (/^[0-9a-f]{40}$/u.test(candidate)) headSha = candidate;
            continue;
        }
        if (record.startsWith("# branch.head ")) {
            const candidate = record.slice("# branch.head ".length);
            if (candidate === "(detached)") detached = true;
            else branch = candidate;
            continue;
        }
        if (record.startsWith("? ")) {
            changedFileCount += 1;
            untrackedFileCount += 1;
            continue;
        }
        if (record.startsWith("! ")) continue;
        if (/^[12u] /u.test(record)) {
            changedFileCount += 1;
            const status = record.slice(2, 4);
            if (status[0] !== ".") stagedFileCount += 1;
        }
    }
    return v.parse(managedGitRepositorySchema, {
        ...(branch === undefined ? {} : { branch }),
        changedFileCount,
        detached,
        ...(headSha === undefined ? {} : { headSha }),
        id,
        stagedFileCount,
        state: "available",
        untrackedFileCount,
    });
}

async function collectRepository(
    repository: ManagedGitRepositoryRoot,
    parentSignal: AbortSignal | undefined,
    process: GitWorkspaceProcess
): Promise<ManagedGitRepository> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, gitTimeoutMs);
    try {
        if (parentSignal?.aborted) return emptyRepository(repository.id, "unavailable");
        const result = await process(
            gitExecutable,
            [
                "-C",
                repository.root,
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=normal",
            ],
            controller.signal,
            gitOutputMaximumBytes
        );
        if (result.exitCode !== 0) return emptyRepository(repository.id, "missing");
        return parseGitStatus(repository.id, result.stdout);
    } catch {
        return emptyRepository(repository.id, "unavailable");
    } finally {
        clearTimeout(timeout);
        parentSignal?.removeEventListener("abort", abort);
    }
}

/**
 * Collects three code-owned repository categories without exposing roots or filenames.
 * @param repositories Exact, canonically ordered managed repository roots.
 * @param signal Optional collection cancellation signal.
 * @param options Fixed process boundary overrides used by focused tests.
 * @returns The path-free managed Git projection.
 */
export async function collectGitWorkspacePayload(
    repositories: readonly ManagedGitRepositoryRoot[],
    signal?: AbortSignal,
    options: GitWorkspaceCollectorOptions = {}
): Promise<GitWorkspaceCachePayload> {
    const expected = ["dashboard", "docker", "openclaw"] as const;
    if (
        repositories.length !== expected.length ||
        !repositories.every((repository, index) => repository.id === expected[index])
    ) {
        throw new TypeError("Managed Git repository roots are invalid");
    }
    const gitProcess =
        options.process ?? createDefaultGitProcess(options.launch ?? defaultLaunch);
    const projections = await Promise.all(
        repositories.map((repository) =>
            collectRepository(repository, signal, gitProcess)
        )
    );
    return v.parse(gitWorkspaceCachePayloadSchema, {
        observedAtMs: (options.nowMs ?? Date.now)(),
        repositories: projections,
    });
}
