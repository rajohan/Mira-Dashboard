import Fs from "node:fs";
import Path from "node:path";

import { Redacted } from "effect";
import * as v from "valibot";

import { dockerComposeTrustRoot } from "./composeDiscovery.ts";

export const dockerUpdaterGitCommitMessage = "chore: update managed app images" as const;

const gitDefault = "/usr/bin/git";
const gitHome = "/nonexistent";
const gitAuthorName = "mira-2026";
const gitAuthorEmail = "mira-2026@agentmail.to";
const commandDeadlineDefaultMs = 30_000;
const operationDeadlineDefaultMs = 2 * 60_000;
const pushDeadlineDefaultMs = 60_000;
const outputMaximumBytes = 64 * 1024;
const composeMaximumBytes = 2 * 1024 * 1024;
const changedComposeMaximum = 32;
const pathMaximumLength = 4096;
const composeBasenamePattern = /^(?:compose|docker-compose)(?:\.override)?\.ya?ml$/u;
const controlTextPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitObjectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const referencePattern = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]{0,1022}$/u;

const composeChangeSchema = v.strictObject({
    composePath: v.pipe(v.string(), v.minLength(1), v.maxLength(pathMaximumLength)),
    expectedAfterContentSha256: v.pipe(v.string(), v.regex(sha256Pattern)),
    expectedBeforeContentSha256: v.pipe(v.string(), v.regex(sha256Pattern)),
});

const gitHeadFileSchema = v.strictObject({
    composePath: v.pipe(v.string(), v.minLength(1), v.maxLength(pathMaximumLength)),
    expectedContentSha256: v.pipe(v.string(), v.regex(sha256Pattern)),
});

const gitHeadFilesRequestSchema = v.strictObject({
    expectedRepositoryHead: v.pipe(v.string(), v.regex(gitObjectPattern)),
    files: v.pipe(v.array(gitHeadFileSchema), v.maxLength(changedComposeMaximum)),
});

const gitSyncRequestSchema = v.strictObject({
    changes: v.pipe(v.array(composeChangeSchema), v.maxLength(changedComposeMaximum)),
    expectedRepositoryHead: v.pipe(v.string(), v.regex(gitObjectPattern)),
});

export interface DockerUpdaterGitSyncChange {
    readonly composePath: string;
    readonly expectedAfterContentSha256: string;
    readonly expectedBeforeContentSha256: string;
}

export interface DockerUpdaterGitSyncRequest {
    readonly changes: readonly DockerUpdaterGitSyncChange[];
    readonly expectedRepositoryHead: string;
}

export interface DockerUpdaterGitHeadFile {
    readonly composePath: string;
    readonly expectedContentSha256: string;
}

export interface DockerUpdaterGitHeadFilesRequest {
    readonly expectedRepositoryHead: string;
    readonly files: readonly DockerUpdaterGitHeadFile[];
}

export type DockerUpdaterGitSyncUnavailableReason =
    | "cancelled"
    | "conflict"
    | "invalid-target"
    | "repository"
    | "unrelated-pending"
    | "unrelated-staged"
    | "upstream";

export type DockerUpdaterGitSyncResult =
    | Readonly<{
          composePaths: readonly string[];
          status: "no-change";
      }>
    | Readonly<{
          commit: string;
          composePaths: readonly string[];
          status: "pushed";
      }>
    | Readonly<{
          commit: string;
          composePaths: readonly string[];
          status: "committed-push-pending";
      }>
    | Readonly<{
          composePaths: readonly string[];
          reason: DockerUpdaterGitSyncUnavailableReason;
          status: "unavailable";
      }>
    | Readonly<{
          commit?: string;
          composePaths: readonly string[];
          status: "unknown-outcome";
      }>;

export interface DockerUpdaterGitProcessRequest {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly signal: AbortSignal;
    readonly stderrMaximumBytes: number;
    readonly stdoutMaximumBytes: number;
}

export interface DockerUpdaterGitProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type DockerUpdaterGitProcess = (
    request: DockerUpdaterGitProcessRequest
) => Promise<DockerUpdaterGitProcessResult>;

export interface DockerUpdaterGitSync {
    readonly readHead: (signal?: AbortSignal) => Promise<string>;
    readonly sync: (
        request: DockerUpdaterGitSyncRequest,
        signal?: AbortSignal,
        onCommitStarting?: () => void
    ) => Promise<DockerUpdaterGitSyncResult>;
    readonly verifyHeadFiles: (
        request: DockerUpdaterGitHeadFilesRequest,
        signal?: AbortSignal
    ) => Promise<void>;
}

export interface DockerUpdaterGitSyncOptions {
    /** Private temp repositories only. Production must leave this false. */
    readonly allowLocalUpstreamForTests?: boolean;
    readonly commandDeadlineMs?: number;
    readonly credentials?: DockerUpdaterGitCredentials;
    readonly gitExecutable?: string;
    readonly operationDeadlineMs?: number;
    readonly process?: DockerUpdaterGitProcess;
    readonly pushDeadlineMs?: number;
    readonly repoRoot?: string;
}

/** Worker-only GitHub credential used for Git transport without ambient host config. */
export interface DockerUpdaterGitCredentials {
    readonly password: Redacted.Redacted<string>;
    readonly username: Redacted.Redacted<string>;
}

interface ValidatedChange extends DockerUpdaterGitSyncChange {
    readonly relativePath: string;
}

interface GitCommandResult {
    readonly exitCode: number;
    readonly stdout: Uint8Array;
}

interface InspectedUpstream {
    readonly localTrackingReference: string;
    readonly remoteName: string;
    readonly remoteReference: string;
    readonly url: string;
}

interface ExactAutomationCommit {
    readonly commit: string;
    readonly composePaths: readonly string[];
    readonly parent: string;
}

