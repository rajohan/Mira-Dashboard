import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { Redacted } from "effect";

import { PreviewHostError, type PreviewStartRequest } from "./previewTypes.ts";

const gitExecutable = "/usr/bin/git";
const fixedPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const processOutputMaximumBytes = 1024 * 1024;
const processTimeoutMs = 3 * 60 * 1000;
const installTimeoutMs = 8 * 60 * 1000;
const directoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface PreviewProcessRequest {
    readonly arguments: readonly string[];
    readonly cwd?: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

export interface PreviewProcessResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

export type PreviewProcessRunner = (
    request: PreviewProcessRequest
) => Promise<PreviewProcessResult>;

export interface PreviewGitAuthority {
    readonly token: Redacted.Redacted<string>;
}

export interface PreviewWorktreeOptions {
    readonly bunExecutable: string;
    readonly checkoutRoot: string;
    readonly credentials: PreviewGitAuthority;
    readonly processRunner?: PreviewProcessRunner;
    readonly worktreePath: string;
}

function fail(reason: PreviewHostError["reason"]): never {
    throw new PreviewHostError({ reason });
}

function cleanEnvironment(): Readonly<Record<string, string>> {
    return Object.freeze({
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_KEY_1: "core.hooksPath",
        GIT_CONFIG_KEY_2: "protocol.file.allow",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_VALUE_1: "/dev/null",
        GIT_CONFIG_VALUE_2: "never",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: fixedPath,
    });
}

function authenticatedGitEnvironment(token: string): Readonly<Record<string, string>> {
    const authorization = new TextEncoder().encode(`x-access-token:${token}`).toBase64();
    return Object.freeze({
        ...cleanEnvironment(),
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_KEY_3: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_3: `Authorization: Basic ${authorization}`,
    });
}

export async function readBoundedPreviewProcessOutput(
    stream: ReadableStream<Uint8Array>,
    abort: AbortController
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            total += result.value.byteLength;
            if (total > processOutputMaximumBytes) {
                abort.abort();
                await reader.cancel("Preview process output exceeded its budget");
                fail("operation-failed");
            }
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function defaultProcessRunner(
    request: PreviewProcessRequest
): Promise<PreviewProcessResult> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), request.timeoutMs);
    timeout.unref?.();
    const onAbort = () => abort.abort();
    if (request.signal?.aborted) abort.abort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const child = Bun.spawn([request.executable, ...request.arguments], {
            cwd: request.cwd,
            env: request.environment,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        });
        abort.signal.addEventListener(
            "abort",
            () => {
                child.kill("SIGTERM");
            },
            { once: true }
        );
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedPreviewProcessOutput(child.stdout, abort),
            readBoundedPreviewProcessOutput(child.stderr, abort),
        ]);
        return {
            exitCode,
            stderr: new TextDecoder("utf-8", { fatal: true }).decode(stderr),
            stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdout),
        };
    } catch {
        return fail("operation-failed");
    } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
    }
}

async function runChecked(
    runner: PreviewProcessRunner,
    request: PreviewProcessRequest
): Promise<PreviewProcessResult> {
    const result = await runner(request);
    if (result.exitCode !== 0) fail("operation-failed");
    return result;
}

async function assertCanonicalRoot(root: string): Promise<void> {
    try {
        const canonical = await realpath(root);
        const metadata = await stat(root, { bigint: true });
        if (canonical !== root || !metadata.isDirectory() || metadata.isSymbolicLink()) {
            fail("path-unsafe");
        }
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        fail("path-unsafe");
    }
}

function detachedWorktreeGitDirectory(contents: string): string {
    const line = contents.trim();
    if (!/^gitdir: \/[^\r\n\0]+$/u.test(line)) fail("path-unsafe");
    const directory = line.slice("gitdir: ".length);
    if (
        !path.isAbsolute(directory) ||
        path.normalize(directory) !== directory ||
        directory.includes("\0")
    ) {
        fail("path-unsafe");
    }
    return directory;
}

