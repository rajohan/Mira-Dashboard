import Fs from "node:fs";
import Path from "node:path";

import { Redacted } from "effect";
import * as v from "valibot";

import {
    deliveryGitHubCommitShaSchema,
    type DeliveryDashboardMainGitSyncPort,
} from "../../contracts/deliveryGithub.ts";
import { DeliveryGitHubError } from "./githubHttpTransport.ts";

const gitExecutableDefault = "/usr/bin/git";
const expectedOrigin = "https://github.com/rajohan/Mira-Dashboard.git";
const expectedBranch = "refs/heads/main";
const outputMaximumBytes = 64 * 1024;
const commandDeadlineMs = 30_000;
const operationDeadlineMs = 2 * 60_000;

export interface DeliveryMainGitCredentials {
    readonly password: Redacted.Redacted<string>;
    readonly username: Redacted.Redacted<string>;
}

export interface DeliveryMainGitProcessRequest {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly signal: AbortSignal;
    readonly stderrMaximumBytes: number;
    readonly stdoutMaximumBytes: number;
}

export interface DeliveryMainGitProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type DeliveryMainGitProcess = (
    request: DeliveryMainGitProcessRequest
) => Promise<DeliveryMainGitProcessResult>;

export interface DashboardMainGitSyncOptions {
    readonly allowLocalCheckoutForTests?: boolean;
    readonly checkoutRoot?: string;
    readonly credentials: DeliveryMainGitCredentials;
    readonly gitExecutable?: string;
    readonly process?: DeliveryMainGitProcess;
}

class MainGitBoundaryError extends DeliveryGitHubError {
    constructor(
        reason:
            | "authentication"
            | "conflict"
            | "invalid-input"
            | "unavailable"
            | "unknown-outcome"
    ) {
        super(reason);
        this.name = "MainGitBoundaryError";
    }
}

async function readBounded(
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
            if (length > maximumBytes) {
                await reader.cancel().catch(() => {});
                throw new MainGitBoundaryError("unavailable");
            }
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

const defaultProcess: DeliveryMainGitProcess = async (request) => {
    const child = Bun.spawn([request.executable, ...request.arguments], {
        cwd: request.cwd,
        env: request.environment,
        signal: request.signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout, request.stdoutMaximumBytes),
            readBounded(child.stderr, request.stderrMaximumBytes),
        ]);
        return { exitCode, stderr, stdout };
    } catch (error) {
        child.kill();
        await child.exited.catch(() => {});
        throw error instanceof DeliveryGitHubError
            ? error
            : new MainGitBoundaryError("unavailable");
    }
};

function decode(value: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
        throw new MainGitBoundaryError("unavailable");
    }
}