type PendingState =
    | Readonly<{ kind: "none" }>
    | Readonly<{ commit: ExactAutomationCommit; kind: "exact" }>
    | Readonly<{ kind: "unrelated" }>;

type RemoteProbe = "different" | "matching" | "unknown";

class GitBoundaryFailure extends Error {
    public readonly reason: DockerUpdaterGitSyncUnavailableReason;

    public constructor(reason: DockerUpdaterGitSyncUnavailableReason) {
        super("Docker updater Git synchronization failed");
        this.name = "GitBoundaryFailure";
        this.reason = reason;
    }
}

const gitSyncLocks = new Map<string, Promise<void>>();

function sha256(value: Uint8Array | string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function unavailable(
    reason: DockerUpdaterGitSyncUnavailableReason
): DockerUpdaterGitSyncResult {
    return Object.freeze({
        composePaths: Object.freeze([]),
        reason,
        status: "unavailable",
    });
}

function unknownOutcome(
    composePaths: readonly string[],
    commit?: string
): DockerUpdaterGitSyncResult {
    return Object.freeze({
        ...(commit === undefined ? {} : { commit }),
        composePaths: Object.freeze([...composePaths]),
        status: "unknown-outcome",
    });
}

function failureReason(error: unknown): DockerUpdaterGitSyncUnavailableReason {
    return error instanceof GitBoundaryFailure ? error.reason : "repository";
}

function abortReason(signal: AbortSignal): DockerUpdaterGitSyncUnavailableReason {
    return signal.aborted ? "cancelled" : "repository";
}

function validExecutable(value: string): boolean {
    return (
        Path.isAbsolute(value) &&
        Path.normalize(value) === value &&
        value.length <= pathMaximumLength &&
        !controlTextPattern.test(value)
    );
}

function validReference(value: string, prefix: "refs/heads/" | "refs/remotes/"): boolean {
    return (
        value.startsWith(prefix) &&
        referencePattern.test(value) &&
        !value.includes("..") &&
        !value.includes("//") &&
        !value.includes("@{") &&
        !value.endsWith(".") &&
        !value.endsWith("/") &&
        !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
    );
}

function canonicalRepositoryRoot(value: string): string {
    try {
        if (!Path.isAbsolute(value) || Path.normalize(value) !== value) {
            throw new GitBoundaryFailure("invalid-target");
        }
        const canonical = Fs.realpathSync(value);
        const stat = Fs.lstatSync(value);
        if (canonical !== value || stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new GitBoundaryFailure("invalid-target");
        }
        return canonical;
    } catch (error) {
        if (error instanceof GitBoundaryFailure) throw error;
        throw new GitBoundaryFailure("invalid-target");
    }
}

function pathContainedBy(root: string, candidate: string): boolean {
    const relative = Path.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !Path.isAbsolute(relative);
}

function canonicalComposePath(
    root: string,
    value: string
): ValidatedChange["composePath"] {
    try {
        if (
            !Path.isAbsolute(value) ||
            Path.normalize(value) !== value ||
            value.length > pathMaximumLength ||
            value.includes("\\") ||
            controlTextPattern.test(value) ||
            !composeBasenamePattern.test(Path.basename(value))
        ) {
            throw new GitBoundaryFailure("invalid-target");
        }
        const canonical = Fs.realpathSync(value);
        const stat = Fs.lstatSync(value);
        if (
            canonical !== value ||
            !pathContainedBy(root, canonical) ||
            stat.isSymbolicLink() ||
            !stat.isFile() ||
            stat.nlink !== 1
        ) {
            throw new GitBoundaryFailure("invalid-target");
        }
        return canonical;
    } catch (error) {
        if (error instanceof GitBoundaryFailure) throw error;
        throw new GitBoundaryFailure("invalid-target");
    }
}

function readComposeFile(
    root: string,
    value: string
): {
    readonly bytes: Buffer;
    readonly relativePath: string;
} {
    const canonical = canonicalComposePath(root, value);
    let descriptor: number | undefined;
    try {
        descriptor = Fs.openSync(
            canonical,
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
        );
        const before = Fs.fstatSync(descriptor, { bigint: true });
        if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size > BigInt(composeMaximumBytes)
        ) {
            throw new GitBoundaryFailure("invalid-target");
        }
        const bytes = Fs.readFileSync(descriptor);
        const after = Fs.fstatSync(descriptor, { bigint: true });
        const current = Fs.lstatSync(canonical, { bigint: true });
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            after.dev !== current.dev ||
            after.ino !== current.ino ||
            after.size !== BigInt(bytes.byteLength) ||
            current.isSymbolicLink() ||
            current.nlink !== 1n
        ) {
            throw new GitBoundaryFailure("conflict");
        }
        return { bytes, relativePath: Path.relative(root, canonical) };
    } catch (error) {
        if (error instanceof GitBoundaryFailure) throw error;
        throw new GitBoundaryFailure("repository");
    } finally {
        if (descriptor !== undefined) Fs.closeSync(descriptor);
    }
}

async function readBounded(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maximumBytes) throw new GitBoundaryFailure("repository");
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

const defaultProcess: DockerUpdaterGitProcess = async (request) => {
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
    } catch {
        child.kill();
        await child.exited.catch(() => {});
        throw new GitBoundaryFailure("repository");
    }
};

