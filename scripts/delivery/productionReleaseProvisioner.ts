import { constants } from "node:fs";
import {
    chmod,
    lstat,
    mkdtemp,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    symlink,
} from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { applicationConfigurationLimits } from "../../src/shared/configuration/applicationConfigurationRegistry.ts";
import {
    parseProductionActivationRecord,
    type ProductionActivationRecord,
} from "../../src/shared/productionActivationRecord.ts";
import {
    maximumProductionReleaseArchiveBytes,
    productionReleaseArtifactReceiptSchema,
} from "../../src/shared/productionReleaseArtifactReceipt.ts";
import { boundedControlSafeTextSchema } from "../../src/shared/validation.ts";
import {
    assertProductionReleaseArchiveListing,
    maximumProductionReleaseArchiveListingBytes,
} from "./productionReleaseArchive.ts";
import {
    productionHostProvisioningRoot,
    productionProvisioningEntrypointName,
    productionProvisioningPairsRoot,
    productionProvisioningPairSelector,
    productionProvisioningRuntimeName,
} from "./provisioning/host-operations/policy.ts";
import { verifyReleaseArtifactIdentity } from "./releaseIdentity.ts";

const failureMessage = "Production release provisioning failed";
const repositoryApi = "https://api.github.com/repos/rajohan/Mira-Dashboard";
const provisioningRoot = productionHostProvisioningRoot;
const releasesRoot = `${provisioningRoot}/releases`;
const productionActivationStatePath =
    "/home/ubuntu/projects/mira-dashboard/production/state/activation.json";
const runtimeExecutable = `${productionProvisioningPairSelector}/${productionProvisioningRuntimeName}`;
const installedEntrypoint = `${productionProvisioningPairSelector}/${productionProvisioningEntrypointName}`;
const maximumJsonBytes = 4 * 1024 * 1024;
const maximumActivationStateBytes = 64 * 1024;
const maximumCommandOutputBytes = 1024 * 1024;
const runtimeProbeExpression =
    "process.stdout.write(JSON.stringify({revision:Bun.revision,version:Bun.version}))";
const localAuthorityPattern = /^([a-f\d]{40})--local(--settled)?$/u;
const publishedAuthorityPattern =
    /^([a-f\d]{40})--(v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)--([a-f\d]{64})--([a-f\d]{64})$/u;

const githubReleaseSchema = v.object({
    assets: v.pipe(
        v.array(
            v.object({
                digest: v.pipe(v.string(), v.regex(/^sha256:[a-f\d]{64}$/u)),
                id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
                name: v.picklist(["receipt.json", "release.tar"]),
                size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
            })
        ),
        v.length(2)
    ),
    draft: v.literal(false),
    prerelease: v.literal(false),
    tag_name: v.pipe(v.string(), v.regex(/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u)),
});

const githubTokenSchema = boundedControlSafeTextSchema(
    applicationConfigurationLimits.githubTokenMaximumLength
);

const githubRefSchema = v.object({
    object: v.object({
        sha: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
        type: v.picklist(["commit", "tag"]),
    }),
});

const runtimeIdentitySchema = v.strictObject({
    revision: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
    version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
});

interface CommandResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

interface TrustedFileStatus {
    readonly gid: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    readonly mode: number;
    readonly mtimeMs: number;
    readonly uid: number;
}

interface ProductionReleaseProvisionerEnvironment {
    readonly canonicalPath: (target: string) => Promise<string>;
    readonly executablePath: string;
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    readonly getUid: () => number | undefined;
    readonly installedEntrypoint: string;
    readonly lstat: (target: string) => Promise<TrustedFileStatus>;
    readonly modulePath: string;
    readonly provisioningRoot: string;
    readonly provisioningPairSelector: string;
    readonly provisioningPairsRoot: string;
    readonly readDirectory: (target: string) => Promise<string[]>;
    readonly readActivationRecord: (
        expectedUserId: number
    ) => Promise<ProductionActivationRecord | undefined>;
    readonly readGithubToken: () => string;
    readonly remove: (target: string) => Promise<void>;
    readonly rename: (source: string, destination: string) => Promise<void>;
    readonly releasesRoot: string;
    readonly repositoryApi: string;
    readonly runCommand: (
        executable: string,
        arguments_: readonly string[],
        stdin?: Uint8Array,
        stdoutMaximumBytes?: number
    ) => Promise<CommandResult>;
    readonly runtimeExecutable: string;
    readonly syncPath: (target: string) => Promise<void>;
    readonly verifyReleaseArtifactIdentity: typeof verifyReleaseArtifactIdentity;
}