function credentialEnvironment(
    credentials: DeliveryMainGitCredentials
): Readonly<Record<string, string>> {
    try {
        const username = Redacted.value(credentials.username);
        const password = Redacted.value(credentials.password);
        if (
            username !== "mira-2026" ||
            password.length < 20 ||
            password.length > 4096 ||
            /[\r\n\p{Cc}\p{Cf}]/u.test(password)
        ) {
            throw new MainGitBoundaryError("authentication");
        }
        return Object.freeze({
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${new TextEncoder()
                .encode(`${username}:${password}`)
                .toBase64()}`,
        });
    } catch (error) {
        if (error instanceof DeliveryGitHubError) throw error;
        throw new MainGitBoundaryError("authentication");
    }
}

function gitEnvironment(
    credentials: DeliveryMainGitCredentials
): Readonly<Record<string, string>> {
    return Object.freeze({
        GIT_ASKPASS: "/bin/false",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PAGER: "/bin/false",
        GIT_SSH: "/bin/false",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/nonexistent",
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        PAGER: "/bin/false",
        SSH_ASKPASS: "/bin/false",
        ...credentialEnvironment(credentials),
    });
}

const commandPrefix = Object.freeze([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.sshCommand=/bin/false",
    "-c",
    "credential.interactive=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.file.allow=never",
]);

/**
 * Creates the fixed, exact-main Git synchronization boundary for production delivery.
 * @returns Exact production-main Git synchronization port.
 */
export function createDashboardMainGitSync(
    options: DashboardMainGitSyncOptions
): DeliveryDashboardMainGitSyncPort {
    const rootInput =
        options.checkoutRoot ??
        "/home/ubuntu/projects/mira-dashboard/production/checkout";
    const executable = options.gitExecutable ?? gitExecutableDefault;
    const run = options.process ?? defaultProcess;
    const allowLocalCheckoutForTests = options.allowLocalCheckoutForTests === true;
    if (!Path.isAbsolute(rootInput) || executable !== gitExecutableDefault) {
        throw new MainGitBoundaryError("invalid-input");
    }

    function canonicalRoot(): string {
        try {
            const root = Fs.realpathSync(rootInput);
            const stat = Fs.lstatSync(root);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new MainGitBoundaryError("invalid-input");
            }
            if (!allowLocalCheckoutForTests && root !== rootInput) {
                throw new MainGitBoundaryError("invalid-input");
            }
            return root;
        } catch (error) {
            if (error instanceof DeliveryGitHubError) throw error;
            throw new MainGitBoundaryError("invalid-input");
        }
    }

    const environment = gitEnvironment(options.credentials);

    async function git(
        arguments_: readonly string[],
        root: string,
        signal: AbortSignal
    ): Promise<DeliveryMainGitProcessResult> {
        const result = await run({
            arguments: [...commandPrefix, ...arguments_],
            cwd: root,
            environment,
            executable,
            signal: AbortSignal.any([signal, AbortSignal.timeout(commandDeadlineMs)]),
            stderrMaximumBytes: outputMaximumBytes,
            stdoutMaximumBytes: outputMaximumBytes,
        });
        if (
            !Number.isSafeInteger(result.exitCode) ||
            !(result.stdout instanceof Uint8Array) ||
            !(result.stderr instanceof Uint8Array) ||
            result.stdout.byteLength > outputMaximumBytes ||
            result.stderr.byteLength > outputMaximumBytes
        ) {
            throw new MainGitBoundaryError("unavailable");
        }
        return result;
    }

    async function required(
        arguments_: readonly string[],
        root: string,
        signal: AbortSignal
    ): Promise<string> {
        const result = await git(arguments_, root, signal);
        if (result.exitCode !== 0) throw new MainGitBoundaryError("conflict");
        return decode(result.stdout).trim();
    }

    async function optional(
        arguments_: readonly string[],
        root: string,
        signal: AbortSignal
    ): Promise<string | undefined> {
        const result = await git(arguments_, root, signal);
        if (result.exitCode !== 0) return undefined;
        const value = decode(result.stdout).trim();
        if (
            value.length === 0 ||
            value.length > 255 ||
            /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
        ) {
            throw new MainGitBoundaryError("unavailable");
        }
        return value;
    }

    async function inspectExact(
        root: string,
        signal: AbortSignal
    ): Promise<{
        branch: string;
        condition: "dirty" | "off-main" | "ready" | "wrong-root";
        headSha: string;
        safe: boolean;
        upstream?: string;
    }> {
        const topLevel = await required(["rev-parse", "--show-toplevel"], root, signal);
        const branch = await required(["symbolic-ref", "-q", "HEAD"], root, signal);
        const head = await required(
            ["rev-parse", "--verify", "HEAD^{commit}"],
            root,
            signal
        );
        const status = await required(
            ["status", "--porcelain=v1", "--untracked-files=all"],
            root,
            signal
        );
        const origin = await required(
            ["remote", "get-url", "--push", "origin"],
            root,
            signal
        );
        const upstream = await optional(
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
            root,
            signal
        );
        let headSha: string;
        try {
            headSha = v.parse(deliveryGitHubCommitShaSchema, head);
        } catch {
            throw new MainGitBoundaryError("unavailable");
        }
        const rootMatches =
            topLevel === root &&
            (allowLocalCheckoutForTests || origin === expectedOrigin);
        let condition: "dirty" | "off-main" | "ready" | "wrong-root";
        if (rootMatches) {
            if (branch === expectedBranch) condition = status === "" ? "ready" : "dirty";
            else condition = "off-main";
        } else {
            condition = "wrong-root";
        }
        return Object.freeze({
            branch: branch.replace(/^refs\/heads\//u, ""),
            condition,
            headSha,
            safe: condition === "ready",
            ...(upstream === undefined ? {} : { upstream }),
        });
    }

    async function inspect(signal?: AbortSignal) {
        const root = canonicalRoot();
        const combined = AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(operationDeadlineMs),
        ]);
        return inspectExact(root, combined);
    }

    async function syncMainToExactRef(
        remoteInput: string,
        localInput?: string,
        signal?: AbortSignal
    ) {
        let expectedRemoteHead: string;
        let expectedLocalHead: string | undefined;
        try {
            expectedRemoteHead = v.parse(deliveryGitHubCommitShaSchema, remoteInput);
            expectedLocalHead =
                localInput === undefined
                    ? undefined
                    : v.parse(deliveryGitHubCommitShaSchema, localInput);
        } catch {
            throw new MainGitBoundaryError("invalid-input");
        }
        const root = canonicalRoot();
        const combined = AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(operationDeadlineMs),
        ]);
        const before = await inspectExact(root, combined);
        if (
            !before.safe ||
            (expectedLocalHead !== undefined && before.headSha !== expectedLocalHead)
        ) {
            throw new MainGitBoundaryError("conflict");
        }
        const remote = await required(
            ["ls-remote", "--exit-code", expectedOrigin, "refs/heads/main"],
            root,
            combined
        );
        if (remote.split(/\s+/u)[0] !== expectedRemoteHead) {
            throw new MainGitBoundaryError("conflict");
        }
        let mutationStarted = false;
        try {
            mutationStarted = true;
            await required(
                [
                    "fetch",
                    "--no-tags",
                    "--prune",
                    expectedOrigin,
                    "refs/heads/main:refs/remotes/origin/main",
                ],
                root,
                combined
            );
            const fetched = await required(
                ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
                root,
                combined
            );
            if (fetched !== expectedRemoteHead) {
                throw new MainGitBoundaryError("conflict");
            }
            await required(["merge", "--ff-only", expectedRemoteHead], root, combined);
        } catch (error) {
            if (mutationStarted && combined.aborted) {
                return Object.freeze({
                    headSha: expectedRemoteHead,
                    outcome: "unknown-outcome" as const,
                });
            }
            throw error;
        }
        const after = await inspectExact(root, combined);
        if (!after.safe || after.headSha !== expectedRemoteHead) {
            return Object.freeze({
                headSha: expectedRemoteHead,
                outcome: "unknown-outcome" as const,
            });
        }
        return Object.freeze({ headSha: after.headSha, outcome: "completed" as const });
    }

    return Object.freeze({ inspect, syncMainToExactRef });
}