function gitCredentialEnvironment(
    credentials: DockerUpdaterGitCredentials | undefined
): Readonly<Record<string, string>> {
    if (credentials === undefined) return Object.freeze({});
    try {
        const username = Redacted.value(credentials.username);
        const password = Redacted.value(credentials.password);
        if (
            username.length === 0 ||
            username.length > 256 ||
            /[\p{Cc}\p{Cf}]/u.test(username) ||
            password.length === 0 ||
            password.length > 4096 ||
            /[\r\n]/u.test(password)
        ) {
            throw new GitBoundaryFailure("invalid-target");
        }
        const authorization = Buffer.from(`${username}:${password}`, "utf8").toString(
            "base64"
        );
        return Object.freeze({
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
        });
    } catch (error) {
        if (error instanceof GitBoundaryFailure) throw error;
        throw new GitBoundaryFailure("invalid-target");
    }
}

function gitEnvironment(
    credentials: DockerUpdaterGitCredentials | undefined
): Readonly<Record<string, string>> {
    return Object.freeze({
        GIT_ASKPASS: "/bin/false",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PAGER: "/bin/false",
        GIT_SSH: "/bin/false",
        GIT_TERMINAL_PROMPT: "0",
        HOME: gitHome,
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        PAGER: "/bin/false",
        SSH_ASKPASS: "/bin/false",
        ...gitCredentialEnvironment(credentials),
    });
}

function commandPrefix(allowLocalUpstreamForTests: boolean): readonly string[] {
    return Object.freeze([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.sshCommand=/bin/false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "credential.interactive=false",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        ...(allowLocalUpstreamForTests
            ? ["-c", "protocol.file.allow=always"]
            : ["-c", "protocol.file.allow=never"]),
        "-c",
        `user.name=${gitAuthorName}`,
        "-c",
        `user.email=${gitAuthorEmail}`,
    ]);
}

function decodeUtf8(value: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
        throw new GitBoundaryFailure("repository");
    }
}

function commandSignal(signal: AbortSignal, deadlineMs: number): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
}

function validateProcessResult(
    result: DockerUpdaterGitProcessResult,
    stdoutMaximumBytes: number
): GitCommandResult {
    if (
        !Number.isSafeInteger(result.exitCode) ||
        !(result.stdout instanceof Uint8Array) ||
        !(result.stderr instanceof Uint8Array) ||
        result.stdout.byteLength > stdoutMaximumBytes ||
        result.stderr.byteLength > outputMaximumBytes
    ) {
        throw new GitBoundaryFailure("repository");
    }
    return { exitCode: result.exitCode, stdout: result.stdout };
}

function literalPathspec(relativePath: string): string {
    return `:(literal)${relativePath}`;
}

function sameUpstream(left: InspectedUpstream, right: InspectedUpstream): boolean {
    return (
        left.localTrackingReference === right.localTrackingReference &&
        left.remoteName === right.remoteName &&
        left.remoteReference === right.remoteReference &&
        left.url === right.url
    );
}

function validateRemoteUrl(rawUrl: string, allowLocalUpstreamForTests: boolean): string {
    if (
        rawUrl.length === 0 ||
        rawUrl.length > pathMaximumLength ||
        controlTextPattern.test(rawUrl)
    ) {
        throw new GitBoundaryFailure("upstream");
    }
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new GitBoundaryFailure("upstream");
    }
    if (
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.search !== "" ||
        parsed.hash !== ""
    ) {
        throw new GitBoundaryFailure("upstream");
    }
    if (
        parsed.protocol === "https:" &&
        parsed.hostname === "github.com" &&
        parsed.port === "" &&
        /^\/[A-Za-z\d_.-]{1,100}\/[A-Za-z\d_.-]{1,100}(?:\.git)?$/u.test(parsed.pathname)
    ) {
        return rawUrl;
    }
    if (!allowLocalUpstreamForTests || parsed.protocol !== "file:") {
        throw new GitBoundaryFailure("upstream");
    }
    try {
        const localPath = Bun.fileURLToPath(parsed);
        const canonical = Fs.realpathSync(localPath);
        if (
            canonical !== localPath ||
            !Path.isAbsolute(canonical) ||
            !Fs.lstatSync(canonical).isDirectory()
        ) {
            throw new GitBoundaryFailure("upstream");
        }
    } catch (error) {
        if (error instanceof GitBoundaryFailure) throw error;
        throw new GitBoundaryFailure("upstream");
    }
    return rawUrl;
}

function parseNulFields(value: Uint8Array, expectedFields: number): readonly string[] {
    const decoded = decodeUtf8(value).replace(/\n$/u, "");
    const fields = decoded.split("\0");
    if (fields.length !== expectedFields) throw new GitBoundaryFailure("repository");
    return fields;
}

function parseNameStatus(value: Uint8Array): readonly {
    readonly path: string;
    readonly status: string;
}[] {
    const decoded = decodeUtf8(value);
    if (decoded === "") return Object.freeze([]);
    const fields = decoded.split("\0");
    if (fields.at(-1) !== "") throw new GitBoundaryFailure("repository");
    fields.pop();
    if (fields.length % 2 !== 0) throw new GitBoundaryFailure("repository");
    const result: Array<{ readonly path: string; readonly status: string }> = [];
    for (let index = 0; index < fields.length; index += 2) {
        const status = fields[index];
        const path = fields[index + 1];
        if (status === undefined || path === undefined) {
            throw new GitBoundaryFailure("repository");
        }
        result.push({ path, status });
    }
    return Object.freeze(result);
}

async function withGitSyncLock<T>(root: string, action: () => Promise<T>): Promise<T> {
    const previous = gitSyncLocks.get(root) ?? Promise.resolve();
    const current = Promise.withResolvers<void>();
    const queued = previous.then(() => current.promise);
    gitSyncLocks.set(root, queued);
    await previous;
    try {
        return await action();
    } finally {
        current.resolve();
        if (gitSyncLocks.get(root) === queued) gitSyncLocks.delete(root);
    }
}

