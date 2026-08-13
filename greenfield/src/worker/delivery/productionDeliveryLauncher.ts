import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { healthReadinessPath } from "../../contracts/system.ts";
import { deliveryProductionProtocol } from "../../shared/deliveryProductionOperation.ts";
import { parseReleaseManifest } from "../../shared/releaseManifest.ts";
import { fullCommitShaSchema, lowercaseUuidV7Schema } from "../../shared/validation.ts";

const launcherFailureMessage = "Production Delivery executor launch failed";
const maximumOutputBytes = 32 * 1024;
const launchDeadlineMs = 15_000;
const systemdRunExecutable = "/usr/bin/systemd-run";
const systemctlExecutable = "/usr/bin/systemctl";
const envExecutable = "/usr/bin/env";
const maximumManifestBytes = 4 * 1024 * 1024;
const maximumExecutorBytes = 64 * 1024 * 1024;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const absoluteProjectRootSchema = v.pipe(
    v.string(launcherFailureMessage),
    v.maxLength(4096, launcherFailureMessage),
    v.check(
        (value) =>
            path.isAbsolute(value) &&
            path.resolve(value) === value &&
            path.parse(value).root !== value &&
            !value.includes("\0"),
        launcherFailureMessage
    )
);
const readinessUrlSchema = v.pipe(
    v.string(launcherFailureMessage),
    v.url(launcherFailureMessage),
    v.check((value) => {
        try {
            const url = new URL(value);
            return (
                url.protocol === "http:" &&
                url.hostname === "127.0.0.1" &&
                url.pathname === healthReadinessPath &&
                url.username.length === 0 &&
                url.password.length === 0 &&
                url.search.length === 0 &&
                url.hash.length === 0
            );
        } catch {
            return false;
        }
    }, launcherFailureMessage)
);
const optionsSchema = v.strictObject({
    executorReleaseId: fullCommitShaSchema(launcherFailureMessage),
    projectRoot: absoluteProjectRootSchema,
    readinessUrl: readinessUrlSchema,
    runtimeRevision: fullCommitShaSchema(launcherFailureMessage),
    transitionId: lowercaseUuidV7Schema(launcherFailureMessage),
});

export type ProductionDeliveryLaunchOptions = Readonly<
    v.InferOutput<typeof optionsSchema>
>;

export interface ProductionDeliveryLaunchProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export interface ProductionDeliveryLauncherDependencies {
    readonly execute?: (
        command: readonly string[],
        environment: Readonly<Record<string, string>>,
        signal?: AbortSignal
    ) => Promise<ProductionDeliveryLaunchProcessResult>;
}

function failure(): Error {
    return new Error(launcherFailureMessage);
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
            if (total > maximumOutputBytes) throw failure();
            chunks.push(next.value);
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

async function execute(
    command: readonly string[],
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal
): Promise<ProductionDeliveryLaunchProcessResult> {
    const deadline = AbortSignal.timeout(launchDeadlineMs);
    const child = Bun.spawn([...command], {
        cwd: "/",
        env: { ...environment },
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
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
        await child.exited.catch(() => null);
        throw failure();
    }
}

async function requireExactArtifact(
    artifactPath: string,
    expectedMode: bigint
): Promise<void> {
    if (typeof process.getuid !== "function") throw failure();
    const [canonical, status] = await Promise.all([
        realpath(artifactPath),
        lstat(artifactPath, { bigint: true }),
    ]);
    if (
        canonical !== artifactPath ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o7777n) !== expectedMode ||
        status.size <= 0n
    ) {
        throw failure();
    }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.ctimeNs === right.ctimeNs &&
        left.mtimeNs === right.mtimeNs &&
        left.size === right.size
    );
}

async function closeFile(file: FileHandle | undefined): Promise<boolean> {
    if (!file) return true;
    try {
        await file.close();
        return true;
    } catch {
        return false;
    }
}