async function boundedFileContents(handle: import("node:fs/promises").FileHandle) {
    const before = await handle.stat({ bigint: true });
    if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size <= 0n ||
        before.size > 4096n
    ) {
        fail("path-unsafe");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
        offset !== bytes.length ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs
    ) {
        fail("path-unsafe");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function worktreeExists(worktreePath: string): Promise<boolean> {
    try {
        const metadata = await lstat(worktreePath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("path-unsafe");
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        if (error instanceof PreviewHostError) throw error;
        return fail("path-unsafe");
    }
}

/**
 * Binds the candidate path bidirectionally to this checkout's Git admin tree.
 * @param checkoutRoot Canonical production checkout.
 * @param worktreePath Exact managed preview worktree path.
 */
export async function assertManagedPreviewWorktree(
    checkoutRoot: string,
    worktreePath: string
): Promise<void> {
    await assertCanonicalRoot(checkoutRoot);
    await assertCanonicalRoot(worktreePath);
    const worktreeParent = path.dirname(worktreePath);
    if (
        (await realpath(worktreeParent)) !== worktreeParent ||
        path.relative(worktreeParent, worktreePath) !== path.basename(worktreePath)
    ) {
        fail("path-unsafe");
    }
    const gitRootPath = path.join(checkoutRoot, ".git");
    let gitRoot: import("node:fs/promises").FileHandle | undefined;
    let worktree: import("node:fs/promises").FileHandle | undefined;
    let gitFile: import("node:fs/promises").FileHandle | undefined;
    let admin: import("node:fs/promises").FileHandle | undefined;
    let backPointer: import("node:fs/promises").FileHandle | undefined;
    try {
        gitRoot = await open(gitRootPath, directoryOpenFlags);
        worktree = await open(worktreePath, directoryOpenFlags);
        if (
            (await realpath(`/proc/self/fd/${gitRoot.fd}`)) !== gitRootPath ||
            (await realpath(`/proc/self/fd/${worktree.fd}`)) !== worktreePath
        ) {
            fail("path-unsafe");
        }
        gitFile = await open(
            path.join(`/proc/self/fd/${worktree.fd}`, ".git"),
            fileReadFlags
        );
        const adminPath = detachedWorktreeGitDirectory(
            await boundedFileContents(gitFile)
        );
        const worktreesRoot = path.join(gitRootPath, "worktrees");
        const canonicalWorktreesRoot = await realpath(worktreesRoot).catch(() =>
            fail("path-unsafe")
        );
        const relativeAdmin = path.relative(canonicalWorktreesRoot, adminPath);
        if (
            canonicalWorktreesRoot !== worktreesRoot ||
            relativeAdmin === "" ||
            relativeAdmin.startsWith("..") ||
            path.isAbsolute(relativeAdmin) ||
            relativeAdmin.includes(path.sep)
        ) {
            fail("path-unsafe");
        }
        admin = await open(adminPath, directoryOpenFlags).catch(() =>
            fail("path-unsafe")
        );
        if ((await realpath(`/proc/self/fd/${admin.fd}`)) !== adminPath) {
            fail("path-unsafe");
        }
        backPointer = await open(
            path.join(`/proc/self/fd/${admin.fd}`, "gitdir"),
            fileReadFlags
        );
        const backPointerText = await boundedFileContents(backPointer);
        if (backPointerText.trim() !== path.join(worktreePath, ".git")) {
            fail("path-unsafe");
        }
        if (
            detachedWorktreeGitDirectory(await boundedFileContents(gitFile)) !== adminPath
        ) {
            fail("path-unsafe");
        }
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        fail("path-unsafe");
    } finally {
        await backPointer?.close().catch(() => {});
        await admin?.close().catch(() => {});
        await gitFile?.close().catch(() => {});
        await worktree?.close().catch(() => {});
        await gitRoot?.close().catch(() => {});
    }
}

/**
 * Fetches an exact PR ref, rechecks every caller-confirmed stack head through the
 * scope authority outside this adapter, and prepares one detached managed checkout.
 */
export async function preparePreviewWorktree(
    request: PreviewStartRequest,
    options: PreviewWorktreeOptions,
    signal?: AbortSignal
): Promise<void> {
    await assertCanonicalRoot(options.checkoutRoot);
    if (
        !path.isAbsolute(options.bunExecutable) ||
        path.normalize(options.bunExecutable) !== options.bunExecutable
    ) {
        fail("path-unsafe");
    }
    const worktreeParent = path.dirname(options.worktreePath);
    await assertCanonicalRoot(worktreeParent);
    if (
        path.relative(worktreeParent, options.worktreePath) !==
        path.basename(options.worktreePath)
    ) {
        fail("path-unsafe");
    }
    const existingManagedWorktree = await worktreeExists(options.worktreePath);
    if (existingManagedWorktree) {
        await assertManagedPreviewWorktree(options.checkoutRoot, options.worktreePath);
    }
    const runner = options.processRunner ?? defaultProcessRunner;
    const expectedHead = request.expectedHeads.at(-1)!.headSha;
    const reference = `refs/mira-dashboard/previews/${request.operationId}`;
    const gitEnvironment = authenticatedGitEnvironment(
        Redacted.value(options.credentials.token)
    );
    const git = async (arguments_: readonly string[], timeoutMs = processTimeoutMs) =>
        runChecked(runner, {
            arguments: Object.freeze([...arguments_]),
            environment: gitEnvironment,
            executable: gitExecutable,
            signal,
            timeoutMs,
        });

    await git([
        "-C",
        options.checkoutRoot,
        "fetch",
        "--force",
        "--no-tags",
        "--no-recurse-submodules",
        "https://github.com/rajohan/Mira-Dashboard.git",
        `pull/${request.number}/head:${reference}`,
    ]);
    const fetched = await git([
        "-C",
        options.checkoutRoot,
        "rev-parse",
        "--verify",
        `${reference}^{commit}`,
    ]);
    if (fetched.stdout.trim() !== expectedHead) fail("scope-changed");

    if (existingManagedWorktree) {
        // Revalidate directly before the destructive Git boundary.
        await assertManagedPreviewWorktree(options.checkoutRoot, options.worktreePath);
        await git([
            "-C",
            options.checkoutRoot,
            "worktree",
            "remove",
            "--force",
            options.worktreePath,
        ]);
    }
    await git(["-C", options.checkoutRoot, "worktree", "prune", "--expire=now"]);
    await git([
        "-C",
        options.checkoutRoot,
        "worktree",
        "add",
        "--detach",
        options.worktreePath,
        expectedHead,
    ]);
    await assertCanonicalRoot(options.worktreePath);
    await assertManagedPreviewWorktree(options.checkoutRoot, options.worktreePath);
    const verified = await git(["-C", options.worktreePath, "rev-parse", "HEAD"]);
    if (verified.stdout.trim() !== expectedHead) fail("scope-changed");
    const status = await git([
        "-C",
        options.worktreePath,
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
    ]);
    if (status.stdout.trim()) fail("state-conflict");

    // Revalidate after every Git read and before candidate-controlled installation.
    await assertManagedPreviewWorktree(options.checkoutRoot, options.worktreePath);

    await runChecked(runner, {
        arguments: Object.freeze([
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--no-save",
        ]),
        cwd: options.worktreePath,
        environment: Object.freeze({
            HOME: "/nonexistent",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: fixedPath,
        }),
        executable: options.bunExecutable,
        signal,
        timeoutMs: installTimeoutMs,
    });
}

export async function removePreviewWorktree(
    options: Pick<
        PreviewWorktreeOptions,
        "checkoutRoot" | "processRunner" | "worktreePath"
    >,
    signal?: AbortSignal
): Promise<void> {
    await assertCanonicalRoot(options.checkoutRoot);
    if (!(await worktreeExists(options.worktreePath))) return;
    await assertManagedPreviewWorktree(options.checkoutRoot, options.worktreePath);
    const runner = options.processRunner ?? defaultProcessRunner;
    await runChecked(runner, {
        arguments: Object.freeze([
            "-C",
            options.checkoutRoot,
            "worktree",
            "remove",
            "--force",
            options.worktreePath,
        ]),
        environment: cleanEnvironment(),
        executable: gitExecutable,
        signal,
        timeoutMs: processTimeoutMs,
    });
    if (await worktreeExists(options.worktreePath)) fail("state-conflict");
}