/**
 * Creates the worker-only, exact-path Git synchronization adapter for Docker updates.
 * Runtime composition uses the fixed `/opt/docker` repository and `/usr/bin/git`.
 * @param options Fixed production authorities with narrow test-only seams.
 * @returns A frozen adapter that never projects Git diagnostics or remote URLs.
 */
export function createDockerUpdaterGitSync(
    options: DockerUpdaterGitSyncOptions = {}
): DockerUpdaterGitSync {
    const root = canonicalRepositoryRoot(options.repoRoot ?? dockerComposeTrustRoot);
    const executable = options.gitExecutable ?? gitDefault;
    const execute = options.process ?? defaultProcess;
    const allowLocalUpstreamForTests = options.allowLocalUpstreamForTests === true;
    const commandDeadlineMs = options.commandDeadlineMs ?? commandDeadlineDefaultMs;
    const operationDeadlineMs = options.operationDeadlineMs ?? operationDeadlineDefaultMs;
    const pushDeadlineMs = options.pushDeadlineMs ?? pushDeadlineDefaultMs;
    const usesProductionRoot = root === dockerComposeTrustRoot;
    if (
        !validExecutable(executable) ||
        (usesProductionRoot &&
            (allowLocalUpstreamForTests ||
                executable !== gitDefault ||
                options.process !== undefined)) ||
        !Number.isSafeInteger(commandDeadlineMs) ||
        commandDeadlineMs < 1 ||
        commandDeadlineMs > commandDeadlineDefaultMs ||
        !Number.isSafeInteger(operationDeadlineMs) ||
        operationDeadlineMs < 1 ||
        operationDeadlineMs > operationDeadlineDefaultMs ||
        !Number.isSafeInteger(pushDeadlineMs) ||
        pushDeadlineMs < 1 ||
        pushDeadlineMs > pushDeadlineDefaultMs
    ) {
        throw new GitBoundaryFailure("invalid-target");
    }
    const prefix = commandPrefix(allowLocalUpstreamForTests);
    const credentials = options.credentials;
    const environment = gitEnvironment(credentials);

    async function git(
        arguments_: readonly string[],
        signal: AbortSignal,
        options_: {
            readonly deadlineMs?: number;
            readonly stdoutMaximumBytes?: number;
        } = {}
    ): Promise<GitCommandResult> {
        const stdoutMaximumBytes = options_.stdoutMaximumBytes ?? outputMaximumBytes;
        try {
            return validateProcessResult(
                await execute({
                    arguments: [...prefix, ...arguments_],
                    cwd: root,
                    environment,
                    executable,
                    signal: commandSignal(
                        signal,
                        options_.deadlineMs ?? commandDeadlineMs
                    ),
                    stderrMaximumBytes: outputMaximumBytes,
                    stdoutMaximumBytes,
                }),
                stdoutMaximumBytes
            );
        } catch {
            throw new GitBoundaryFailure(abortReason(signal));
        }
    }

    async function requiredGit(
        arguments_: readonly string[],
        signal: AbortSignal,
        options_?: {
            readonly deadlineMs?: number;
            readonly stdoutMaximumBytes?: number;
        }
    ): Promise<Uint8Array> {
        const result = await git(arguments_, signal, options_);
        if (result.exitCode !== 0) throw new GitBoundaryFailure("repository");
        return result.stdout;
    }

    async function repositoryHead(signal: AbortSignal): Promise<string> {
        const result = decodeUtf8(
            await requiredGit(["rev-parse", "--verify", "HEAD^{commit}"], signal)
        ).trim();
        if (!gitObjectPattern.test(result)) throw new GitBoundaryFailure("repository");
        return result;
    }

    async function assertRepository(signal: AbortSignal): Promise<void> {
        const topLevel = decodeUtf8(
            await requiredGit(["rev-parse", "--show-toplevel"], signal)
        ).trim();
        if (topLevel !== root) throw new GitBoundaryFailure("repository");
    }

    async function inspectUpstream(signal: AbortSignal): Promise<InspectedUpstream> {
        const urlRewriteConfiguration = await git(
            ["config", "--get-regexp", String.raw`^url\..*\.(insteadof|pushinsteadof)$`],
            signal
        );
        if (urlRewriteConfiguration.exitCode === 0) {
            throw new GitBoundaryFailure("upstream");
        }
        if (urlRewriteConfiguration.exitCode !== 1) {
            throw new GitBoundaryFailure("repository");
        }
        const localReference = decodeUtf8(
            await requiredGit(["symbolic-ref", "--quiet", "HEAD"], signal)
        ).trim();
        if (!validReference(localReference, "refs/heads/")) {
            throw new GitBoundaryFailure("upstream");
        }
        const fields = parseNulFields(
            await requiredGit(
                [
                    "for-each-ref",
                    "--count=1",
                    "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
                    localReference,
                ],
                signal
            ),
            3
        );
        const [localTrackingReference, remoteName, remoteReference] = fields;
        if (
            localTrackingReference === undefined ||
            remoteName === undefined ||
            remoteReference === undefined ||
            !validReference(localTrackingReference, "refs/remotes/") ||
            !remoteNamePattern.test(remoteName) ||
            !validReference(remoteReference, "refs/heads/")
        ) {
            throw new GitBoundaryFailure("upstream");
        }
        const urlOutput = decodeUtf8(
            await requiredGit(
                ["remote", "get-url", "--push", "--all", remoteName],
                signal
            )
        ).trimEnd();
        const urls = urlOutput.split("\n").filter((value) => value !== "");
        if (urls.length !== 1) throw new GitBoundaryFailure("upstream");
        const url = validateRemoteUrl(urls[0]!, allowLocalUpstreamForTests);
        return Object.freeze({
            localTrackingReference,
            remoteName,
            remoteReference,
            url,
        });
    }

    async function blobSha256(
        revision: string,
        relativePath: string,
        signal: AbortSignal
    ): Promise<string> {
        const tree = decodeUtf8(
            await requiredGit(
                [
                    "ls-tree",
                    "-z",
                    "--full-tree",
                    revision,
                    "--",
                    literalPathspec(relativePath),
                ],
                signal
            )
        );
        const match = tree.match(
            /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u
        );
        if (match === null || match[3] !== relativePath) {
            throw new GitBoundaryFailure("conflict");
        }
        const blob = await requiredGit(["cat-file", "blob", match[2]!], signal, {
            stdoutMaximumBytes: composeMaximumBytes,
        });
        return sha256(blob);
    }

    async function stagedBlobSha256(
        relativePath: string,
        signal: AbortSignal
    ): Promise<string> {
        const output = decodeUtf8(
            await requiredGit(
                ["ls-files", "--stage", "-z", "--", literalPathspec(relativePath)],
                signal
            )
        );
        const match = output.match(
            /^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([^\0]+)\0$/u
        );
        if (match === null || match[3] !== relativePath) {
            throw new GitBoundaryFailure("repository");
        }
        return sha256(
            await requiredGit(["cat-file", "blob", match[2]!], signal, {
                stdoutMaximumBytes: composeMaximumBytes,
            })
        );
    }

    async function exactAutomationCommit(
        parent: string,
        signal: AbortSignal,
        expected?: ReadonlyMap<string, string>
    ): Promise<ExactAutomationCommit | undefined> {
        const metadata = parseNulFields(
            await requiredGit(
                [
                    "show",
                    "-s",
                    "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%cn%x00%ce",
                    "HEAD",
                ],
                signal
            ),
            7
        );
        const [
            commit,
            parents,
            subject,
            authorName,
            authorEmail,
            committerName,
            committerEmail,
        ] = metadata;
        if (
            commit === undefined ||
            !gitObjectPattern.test(commit) ||
            parents !== parent ||
            subject !== dockerUpdaterGitCommitMessage ||
            authorName !== gitAuthorName ||
            authorEmail !== gitAuthorEmail ||
            committerName !== gitAuthorName ||
            committerEmail !== gitAuthorEmail
        ) {
            return undefined;
        }
        const rows = parseNameStatus(
            await requiredGit(
                [
                    "diff-tree",
                    "--no-commit-id",
                    "--no-renames",
                    "--name-status",
                    "-r",
                    "-z",
                    parent,
                    commit,
                ],
                signal
            )
        );
        if (
            rows.length === 0 ||
            rows.length > changedComposeMaximum ||
            (expected !== undefined && rows.length !== expected.size)
        ) {
            return undefined;
        }
        const composePaths: string[] = [];
        for (const row of rows) {
            if (row.status !== "M") return undefined;
            const absolutePath = Path.join(root, row.path);
            const current = readComposeFile(root, absolutePath);
            if (current.relativePath !== row.path) return undefined;
            const committedSha256 = await blobSha256(commit, row.path, signal);
            if (
                sha256(current.bytes) !== committedSha256 ||
                (expected !== undefined &&
                    (!expected.has(row.path) ||
                        expected.get(row.path) !== committedSha256))
            ) {
                return undefined;
            }
            composePaths.push(row.path);
        }
        const sorted = [...composePaths].toSorted();
        if (new Set(sorted).size !== sorted.length) return undefined;
        return Object.freeze({
            commit,
            composePaths: Object.freeze(sorted),
            parent,
        });
    }

    async function pendingState(
        upstream: InspectedUpstream,
        signal: AbortSignal
    ): Promise<PendingState> {
        const countText = decodeUtf8(
            await requiredGit(
                ["rev-list", "--count", `${upstream.localTrackingReference}..HEAD`],
                signal
            )
        ).trim();
        if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(countText)) {
            throw new GitBoundaryFailure("upstream");
        }
        const count = Number(countText);
        if (count === 0) return Object.freeze({ kind: "none" });
        if (count !== 1) return Object.freeze({ kind: "unrelated" });
        const parent = decodeUtf8(
            await requiredGit(
                ["rev-parse", "--verify", `${upstream.localTrackingReference}^{commit}`],
                signal
            )
        ).trim();
        if (!gitObjectPattern.test(parent)) {
            throw new GitBoundaryFailure("upstream");
        }
        const commit = await exactAutomationCommit(parent, signal);
        return commit === undefined
            ? Object.freeze({ kind: "unrelated" })
            : Object.freeze({ commit, kind: "exact" });
    }

    async function hasStagedChanges(signal: AbortSignal): Promise<boolean> {
        const result = await git(
            [
                "diff",
                "--cached",
                "--quiet",
                "--exit-code",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
            ],
            signal
        );
        if (result.exitCode === 0) return false;
        if (result.exitCode === 1) return true;
        throw new GitBoundaryFailure("repository");
    }

    async function validateNoCleanFilters(
        relativePaths: readonly string[],
        signal: AbortSignal
    ): Promise<void> {
        const fields = decodeUtf8(
            await requiredGit(
                ["check-attr", "-z", "filter", "--", ...relativePaths],
                signal
            )
        ).split("\0");
        if (fields.at(-1) !== "") throw new GitBoundaryFailure("repository");
        fields.pop();
        if (fields.length !== relativePaths.length * 3) {
            throw new GitBoundaryFailure("repository");
        }
        for (let index = 0; index < fields.length; index += 3) {
            const path = fields[index];
            const attribute = fields[index + 1];
            const value = fields[index + 2];
            if (
                path !== relativePaths[index / 3] ||
                attribute !== "filter" ||
                value !== "unspecified"
            ) {
                throw new GitBoundaryFailure("invalid-target");
            }
        }
    }

    async function restoreStaging(relativePaths: readonly string[]): Promise<boolean> {
        try {
            const result = await git(
                [
                    "restore",
                    "--staged",
                    "--source=HEAD",
                    "--",
                    ...relativePaths.map((relativePath) => literalPathspec(relativePath)),
                ],
                AbortSignal.timeout(commandDeadlineMs)
            );
            return result.exitCode === 0;
        } catch {
            return false;
        }
    }

    async function stageExactChanges(
        changes: readonly ValidatedChange[],
        signal: AbortSignal
    ): Promise<void> {
        const paths = changes.map((change) => change.relativePath);
        await validateNoCleanFilters(paths, signal);
        const add = await git(
            ["add", "--", ...paths.map((relativePath) => literalPathspec(relativePath))],
            signal
        );
        if (add.exitCode !== 0) throw new GitBoundaryFailure("repository");
        const staged = parseNameStatus(
            await requiredGit(
                [
                    "diff",
                    "--cached",
                    "--no-ext-diff",
                    "--no-renames",
                    "--name-status",
                    "-z",
                    "HEAD",
                    "--",
                ],
                signal
            )
        );
        if (
            staged.length !== paths.length ||
            staged.some((row, index) => row.status !== "M" || row.path !== paths[index])
        ) {
            throw new GitBoundaryFailure("repository");
        }
        for (const change of changes) {
            if (
                (await stagedBlobSha256(change.relativePath, signal)) !==
                change.expectedAfterContentSha256
            ) {
                throw new GitBoundaryFailure("conflict");
            }
        }
    }

    async function writeExactTree(
        head: string,
        expected: ReadonlyMap<string, string>,
        signal: AbortSignal
    ): Promise<string> {
        const tree = decodeUtf8(await requiredGit(["write-tree"], signal)).trim();
        if (!gitObjectPattern.test(tree)) {
            throw new GitBoundaryFailure("repository");
        }
        const rows = parseNameStatus(
            await requiredGit(
                [
                    "diff-tree",
                    "--no-commit-id",
                    "--no-renames",
                    "--name-status",
                    "-r",
                    "-z",
                    head,
                    tree,
                ],
                signal
            )
        );
        if (rows.length !== expected.size) {
            throw new GitBoundaryFailure("conflict");
        }
        for (const row of rows) {
            const expectedSha256 = expected.get(row.path);
            if (
                row.status !== "M" ||
                expectedSha256 === undefined ||
                (await blobSha256(tree, row.path, signal)) !== expectedSha256
            ) {
                throw new GitBoundaryFailure("conflict");
            }
        }
        return tree;
    }

    async function probeRemote(
        upstream: InspectedUpstream,
        commit: string
    ): Promise<RemoteProbe> {
        try {
            const result = await git(
                ["ls-remote", "--exit-code", upstream.url, upstream.remoteReference],
                AbortSignal.timeout(commandDeadlineMs)
            );
            if (result.exitCode === 2 && result.stdout.byteLength === 0) {
                return "different";
            }
            if (result.exitCode !== 0) return "unknown";
            const output = decodeUtf8(result.stdout).trim();
            const fields = output.split(/\s+/u);
            if (
                fields.length !== 2 ||
                !gitObjectPattern.test(fields[0] ?? "") ||
                fields[1] !== upstream.remoteReference
            ) {
                return "unknown";
            }
            return fields[0] === commit ? "matching" : "different";
        } catch {
            return "unknown";
        }
    }

    async function preflightRemote(
        upstream: InspectedUpstream,
        head: string,
        signal: AbortSignal
    ): Promise<void> {
        if (!allowLocalUpstreamForTests && credentials === undefined) {
            throw new GitBoundaryFailure("upstream");
        }
        if ((await probeRemote(upstream, head)) !== "matching") {
            throw new GitBoundaryFailure("upstream");
        }
        const dryRun = await git(
            [
                "push",
                "--dry-run",
                "--no-verify",
                "--porcelain",
                upstream.url,
                `HEAD:${upstream.remoteReference}`,
            ],
            signal,
            { deadlineMs: pushDeadlineMs }
        );
        if (dryRun.exitCode !== 0) throw new GitBoundaryFailure("upstream");
        if (!sameUpstream(upstream, await inspectUpstream(signal))) {
            throw new GitBoundaryFailure("upstream");
        }
    }

    async function advanceTrackingReference(
        upstream: InspectedUpstream,
        commit: ExactAutomationCommit
    ): Promise<boolean> {
        const settlementSignal = AbortSignal.timeout(commandDeadlineMs);
        try {
            if (!sameUpstream(upstream, await inspectUpstream(settlementSignal))) {
                return false;
            }
            await git(
                [
                    "update-ref",
                    "--no-deref",
                    upstream.localTrackingReference,
                    commit.commit,
                    commit.parent,
                ],
                settlementSignal
            );
            const trackedCommit = decodeUtf8(
                await requiredGit(
                    [
                        "rev-parse",
                        "--verify",
                        `${upstream.localTrackingReference}^{commit}`,
                    ],
                    settlementSignal
                )
            ).trim();
            return (
                trackedCommit === commit.commit &&
                sameUpstream(upstream, await inspectUpstream(settlementSignal))
            );
        } catch {
            return false;
        }
    }

    async function pushCommit(
        upstream: InspectedUpstream,
        commit: ExactAutomationCommit,
        signal: AbortSignal
    ): Promise<DockerUpdaterGitSyncResult> {
        let currentUpstream: InspectedUpstream;
        try {
            currentUpstream = await inspectUpstream(signal);
        } catch {
            return Object.freeze({
                commit: commit.commit,
                composePaths: commit.composePaths,
                status: "committed-push-pending",
            });
        }
        if (!sameUpstream(upstream, currentUpstream)) {
            return Object.freeze({
                commit: commit.commit,
                composePaths: commit.composePaths,
                status: "committed-push-pending",
            });
        }
        let pushExitCode: number | undefined;
        try {
            const result = await git(
                [
                    "push",
                    "--no-verify",
                    "--porcelain",
                    upstream.url,
                    `${commit.commit}:${upstream.remoteReference}`,
                ],
                signal,
                { deadlineMs: pushDeadlineMs }
            );
            pushExitCode = result.exitCode;
        } catch {
            // Remote probing below distinguishes a pending commit from an unknown outcome.
        }
        const probe = await probeRemote(upstream, commit.commit);
        if (probe === "matching") {
            if (!(await advanceTrackingReference(upstream, commit))) {
                return Object.freeze({
                    commit: commit.commit,
                    composePaths: commit.composePaths,
                    status: "committed-push-pending",
                });
            }
            return Object.freeze({
                commit: commit.commit,
                composePaths: commit.composePaths,
                status: "pushed",
            });
        }
        if (probe === "different") {
            return Object.freeze({
                commit: commit.commit,
                composePaths: commit.composePaths,
                status: "committed-push-pending",
            });
        }
        return unknownOutcome(
            commit.composePaths,
            pushExitCode === 0 ? commit.commit : undefined
        );
    }

    async function validateChanges(
        request: DockerUpdaterGitSyncRequest,
        head: string,
        signal: AbortSignal
    ): Promise<readonly ValidatedChange[]> {
        const parsed = v.safeParse(gitSyncRequestSchema, request);
        if (!parsed.success) throw new GitBoundaryFailure("invalid-target");
        if (parsed.output.expectedRepositoryHead !== head) {
            throw new GitBoundaryFailure("conflict");
        }
        const changes: ValidatedChange[] = [];
        for (const change of parsed.output.changes) {
            if (
                change.expectedBeforeContentSha256 === change.expectedAfterContentSha256
            ) {
                throw new GitBoundaryFailure("conflict");
            }
            const current = readComposeFile(root, change.composePath);
            if (sha256(current.bytes) !== change.expectedAfterContentSha256) {
                throw new GitBoundaryFailure("conflict");
            }
            if (
                (await blobSha256(head, current.relativePath, signal)) !==
                change.expectedBeforeContentSha256
            ) {
                throw new GitBoundaryFailure("conflict");
            }
            changes.push({ ...change, relativePath: current.relativePath });
        }
        changes.sort((left, right) =>
            left.relativePath.localeCompare(right.relativePath)
        );
        if (
            new Set(changes.map((change) => change.relativePath)).size !== changes.length
        ) {
            throw new GitBoundaryFailure("invalid-target");
        }
        return Object.freeze(changes);
    }

    async function verifyHeadFilesLocked(
        request: DockerUpdaterGitHeadFilesRequest,
        signal: AbortSignal
    ): Promise<void> {
        await assertRepository(signal);
        const parsed = v.safeParse(gitHeadFilesRequestSchema, request);
        if (!parsed.success || parsed.output.files.length === 0) {
            throw new GitBoundaryFailure("invalid-target");
        }
        const head = await repositoryHead(signal);
        if (head !== parsed.output.expectedRepositoryHead) {
            throw new GitBoundaryFailure("conflict");
        }
        const observed = new Set<string>();
        for (const file of parsed.output.files) {
            const current = readComposeFile(root, file.composePath);
            if (
                observed.has(current.relativePath) ||
                sha256(current.bytes) !== file.expectedContentSha256 ||
                (await blobSha256(head, current.relativePath, signal)) !==
                    file.expectedContentSha256
            ) {
                throw new GitBoundaryFailure("conflict");
            }
            observed.add(current.relativePath);
        }
    }

    async function syncLocked(
        request: DockerUpdaterGitSyncRequest,
        signal: AbortSignal,
        onCommitStarting?: () => void
    ): Promise<DockerUpdaterGitSyncResult> {
        let upstream: InspectedUpstream;
        let head: string;
        try {
            if (signal.aborted) return unavailable("cancelled");
            await assertRepository(signal);
            head = await repositoryHead(signal);
            const parsedRequest = v.safeParse(gitSyncRequestSchema, request);
            if (!parsedRequest.success) return unavailable("invalid-target");
            if (parsedRequest.output.expectedRepositoryHead !== head) {
                return unavailable("conflict");
            }
            upstream = await inspectUpstream(signal);
            const pending = await pendingState(upstream, signal);
            if (parsedRequest.output.changes.length === 0) {
                if (pending.kind === "none") {
                    await preflightRemote(upstream, head, signal);
                    return Object.freeze({
                        composePaths: Object.freeze([]),
                        status: "no-change",
                    });
                }
                if (pending.kind === "unrelated") {
                    return unavailable("unrelated-pending");
                }
                if (await hasStagedChanges(signal)) {
                    return unavailable("unrelated-staged");
                }
                if (!allowLocalUpstreamForTests && credentials === undefined) {
                    return unavailable("upstream");
                }
                const recovered = await pushCommit(upstream, pending.commit, signal);
                if (recovered.status === "pushed") {
                    await preflightRemote(upstream, head, signal);
                }
                return recovered;
            }
            if (pending.kind !== "none") return unavailable("unrelated-pending");
            if (await hasStagedChanges(signal)) {
                return unavailable("unrelated-staged");
            }
            await preflightRemote(upstream, head, signal);
        } catch (error) {
            return unavailable(failureReason(error));
        }

        let changes: readonly ValidatedChange[];
        try {
            changes = await validateChanges(request, head, signal);
        } catch (error) {
            return unavailable(failureReason(error));
        }
        const relativePaths = changes.map((change) => change.relativePath);
        const expectedAfter = new Map(
            changes.map((change) => [
                change.relativePath,
                change.expectedAfterContentSha256,
            ])
        );
        let staged = false;
        let tree: string;
        try {
            // No staged entries existed at preflight, so restoring these exact paths is
            // safe even when validation fails before `git add` changes the index.
            staged = true;
            await stageExactChanges(changes, signal);
            onCommitStarting?.();
            // Freeze and revalidate the entire index. A concurrent stage before
            // `write-tree` is rejected; one after it cannot enter this tree.
            tree = await writeExactTree(head, expectedAfter, signal);
        } catch (error) {
            if (staged && !(await restoreStaging(relativePaths))) {
                return unknownOutcome(relativePaths);
            }
            return unavailable(failureReason(error));
        }

        let commitCommandSucceeded = false;
        try {
            const commit = decodeUtf8(
                await requiredGit(
                    [
                        "commit-tree",
                        tree,
                        "-p",
                        head,
                        "-m",
                        dockerUpdaterGitCommitMessage,
                    ],
                    signal
                )
            ).trim();
            if (!gitObjectPattern.test(commit)) {
                throw new GitBoundaryFailure("repository");
            }
            const result = await git(["update-ref", "HEAD", commit, head], signal);
            commitCommandSucceeded = result.exitCode === 0;
        } catch {
            // HEAD inspection below is authoritative once commit could have started.
        }

        const inspectionSignal = AbortSignal.timeout(commandDeadlineMs);
        let currentHead: string;
        try {
            currentHead = await repositoryHead(inspectionSignal);
        } catch {
            return unknownOutcome(relativePaths);
        }
        if (currentHead === head) {
            if (!(await restoreStaging(relativePaths)))
                return unknownOutcome(relativePaths);
            return unavailable(signal.aborted ? "cancelled" : "repository");
        }
        let commit: ExactAutomationCommit | undefined;
        try {
            commit = await exactAutomationCommit(head, inspectionSignal, expectedAfter);
        } catch {
            return unknownOutcome(relativePaths, currentHead);
        }
        if (commit === undefined || commit.commit !== currentHead) {
            return unknownOutcome(relativePaths, currentHead);
        }
        if (!commitCommandSucceeded && signal.aborted) {
            return Object.freeze({
                commit: commit.commit,
                composePaths: commit.composePaths,
                status: "committed-push-pending",
            });
        }
        return await pushCommit(upstream, commit, signal);
    }

    const adapter: DockerUpdaterGitSync = {
        readHead(signal?: AbortSignal) {
            const operationSignal =
                signal === undefined
                    ? AbortSignal.timeout(commandDeadlineMs)
                    : AbortSignal.any([signal, AbortSignal.timeout(commandDeadlineMs)]);
            return withGitSyncLock(root, async () => {
                try {
                    await assertRepository(operationSignal);
                    return await repositoryHead(operationSignal);
                } catch (error) {
                    throw new Error("Docker updater Git head is unavailable", {
                        cause: error,
                    });
                }
            });
        },
        sync(
            request: DockerUpdaterGitSyncRequest,
            signal?: AbortSignal,
            onCommitStarting?: () => void
        ) {
            const operationSignal =
                signal === undefined
                    ? AbortSignal.timeout(operationDeadlineMs)
                    : AbortSignal.any([signal, AbortSignal.timeout(operationDeadlineMs)]);
            return withGitSyncLock(root, () =>
                syncLocked(request, operationSignal, onCommitStarting)
            );
        },
        verifyHeadFiles(request: DockerUpdaterGitHeadFilesRequest, signal?: AbortSignal) {
            const operationSignal =
                signal === undefined
                    ? AbortSignal.timeout(operationDeadlineMs)
                    : AbortSignal.any([signal, AbortSignal.timeout(operationDeadlineMs)]);
            return withGitSyncLock(root, async () => {
                try {
                    await verifyHeadFilesLocked(request, operationSignal);
                } catch (error) {
                    throw new Error("Docker updater Git HEAD verification failed", {
                        cause: error,
                    });
                }
            });
        },
    };
    return Object.freeze(adapter);
}