interface StagedProvisioningPair {
    readonly entrypoint: string;
    readonly root: string;
    readonly runtime: string;
}

function failure(): Error {
    return new Error(failureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

async function readProductionActivationRecord(
    expectedUserId: number,
    statePath = productionActivationStatePath
): Promise<ProductionActivationRecord | undefined> {
    let handle;
    try {
        handle = await open(
            statePath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw failure();
    }
    try {
        const before = await handle.stat({ bigint: true });
        if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1n ||
            before.uid !== BigInt(expectedUserId) ||
            (before.mode & 0o7777n) !== 0o600n ||
            before.size <= 0n ||
            before.size > BigInt(maximumActivationStateBytes)
        ) {
            throw failure();
        }
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (
            bytes.byteLength !== Number(before.size) ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.ctimeNs !== after.ctimeNs ||
            before.mtimeNs !== after.mtimeNs ||
            before.size !== after.size ||
            before.uid !== after.uid
        ) {
            throw failure();
        }
        return parseProductionActivationRecord(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
    } catch {
        throw failure();
    } finally {
        await handle.close().catch(() => {
            throw failure();
        });
    }
}

/**
 * Parses the fixed systemd instance authority without accepting unit-name escapes.
 * @param authority Public release instance supplied by the root-owned unit.
 * @returns Exact release and source tuple.
 */
export function parseProductionProvisioningAuthority(authority: string): Readonly<{
    archiveSha256?: string;
    receiptSha256?: string;
    releaseId: string;
    settled: boolean;
    source: string;
}> {
    const local = localAuthorityPattern.exec(authority);
    if (local) {
        return Object.freeze({
            releaseId: local[1]!,
            settled: local[2] !== undefined,
            source: "local",
        });
    }
    const published = publishedAuthorityPattern.exec(authority);
    if (!published) throw failure();
    return Object.freeze({
        archiveSha256: published[4]!,
        receiptSha256: published[3]!,
        releaseId: published[1]!,
        settled: false,
        source: published[2]!,
    });
}

/**
 * Admits only one non-privileged, unaliased maintenance group owned by ubuntu.
 * @param maintenanceGroup Exact named-group line.
 * @param inventory Complete group inventory.
 * @returns Whether the group identity is safe for privileged provisioning.
 */
export function productionMaintenanceGroupIsTrusted(
    maintenanceGroup: string,
    inventory: string
): boolean {
    const fields = maintenanceGroup.split(":");
    const groupId = Number(fields[2]);
    if (
        fields.length !== 4 ||
        fields[0] !== "mira-dashboard-log-maintenance" ||
        !Number.isSafeInteger(groupId) ||
        groupId < 100 ||
        fields[3] !== "ubuntu"
    ) {
        return false;
    }
    const aliases = inventory
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((line) => Number(line.split(":")[2]) === groupId);
    return aliases.length === 1 && aliases[0] === maintenanceGroup;
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function cancelResponse(response: Response, reason: string): Promise<void> {
    try {
        await response.body?.cancel(reason);
    } catch {
        // Rejected provider bodies are discarded without exposing diagnostics.
    }
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
    if (!response.ok) {
        await cancelResponse(response, failureMessage);
        throw failure();
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
        await cancelResponse(response, failureMessage);
        throw failure();
    }
    if (response.body === null) throw failure();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value as Uint8Array;
            if (chunk.byteLength > maximum - length) {
                await reader.cancel(failureMessage).catch(() => {});
                throw failure();
            }
            length += chunk.byteLength;
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    if (length === 0 || (declared !== null && Number(declared) !== length)) {
        throw failure();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function githubJson(
    endpoint: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<unknown> {
    const bytes = await boundedBytes(
        await environment.fetch(`${environment.repositoryApi}${endpoint}`, {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${environment.readGithubToken()}`,
                "User-Agent": "mira-dashboard-production-provisioner",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
        }),
        maximumJsonBytes
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function githubAsset(
    assetId: number,
    maximum: number,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<Uint8Array> {
    return boundedBytes(
        await environment.fetch(
            `${environment.repositoryApi}/releases/assets/${assetId}`,
            {
                headers: {
                    Accept: "application/octet-stream",
                    Authorization: `Bearer ${environment.readGithubToken()}`,
                    "User-Agent": "mira-dashboard-production-provisioner",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                redirect: "follow",
                signal: AbortSignal.timeout(5 * 60_000),
            }
        ),
        maximum
    );
}

async function githubAssetToFile(
    assetId: number,
    maximum: number,
    target: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<Readonly<{ bytes: number; sha256: string }>> {
    const response = await environment.fetch(
        `${environment.repositoryApi}/releases/assets/${assetId}`,
        {
            headers: {
                Accept: "application/octet-stream",
                Authorization: `Bearer ${environment.readGithubToken()}`,
                "User-Agent": "mira-dashboard-production-provisioner",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(5 * 60_000),
        }
    );
    if (!response.ok) {
        await cancelResponse(response, failureMessage);
        throw failure();
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
        await cancelResponse(response, failureMessage);
        throw failure();
    }
    if (response.body === null) throw failure();
    const handle = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o400
    );
    const reader = response.body.getReader();
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value as Uint8Array;
            if (chunk.byteLength > maximum - bytes) {
                await reader.cancel(failureMessage).catch(() => {});
                throw failure();
            }
            bytes += chunk.byteLength;
            hasher.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
                const written = await handle.write(
                    chunk,
                    offset,
                    chunk.byteLength - offset
                );
                if (written.bytesWritten <= 0) throw failure();
                offset += written.bytesWritten;
            }
        }
        if (bytes === 0 || (declared !== null && Number(declared) !== bytes)) {
            throw failure();
        }
        await handle.sync();
        return Object.freeze({ bytes, sha256: hasher.digest("hex") });
    } catch {
        await rm(target, { force: true }).catch(() => {});
        throw failure();
    } finally {
        reader.releaseLock();
        await handle.close();
    }
}

async function resolveTagCommit(
    tagName: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<string> {
    let object = v.parse(
        githubRefSchema,
        await githubJson(`/git/ref/tags/${encodeURIComponent(tagName)}`, environment)
    ).object;
    for (let depth = 0; object.type === "tag" && depth < 4; depth += 1) {
        object = v.parse(
            githubRefSchema,
            await githubJson(`/git/tags/${object.sha}`, environment)
        ).object;
    }
    if (object.type !== "commit") throw failure();
    return object.sha;
}

async function readBoundedStream(
    stream: ReadableStream<Uint8Array>,
    maximumBytes = maximumCommandOutputBytes
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > maximumBytes) throw failure();
            chunks.push(next.value);
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

async function run(
    executable: string,
    arguments_: readonly string[],
    stdin?: Uint8Array,
    stdoutMaximumBytes = maximumCommandOutputBytes
): Promise<CommandResult> {
    const child = Bun.spawn([executable, ...arguments_], {
        env: {
            HOME: "/root",
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        },
        signal: AbortSignal.timeout(120_000),
        stderr: "pipe",
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedStream(child.stdout, stdoutMaximumBytes),
            readBoundedStream(child.stderr),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw failure();
    }
}

async function requireSuccess(
    executable: string,
    arguments_: readonly string[],
    environment: ProductionReleaseProvisionerEnvironment,
    stdin?: Uint8Array,
    stdoutMaximumBytes?: number
): Promise<Uint8Array> {
    const result = await environment.runCommand(
        executable,
        arguments_,
        stdin,
        stdoutMaximumBytes
    );
    if (result.exitCode !== 0) throw failure();
    return result.stdout;
}

async function verifyInstalledBoundary(
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    if (environment.getUid() !== 0) {
        throw failure();
    }
    const selectorStatus = await environment.lstat(environment.provisioningPairSelector);
    if (
        !selectorStatus.isSymbolicLink() ||
        selectorStatus.uid !== 0 ||
        selectorStatus.gid !== 0
    ) {
        throw failure();
    }
    const pairRoot = await environment.canonicalPath(
        environment.provisioningPairSelector
    );
    if (
        path.dirname(pairRoot) !== environment.provisioningPairsRoot ||
        !/^[a-f\d]{40}$/u.test(path.basename(pairRoot)) ||
        (await environment.canonicalPath(environment.executablePath)) !==
            path.join(pairRoot, productionProvisioningRuntimeName) ||
        (await environment.canonicalPath(environment.modulePath)) !==
            path.join(pairRoot, productionProvisioningEntrypointName)
    ) {
        throw failure();
    }
    for (const target of [
        environment.runtimeExecutable,
        environment.installedEntrypoint,
    ]) {
        const status = await environment.lstat(target);
        if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.uid !== 0 ||
            status.gid !== 0 ||
            (status.mode & 0o022) !== 0
        ) {
            throw failure();
        }
        let ancestor = environment.provisioningRoot;
        while (true) {
            const ancestorStatus = await environment.lstat(ancestor);
            if (
                !ancestorStatus.isDirectory() ||
                ancestorStatus.isSymbolicLink() ||
                ancestorStatus.uid !== 0 ||
                ancestorStatus.gid !== 0 ||
                (ancestorStatus.mode & 0o022) !== 0
            ) {
                throw failure();
            }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
        }
    }
}

async function verifyStagedRelease(
    releaseId: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<string> {
    const releaseRoot = path.join(environment.releasesRoot, releaseId);
    const manifest = await environment.verifyReleaseArtifactIdentity(releaseRoot);
    if (manifest.source.commitSha !== releaseId) {
        throw failure();
    }
    return releaseRoot;
}

async function verifyReceiptBackedRelease(
    releaseId: string,
    releaseRoot: string,
    receipt: v.InferOutput<typeof productionReleaseArtifactReceiptSchema>,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    const manifest = await environment.verifyReleaseArtifactIdentity(releaseRoot);
    const manifestBytes = await readFile(path.join(releaseRoot, "release-manifest.json"));
    if (
        manifest.source.commitSha !== releaseId ||
        manifest.runtime.version !== receipt.runtime.version ||
        manifest.runtime.revision !== receipt.runtime.revision ||
        sha256(manifestBytes) !== receipt.releaseManifestSha256
    ) {
        throw failure();
    }
}

/**
 * Hashes one root-controlled file with the fixed host utility.
 * @param target Absolute file path.
 * @param environment Privileged command boundary.
 * @returns Lowercase SHA-256 digest.
 */
async function sha256File(
    target: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<string> {
    const output = new TextDecoder("utf-8", { fatal: true })
        .decode(await requireSuccess("/usr/bin/sha256sum", [target], environment))
        .trim();
    const match = /^([a-f\d]{64}) {2}/.exec(output);
    if (!match) throw failure();
    return match[1]!;
}

/**
 * Reads the exact identity reported by one root-controlled Bun executable.
 * @param executable Candidate runtime path.
 * @param environment Privileged command boundary.
 * @returns Validated Bun identity.
 */
async function probeRuntime(
    executable: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<v.InferOutput<typeof runtimeIdentitySchema>> {
    const output = await requireSuccess(
        executable,
        ["-e", runtimeProbeExpression],
        environment
    );
    try {
        return v.parse(
            runtimeIdentitySchema,
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(output)
            ) as unknown
        );
    } catch {
        throw failure();
    }
}

async function verifyProvisioningPair(
    pairRoot: string,
    releaseRoot: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<StagedProvisioningPair> {
    const manifest = await environment.verifyReleaseArtifactIdentity(releaseRoot);
    const runtime = path.join(pairRoot, productionProvisioningRuntimeName);
    const entrypoint = path.join(pairRoot, productionProvisioningEntrypointName);
    const sourceRuntime = path.join(releaseRoot, "runtime/bun");
    const sourceEntrypoint = path.join(releaseRoot, "server/productionProvisioning.js");
    const [entries, pairStatus, runtimeStatus, entrypointStatus] = await Promise.all([
        environment.readDirectory(pairRoot),
        environment.lstat(pairRoot),
        environment.lstat(runtime),
        environment.lstat(entrypoint),
    ]);
    if (
        entries.toSorted().join("\n") !==
            [productionProvisioningEntrypointName, productionProvisioningRuntimeName]
                .toSorted()
                .join("\n") ||
        !pairStatus.isDirectory() ||
        pairStatus.isSymbolicLink() ||
        pairStatus.uid !== 0 ||
        pairStatus.gid !== 0 ||
        (pairStatus.mode & 0o022) !== 0 ||
        [runtimeStatus, entrypointStatus].some(
            (status) =>
                !status.isFile() ||
                status.isSymbolicLink() ||
                status.uid !== 0 ||
                status.gid !== 0 ||
                (status.mode & 0o022) !== 0
        ) ||
        (await sha256File(runtime, environment)) !==
            (await sha256File(sourceRuntime, environment)) ||
        (await sha256File(entrypoint, environment)) !==
            (await sha256File(sourceEntrypoint, environment))
    ) {
        throw failure();
    }
    const identity = await probeRuntime(runtime, environment);
    if (
        identity.revision !== manifest.runtime.revision ||
        identity.version !== manifest.runtime.version
    ) {
        throw failure();
    }
    return Object.freeze({ entrypoint, root: pairRoot, runtime });
}

async function stageProvisioningPair(
    releaseId: string,
    releaseRoot: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<StagedProvisioningPair> {
    const destination = path.join(environment.provisioningPairsRoot, releaseId);
    try {
        await environment.lstat(destination);
        return await verifyProvisioningPair(destination, releaseRoot, environment);
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw failure();
    }
    const staged = await mkdtemp(path.join(environment.provisioningRoot, ".pair-stage-"));
    try {
        for (const [source, name] of [
            [path.join(releaseRoot, "runtime/bun"), productionProvisioningRuntimeName],
            [
                path.join(releaseRoot, "server/productionProvisioning.js"),
                productionProvisioningEntrypointName,
            ],
        ] as const) {
            await requireSuccess(
                "/usr/bin/install",
                [
                    "-o",
                    "root",
                    "-g",
                    "root",
                    "-m",
                    "0555",
                    source,
                    path.join(staged, name),
                ],
                environment
            );
            await environment.syncPath(path.join(staged, name));
        }
        await chmod(staged, 0o700);
        await environment.syncPath(staged);
        await verifyProvisioningPair(staged, releaseRoot, environment);
        await environment.rename(staged, destination);
        await chmod(destination, 0o500);
        await environment.syncPath(destination);
        await environment.syncPath(environment.provisioningPairsRoot);
        return await verifyProvisioningPair(destination, releaseRoot, environment);
    } finally {
        await chmod(staged, 0o700).catch(() => {});
        await environment.remove(staged).catch(() => {});
    }
}

async function selectProvisioningPair(
    pair: StagedProvisioningPair,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    const temporarySelector = `${environment.provisioningRoot}/.current-${Bun.randomUUIDv7()}`;
    try {
        await symlink(pair.root, temporarySelector, "dir");
        await environment.rename(temporarySelector, environment.provisioningPairSelector);
        await environment.syncPath(environment.provisioningRoot);
    } finally {
        await environment.remove(temporarySelector).catch(() => {});
    }
}

async function publishProvisioningPairSelection(
    releaseId: string,
    requireSettledCurrent: boolean,
    publishSelector: () => Promise<void>,
    retainRoots: (candidateReleaseId: string, requireSettled: boolean) => Promise<void>
): Promise<void> {
    try {
        await publishSelector();
        await retainRoots(releaseId, requireSettledCurrent);
    } catch {
        await retainRoots(releaseId, false).catch(() => {});
        throw failure();
    }
}

async function downloadAndStageRelease(
    releaseId: string,
    tagName: string,
    expectedDigests: Readonly<{
        archiveSha256: string;
        receiptSha256: string;
    }>,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<string> {
    const release = v.parse(
        githubReleaseSchema,
        await githubJson(`/releases/tags/${encodeURIComponent(tagName)}`, environment)
    );
    if (
        release.tag_name !== tagName ||
        (await resolveTagCommit(tagName, environment)) !== releaseId
    ) {
        throw failure();
    }
    const receiptAsset = release.assets.find(({ name }) => name === "receipt.json");
    const archiveAsset = release.assets.find(({ name }) => name === "release.tar");
    if (
        !receiptAsset ||
        !archiveAsset ||
        receiptAsset.digest !== `sha256:${expectedDigests.receiptSha256}` ||
        archiveAsset.digest !== `sha256:${expectedDigests.archiveSha256}`
    ) {
        throw failure();
    }
    const receiptBytes = await githubAsset(
        receiptAsset.id,
        maximumJsonBytes,
        environment
    );
    if (
        receiptBytes.byteLength !== receiptAsset.size ||
        `sha256:${sha256(receiptBytes)}` !== receiptAsset.digest
    ) {
        throw failure();
    }
    const receipt = v.parse(
        productionReleaseArtifactReceiptSchema,
        JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)
        ) as unknown
    );
    if (
        receipt.releaseId !== releaseId ||
        receipt.archive.bytes !== archiveAsset.size ||
        `sha256:${receipt.archive.sha256}` !== archiveAsset.digest
    ) {
        throw failure();
    }
    const temporaryRoot = await mkdtemp(
        path.join(environment.provisioningRoot, ".release-stage-")
    );
    try {
        const archivePath = path.join(temporaryRoot, "release.tar");
        const archive = await githubAssetToFile(
            archiveAsset.id,
            maximumProductionReleaseArchiveBytes,
            archivePath,
            environment
        );
        if (
            archive.bytes !== archiveAsset.size ||
            archive.bytes !== receipt.archive.bytes ||
            archive.sha256 !== receipt.archive.sha256
        ) {
            throw failure();
        }
        const listing = await requireSuccess(
            "/usr/bin/tar",
            ["-tf", archivePath],
            environment,
            undefined,
            maximumProductionReleaseArchiveListingBytes
        );
        assertProductionReleaseArchiveListing(
            new TextDecoder("utf-8", { fatal: true }).decode(listing),
            releaseId
        );
        await requireSuccess(
            "/usr/bin/tar",
            ["-xf", archivePath, "--no-same-owner", "-C", temporaryRoot],
            environment
        );
        const stagedRoot = path.join(temporaryRoot, releaseId);
        await verifyReceiptBackedRelease(releaseId, stagedRoot, receipt, environment);
        await syncReleaseTree(stagedRoot, environment);
        await environment.syncPath(temporaryRoot);
        const destination = path.join(environment.releasesRoot, releaseId);
        let destinationStatus: TrustedFileStatus | undefined;
        try {
            destinationStatus = await environment.lstat(destination);
        } catch (error) {
            if (errorCode(error) !== "ENOENT") throw failure();
        }
        if (destinationStatus !== undefined) {
            if (
                !destinationStatus.isDirectory() ||
                destinationStatus.isSymbolicLink() ||
                destinationStatus.uid !== 0 ||
                destinationStatus.gid !== 0 ||
                (destinationStatus.mode & 0o022) !== 0
            ) {
                throw failure();
            }
            const existingRoot = await verifyStagedRelease(releaseId, environment);
            await verifyReceiptBackedRelease(
                releaseId,
                existingRoot,
                receipt,
                environment
            );
            return existingRoot;
        }
        await environment.rename(stagedRoot, destination);
        await environment.syncPath(temporaryRoot);
        await environment.syncPath(environment.releasesRoot);
        return await verifyStagedRelease(releaseId, environment);
    } finally {
        await chmod(temporaryRoot, 0o700).catch(() => {});
        await rm(temporaryRoot, { force: true, recursive: true }).catch(() => {});
    }
}

async function syncReleaseTree(
    target: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    const status = await environment.lstat(target);
    if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
        throw failure();
    }
    if (status.isDirectory()) {
        for (const name of await environment.readDirectory(target)) {
            if (name === "." || name === ".." || name.includes("/")) throw failure();
            await syncReleaseTree(path.join(target, name), environment);
        }
    }
    await environment.syncPath(target);
}

async function validateReleaseRoots(
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    const rootNames = await environment.readDirectory(environment.releasesRoot);
    await Promise.all(
        rootNames.map(async (name) => {
            if (!/^[a-f\d]{40}$/u.test(name)) throw failure();
            const status = await environment.lstat(
                path.join(environment.releasesRoot, name)
            );
            if (
                !status.isDirectory() ||
                status.isSymbolicLink() ||
                status.uid !== 0 ||
                status.gid !== 0 ||
                (status.mode & 0o022) !== 0
            ) {
                throw failure();
            }
        })
    );
}

async function retainReleaseRoots(
    candidateReleaseId: string | undefined,
    requireSettledCurrent: boolean,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    await validateReleaseRoots(environment);
    const retained = new Set(
        candidateReleaseId === undefined ? [] : [candidateReleaseId]
    );
    const userIdText = new TextDecoder("utf-8", { fatal: true })
        .decode(await requireSuccess("/usr/bin/id", ["-u", "ubuntu"], environment))
        .trim();
    if (!/^[1-9]\d{0,9}$/u.test(userIdText)) throw failure();
    const activation = await environment.readActivationRecord(Number(userIdText));
    if (requireSettledCurrent && activation?.current.releaseId !== candidateReleaseId) {
        throw failure();
    }
    if (activation) {
        retained.add(activation.current.releaseId);
        if (activation.previous) retained.add(activation.previous.releaseId);
    }
    const rootNames = await environment.readDirectory(environment.releasesRoot);
    if (candidateReleaseId !== undefined && !rootNames.includes(candidateReleaseId)) {
        throw failure();
    }
    for (const name of rootNames) {
        if (!retained.has(name)) {
            await environment.remove(path.join(environment.releasesRoot, name));
        }
    }
    const pairNames = await environment.readDirectory(environment.provisioningPairsRoot);
    if (pairNames.some((name) => !/^[a-f\d]{40}$/u.test(name))) {
        throw failure();
    }
    for (const name of pairNames) {
        if (!retained.has(name)) {
            await environment.remove(path.join(environment.provisioningPairsRoot, name));
        }
    }
    await environment.syncPath(environment.releasesRoot);
    await environment.syncPath(environment.provisioningPairsRoot);
    await validateReleaseRoots(environment);
}

async function installAuthority(
    releaseId: string,
    releaseRoot: string,
    runtime: string,
    environment: ProductionReleaseProvisionerEnvironment
): Promise<void> {
    const manifestBytes = await readFile(path.join(releaseRoot, "release-manifest.json"));
    const manifestSha256 = sha256(manifestBytes);
    const userIdText = new TextDecoder("utf-8", { fatal: true })
        .decode(await requireSuccess("/usr/bin/id", ["-u", "ubuntu"], environment))
        .trim();
    if (!/^[1-9]\d{0,9}$/u.test(userIdText)) throw failure();
    const maintenanceGroup = new TextDecoder("utf-8", { fatal: true })
        .decode(
            await requireSuccess(
                "/usr/bin/getent",
                ["group", "mira-dashboard-log-maintenance"],
                environment
            )
        )
        .trim();
    const groupInventory = new TextDecoder("utf-8", { fatal: true })
        .decode(await requireSuccess("/usr/bin/getent", ["group"], environment))
        .trim();
    if (!productionMaintenanceGroupIsTrusted(maintenanceGroup, groupInventory)) {
        throw failure();
    }
    const commands: readonly Readonly<{
        executable: string;
        arguments_: readonly string[];
    }>[] = [
        {
            executable: runtime,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts`,
                `--release-root=${releaseRoot}`,
                `--release-id=${releaseId}`,
                `--release-manifest-sha256=${manifestSha256}`,
            ],
        },
        {
            executable: runtime,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts`,
                `--release-root=${releaseRoot}`,
                `--release-id=${releaseId}`,
            ],
        },
        {
            executable: runtime,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/log-maintenance/migrateManagedApplicationLogs.ts`,
                `--user-id=${userIdText}`,
            ],
        },
        {
            executable: "/usr/bin/systemd-tmpfiles",
            arguments_: [
                "--create",
                "/usr/lib/tmpfiles.d/mira-dashboard-managed-container-logs.conf",
            ],
        },
        { executable: "/usr/bin/systemctl", arguments_: ["daemon-reload"] },
        {
            executable: runtime,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/preview-tailscale/operator.ts`,
                "--mode=apply",
            ],
        },
    ];
    for (const command of commands) {
        await requireSuccess(command.executable, command.arguments_, environment);
    }
}

const defaultEnvironment: ProductionReleaseProvisionerEnvironment = Object.freeze({
    canonicalPath: realpath,
    executablePath: process.execPath,
    fetch,
    getUid: () => process.getuid?.(),
    installedEntrypoint,
    lstat,
    modulePath: import.meta.path,
    provisioningRoot,
    provisioningPairSelector: productionProvisioningPairSelector,
    provisioningPairsRoot: productionProvisioningPairsRoot,
    readActivationRecord: readProductionActivationRecord,
    readDirectory: readdir,
    readGithubToken: () => v.parse(githubTokenSchema, process.env.MIRA_GITHUB_TOKEN),
    remove: (target: string) => rm(target, { force: true, recursive: true }),
    rename,
    releasesRoot,
    repositoryApi,
    runCommand: run,
    runtimeExecutable,
    syncPath: async (target: string) => {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    },
    verifyReleaseArtifactIdentity,
});

/** Test-only dependency surface for exercising the privileged orchestration safely. */
export const productionReleaseProvisionerTestSupport = Object.freeze({
    boundedBytes,
    createEnvironment: (
        overrides: Partial<ProductionReleaseProvisionerEnvironment>
    ): ProductionReleaseProvisionerEnvironment =>
        Object.freeze({ ...defaultEnvironment, ...overrides }),
    readBoundedStream,
    readProductionActivationRecord,
    run,
    publishProvisioningPairSelection,
    verifyReceiptBackedRelease: (
        releaseId: string,
        releaseRoot: string,
        receipt: unknown,
        environment: ProductionReleaseProvisionerEnvironment
    ) =>
        verifyReceiptBackedRelease(
            releaseId,
            releaseRoot,
            v.parse(productionReleaseArtifactReceiptSchema, receipt),
            environment
        ),
});

export async function provisionProductionRelease(
    authority: string,
    environment: ProductionReleaseProvisionerEnvironment = defaultEnvironment
): Promise<void> {
    await verifyInstalledBoundary(environment);
    const { archiveSha256, receiptSha256, releaseId, settled, source } =
        parseProductionProvisioningAuthority(authority);
    let pair: StagedProvisioningPair;
    try {
        let releaseRoot: string;
        if (source === "local") {
            releaseRoot = await verifyStagedRelease(releaseId, environment);
        } else {
            if (archiveSha256 === undefined || receiptSha256 === undefined) {
                throw failure();
            }
            releaseRoot = await downloadAndStageRelease(
                releaseId,
                source,
                { archiveSha256, receiptSha256 },
                environment
            );
        }
        pair = await stageProvisioningPair(releaseId, releaseRoot, environment);
        await installAuthority(releaseId, releaseRoot, pair.runtime, environment);
    } catch {
        await retainReleaseRoots(undefined, false, environment).catch(() => {});
        throw failure();
    }
    await publishProvisioningPairSelection(
        releaseId,
        settled,
        () => selectProvisioningPair(pair, environment),
        (candidateReleaseId, requireSettled) =>
            retainReleaseRoots(candidateReleaseId, requireSettled, environment)
    );
}

if (import.meta.main) {
    try {
        const argument = process.argv[2] ?? "";
        if (process.argv.length !== 3 || !argument.startsWith("--authority=")) {
            throw failure();
        }
        await provisionProductionRelease(argument.slice("--authority=".length));
        process.stdout.write("Production release authority installed.\n");
    } catch {
        process.stderr.write(`${failureMessage}\n`);
        process.exitCode = 1;
    }
}
