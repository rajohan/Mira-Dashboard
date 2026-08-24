import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { productionReleaseArtifactReceiptSchema } from "../../src/shared/productionReleaseArtifactReceipt.ts";
import { assertProductionReleaseArchiveListing } from "./productionReleaseArchive.ts";
import { verifyReleaseArtifactIdentity } from "./releaseIdentity.ts";

const failureMessage = "Production release provisioning failed";
const repositoryApi = "https://api.github.com/repos/rajohan/Mira-Dashboard";
const provisioningRoot = "/var/lib/mira-dashboard-host-provisioning";
const releasesRoot = `${provisioningRoot}/releases`;
const runtimeExecutable = `${provisioningRoot}/runtime/bun`;
const installedEntrypoint =
    "/usr/local/libexec/mira-dashboard-production-provisioning.js";
const maximumJsonBytes = 4 * 1024 * 1024;
const maximumArchiveBytes = 512 * 1024 * 1024;
const maximumCommandOutputBytes = 1024 * 1024;
const authorityPattern =
    /^([a-f\d]{40})--(local|v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)$/u;

const githubReleaseSchema = v.strictObject({
    assets: v.pipe(
        v.array(
            v.strictObject({
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

const githubRefSchema = v.object({
    object: v.object({
        sha: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
        type: v.picklist(["commit", "tag"]),
    }),
});

interface CommandResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

function failure(): Error {
    return new Error(failureMessage);
}

/**
 * Parses the fixed systemd instance authority without accepting unit-name escapes.
 * @param authority Public release instance supplied by the root-owned unit.
 * @returns Exact release and source tuple.
 */
export function parseProductionProvisioningAuthority(
    authority: string
): Readonly<{ releaseId: string; source: string }> {
    const match = authorityPattern.exec(authority);
    if (!match) throw failure();
    return Object.freeze({ releaseId: match[1]!, source: match[2]! });
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

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
    if (!response.ok) throw failure();
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
        throw failure();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximum) throw failure();
    return bytes;
}

async function githubJson(endpoint: string): Promise<unknown> {
    const bytes = await boundedBytes(
        await fetch(`${repositoryApi}${endpoint}`, {
            headers: {
                Accept: "application/vnd.github+json",
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

async function githubAsset(assetId: number, maximum: number): Promise<Uint8Array> {
    return boundedBytes(
        await fetch(`${repositoryApi}/releases/assets/${assetId}`, {
            headers: {
                Accept: "application/octet-stream",
                "User-Agent": "mira-dashboard-production-provisioner",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(60_000),
        }),
        maximum
    );
}

async function resolveTagCommit(tagName: string): Promise<string> {
    let object = v.parse(
        githubRefSchema,
        await githubJson(`/git/ref/tags/${encodeURIComponent(tagName)}`)
    ).object;
    for (let depth = 0; object.type === "tag" && depth < 4; depth += 1) {
        object = v.parse(
            githubRefSchema,
            await githubJson(`/git/tags/${object.sha}`)
        ).object;
    }
    if (object.type !== "commit") throw failure();
    return object.sha;
}

async function readBoundedStream(
    stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > maximumCommandOutputBytes) throw failure();
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
    arguments_: readonly string[]
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
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedStream(child.stdout),
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
    arguments_: readonly string[]
): Promise<Uint8Array> {
    const result = await run(executable, arguments_);
    if (result.exitCode !== 0) throw failure();
    return result.stdout;
}

async function verifyInstalledBoundary(): Promise<void> {
    if (
        process.getuid?.() !== 0 ||
        process.execPath !== runtimeExecutable ||
        import.meta.path !== installedEntrypoint
    ) {
        throw failure();
    }
    for (const target of [runtimeExecutable, installedEntrypoint]) {
        const status = await lstat(target);
        if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.uid !== 0 ||
            status.gid !== 0 ||
            (status.mode & 0o022) !== 0
        ) {
            throw failure();
        }
        let ancestor = path.dirname(target);
        while (true) {
            const ancestorStatus = await lstat(ancestor);
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

async function verifyStagedRelease(releaseId: string): Promise<string> {
    const releaseRoot = path.join(releasesRoot, releaseId);
    const manifest = await verifyReleaseArtifactIdentity(releaseRoot);
    if (manifest.source.commitSha !== releaseId) {
        throw failure();
    }
    return releaseRoot;
}

async function downloadAndStageRelease(
    releaseId: string,
    tagName: string
): Promise<string> {
    const release = v.parse(
        githubReleaseSchema,
        await githubJson(`/releases/tags/${encodeURIComponent(tagName)}`)
    );
    if (release.tag_name !== tagName || (await resolveTagCommit(tagName)) !== releaseId) {
        throw failure();
    }
    const receiptAsset = release.assets.find(({ name }) => name === "receipt.json");
    const archiveAsset = release.assets.find(({ name }) => name === "release.tar");
    if (!receiptAsset || !archiveAsset) throw failure();
    const receiptBytes = await githubAsset(receiptAsset.id, maximumJsonBytes);
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
    const archiveBytes = await githubAsset(archiveAsset.id, maximumArchiveBytes);
    if (
        archiveBytes.byteLength !== archiveAsset.size ||
        archiveBytes.byteLength !== receipt.archive.bytes ||
        sha256(archiveBytes) !== receipt.archive.sha256
    ) {
        throw failure();
    }
    const temporaryRoot = await mkdtemp(path.join(provisioningRoot, ".release-stage-"));
    try {
        const archivePath = path.join(temporaryRoot, "release.tar");
        await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o400 });
        const listing = await requireSuccess("/usr/bin/tar", ["-tf", archivePath]);
        assertProductionReleaseArchiveListing(
            new TextDecoder("utf-8", { fatal: true }).decode(listing),
            releaseId
        );
        await requireSuccess("/usr/bin/tar", ["-xf", archivePath, "-C", temporaryRoot]);
        const stagedRoot = path.join(temporaryRoot, releaseId);
        const manifest = await verifyReleaseArtifactIdentity(stagedRoot);
        const manifestBytes = await readFile(
            path.join(stagedRoot, "release-manifest.json")
        );
        if (
            manifest.source.commitSha !== releaseId ||
            manifest.runtime.version !== receipt.runtime.version ||
            manifest.runtime.revision !== receipt.runtime.revision ||
            sha256(manifestBytes) !== receipt.releaseManifestSha256
        ) {
            throw failure();
        }
        const destination = path.join(releasesRoot, releaseId);
        await rename(stagedRoot, destination).catch((error: unknown) => {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error as NodeJS.ErrnoException).code !== "EEXIST"
            ) {
                throw error;
            }
        });
        return await verifyStagedRelease(releaseId);
    } finally {
        await chmod(temporaryRoot, 0o700).catch(() => {});
        await rm(temporaryRoot, { force: true, recursive: true }).catch(() => {});
    }
}

async function installAuthority(releaseId: string, releaseRoot: string): Promise<void> {
    const manifestBytes = await readFile(path.join(releaseRoot, "release-manifest.json"));
    const manifestSha256 = sha256(manifestBytes);
    const userIdText = new TextDecoder("utf-8", { fatal: true })
        .decode(await requireSuccess("/usr/bin/id", ["-u", "ubuntu"]))
        .trim();
    if (!/^[1-9]\d{0,9}$/u.test(userIdText)) throw failure();
    const maintenanceGroup = new TextDecoder("utf-8", { fatal: true })
        .decode(
            await requireSuccess("/usr/bin/getent", [
                "group",
                "mira-dashboard-log-maintenance",
            ])
        )
        .trim();
    const groupInventory = new TextDecoder("utf-8", { fatal: true })
        .decode(await requireSuccess("/usr/bin/getent", ["group"]))
        .trim();
    if (!productionMaintenanceGroupIsTrusted(maintenanceGroup, groupInventory)) {
        throw failure();
    }
    const commands: readonly Readonly<{
        executable: string;
        arguments_: readonly string[];
    }>[] = [
        {
            executable: runtimeExecutable,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts`,
                `--release-root=${releaseRoot}`,
                `--release-id=${releaseId}`,
                `--release-manifest-sha256=${manifestSha256}`,
            ],
        },
        {
            executable: runtimeExecutable,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts`,
                `--release-root=${releaseRoot}`,
                `--release-id=${releaseId}`,
            ],
        },
        {
            executable: runtimeExecutable,
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
            executable: runtimeExecutable,
            arguments_: [
                `${releaseRoot}/scripts/delivery/provisioning/preview-tailscale/operator.ts`,
                "--mode=apply",
            ],
        },
    ];
    for (const command of commands) {
        await requireSuccess(command.executable, command.arguments_);
    }
}

export async function provisionProductionRelease(authority: string): Promise<void> {
    await verifyInstalledBoundary();
    const { releaseId, source } = parseProductionProvisioningAuthority(authority);
    const releaseRoot =
        source === "local"
            ? await verifyStagedRelease(releaseId)
            : await verifyStagedRelease(releaseId).catch(async () => {
                  await rm(path.join(releasesRoot, releaseId), {
                      force: true,
                      recursive: true,
                  });
                  return downloadAndStageRelease(releaseId, source);
              });
    await installAuthority(releaseId, releaseRoot);
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