async function readStableImmutableFile(
    filePath: string,
    maximumBytes: number
): Promise<Uint8Array> {
    if (typeof process.getuid !== "function") throw failure();
    let file: FileHandle | undefined;
    let bytes: Uint8Array | undefined;
    let failed = false;
    try {
        file = await open(filePath, readFlags);
        const [before, canonical] = await Promise.all([
            file.stat({ bigint: true }),
            realpath(`/proc/self/fd/${file.fd}`),
        ]);
        if (
            canonical !== filePath ||
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1n ||
            before.uid !== BigInt(process.getuid()) ||
            (before.mode & 0o7777n) !== 0o400n ||
            before.size <= 0n ||
            before.size > BigInt(maximumBytes)
        ) {
            throw failure();
        }
        bytes = await file.readFile();
        const [after, named] = await Promise.all([
            file.stat({ bigint: true }),
            lstat(filePath, { bigint: true }),
        ]);
        if (
            bytes.byteLength !== Number(before.size) ||
            !sameFile(before, after) ||
            !sameFile(before, named) ||
            named.nlink !== 1n ||
            named.uid !== before.uid ||
            (named.mode & 0o7777n) !== 0o400n
        ) {
            throw failure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeFile(file);
    if (failed || !closed || bytes === undefined) throw failure();
    return bytes;
}

async function requireManifestVerifiedExecutor(
    releaseRoot: string,
    releaseId: string,
    runtimeRevision: string,
    executor: string
): Promise<void> {
    try {
        const manifestBytes = await readStableImmutableFile(
            path.join(releaseRoot, "release-manifest.json"),
            maximumManifestBytes
        );
        const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
            manifestBytes
        );
        const manifest = parseReleaseManifest(JSON.parse(manifestText) as unknown);
        const executorBytes = await readStableImmutableFile(
            executor,
            maximumExecutorBytes
        );
        const artifact = manifest.artifacts.find(
            ({ path: artifactPath }) => artifactPath === "server/productionDelivery.js"
        );
        if (
            manifest.source.commitSha !== releaseId ||
            manifest.runtime.revision !== runtimeRevision ||
            !manifest.processRoles.includes("production-delivery") ||
            !manifest.deliveryProtocols.includes(deliveryProductionProtocol) ||
            artifact?.bytes !== executorBytes.byteLength ||
            artifact.sha256 !==
                new Bun.CryptoHasher("sha256").update(executorBytes).digest("hex")
        ) {
            throw failure();
        }
    } catch {
        throw failure();
    }
}

export interface VerifiedProductionDeliveryExecutor {
    readonly executor: string;
    readonly releaseRoot: string;
    readonly runtimeExecutable: string;
}

/**
 * Revalidates and resolves the exact immutable executor/runtime tuple for control or cutover.
 * @param input Exact release, runtime, and project identity.
 * @returns The verified executor and runtime paths.
 */
export async function resolveVerifiedProductionDeliveryExecutor(
    input: Pick<
        ProductionDeliveryLaunchOptions,
        "executorReleaseId" | "projectRoot" | "runtimeRevision"
    >
): Promise<VerifiedProductionDeliveryExecutor> {
    const options = v.parse(
        v.strictObject({
            executorReleaseId: optionsSchema.entries.executorReleaseId,
            projectRoot: optionsSchema.entries.projectRoot,
            runtimeRevision: optionsSchema.entries.runtimeRevision,
        }),
        input
    );
    const releaseRoot = path.join(
        options.projectRoot,
        "production/releases",
        options.executorReleaseId
    );
    const runtimeExecutable = path.join(
        options.projectRoot,
        "production/runtimes/bun",
        options.runtimeRevision,
        "bun"
    );
    const executor = path.join(releaseRoot, "server/productionDelivery.js");
    await Promise.all([
        requireExactArtifact(runtimeExecutable, 0o500n),
        requireManifestVerifiedExecutor(
            releaseRoot,
            options.executorReleaseId,
            options.runtimeRevision,
            executor
        ),
    ]);
    return Object.freeze({ executor, releaseRoot, runtimeExecutable });
}

function managerEnvironment(): Readonly<Record<string, string>> {
    if (typeof process.getuid !== "function") throw failure();
    const runtimeDirectory = `/run/user/${process.getuid()}`;
    return Object.freeze({
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
        LANG: "C",
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: runtimeDirectory,
    });
}

function transientUnitName(transitionId: string): string {
    return `mira-dashboard-production-delivery-${transitionId.replaceAll("-", "")}`;
}

function activeUnitCommand(transitionId: string): readonly string[] {
    return Object.freeze([
        systemctlExecutable,
        "--user",
        "is-active",
        "--quiet",
        transientUnitName(transitionId),
    ]);
}

function launchCommand(options: ProductionDeliveryLaunchOptions): readonly string[] {
    const releaseRoot = path.join(
        options.projectRoot,
        "production/releases",
        options.executorReleaseId
    );
    const runtimeExecutable = path.join(
        options.projectRoot,
        "production/runtimes/bun",
        options.runtimeRevision,
        "bun"
    );
    const executor = path.join(releaseRoot, "server/productionDelivery.js");
    const unit = transientUnitName(options.transitionId);
    if (typeof process.getuid !== "function") throw failure();
    const runtimeDirectory = `/run/user/${process.getuid()}`;
    return Object.freeze([
        systemdRunExecutable,
        "--user",
        "--collect",
        "--quiet",
        `--unit=${unit}`,
        `--working-directory=${releaseRoot}`,
        "--property=Type=exec",
        "--property=KillMode=control-group",
        "--property=TimeoutStartSec=90min",
        "--property=UMask=0077",
        "--property=NoNewPrivileges=yes",
        "--property=ProtectHome=tmpfs",
        `--property=BindPaths=${options.projectRoot}`,
        "--property=PrivateTmp=yes",
        "--property=PrivateDevices=yes",
        "--property=RestrictSUIDSGID=yes",
        "--property=LockPersonality=yes",
        "--property=InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/opt/docker -/tmp/openclaw",
        "--",
        envExecutable,
        "-i",
        `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDirectory}/bus`,
        "NODE_ENV=production",
        `XDG_RUNTIME_DIR=${runtimeDirectory}`,
        runtimeExecutable,
        executor,
        "--operation=cutover",
        `--project-root=${options.projectRoot}`,
        `--readiness-url=${options.readinessUrl}`,
        `--transition=${options.transitionId}`,
    ]);
}

/**
 * Launches one immutable executor in a transient user-systemd cgroup.
 * `env -i` and a private home mount prevent worker/Doppler/GitHub/Gateway secrets from
 * crossing over; only the exact project root is rebound for release and state mutation.
 */
export async function launchProductionDeliveryExecutor(
    untrustedOptions: ProductionDeliveryLaunchOptions,
    dependencies: ProductionDeliveryLauncherDependencies = {},
    signal?: AbortSignal
): Promise<void> {
    const options = Object.freeze(v.parse(optionsSchema, untrustedOptions));
    await resolveVerifiedProductionDeliveryExecutor({
        executorReleaseId: options.executorReleaseId,
        projectRoot: options.projectRoot,
        runtimeRevision: options.runtimeRevision,
    });
    const result = await (dependencies.execute ?? execute)(
        launchCommand(options),
        managerEnvironment(),
        signal
    );
    if (
        result.exitCode !== 0 ||
        result.stderr.byteLength !== 0 ||
        result.stdout.byteLength !== 0
    ) {
        throw failure();
    }
}

export type ProductionDeliveryExecutorEnsureResult = "already-running" | "launched";

/**
 * Reconciles one exact journal-owned transient executor after process or host restart.
 * The immutable executor/runtime tuple is verified before inspecting the deterministic
 * unit name. Only systemd's exact inactive/not-found statuses permit a new launch.
 * @param untrustedOptions Exact executor launch identity.
 * @param dependencies Optional fixed process boundary.
 * @param signal Optional caller cancellation.
 * @returns Whether the exact executor was already running or newly launched.
 */
export async function ensureProductionDeliveryExecutor(
    untrustedOptions: ProductionDeliveryLaunchOptions,
    dependencies: ProductionDeliveryLauncherDependencies = {},
    signal?: AbortSignal
): Promise<ProductionDeliveryExecutorEnsureResult> {
    const options = Object.freeze(v.parse(optionsSchema, untrustedOptions));
    await resolveVerifiedProductionDeliveryExecutor({
        executorReleaseId: options.executorReleaseId,
        projectRoot: options.projectRoot,
        runtimeRevision: options.runtimeRevision,
    });
    const run = dependencies.execute ?? execute;
    const active = await run(
        activeUnitCommand(options.transitionId),
        managerEnvironment(),
        signal
    );
    if (active.stderr.byteLength !== 0 || active.stdout.byteLength !== 0) {
        throw failure();
    }
    if (active.exitCode === 0) return "already-running";
    if (active.exitCode !== 3 && active.exitCode !== 4) throw failure();
    const launched = await run(launchCommand(options), managerEnvironment(), signal);
    if (
        launched.exitCode !== 0 ||
        launched.stderr.byteLength !== 0 ||
        launched.stdout.byteLength !== 0
    ) {
        throw failure();
    }
    return "launched";
}