/**
 * Resolves and validates the repository at the start of every operation. A missing Docker
 * repository therefore makes only that source unavailable and can recover later without a
 * Dashboard worker restart.
 * @param options Fixed production authorities or narrow private test seams.
 * @returns A fail-closed adapter with no eager filesystem dependency.
 */
export function createDynamicDockerUpdaterGitSync(
    options: DockerUpdaterGitSyncOptions = {}
): DockerUpdaterGitSync {
    const fixedOptions = Object.freeze({ ...options });
    const resolve = (): DockerUpdaterGitSync => createDockerUpdaterGitSync(fixedOptions);
    return Object.freeze({
        async readHead(signal?: AbortSignal): Promise<string> {
            try {
                return await resolve().readHead(signal);
            } catch {
                throw new Error("Docker updater Git head is unavailable");
            }
        },
        async sync(
            request: DockerUpdaterGitSyncRequest,
            signal?: AbortSignal,
            onCommitStarting?: () => void
        ): Promise<DockerUpdaterGitSyncResult> {
            try {
                return await resolve().sync(request, signal, onCommitStarting);
            } catch {
                return unavailable(signal?.aborted === true ? "cancelled" : "repository");
            }
        },
        async verifyHeadFiles(
            request: DockerUpdaterGitHeadFilesRequest,
            signal?: AbortSignal
        ): Promise<void> {
            try {
                await resolve().verifyHeadFiles(request, signal);
            } catch {
                throw new Error("Docker updater Git HEAD verification failed");
            }
        },
    });
}
