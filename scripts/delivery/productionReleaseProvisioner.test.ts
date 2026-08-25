import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    serializeProductionActivationRecord,
    type ProductionActivationRecord,
} from "../../src/shared/productionActivationRecord.ts";
import {
    createLocalReleaseFixture,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import {
    parseProductionProvisioningAuthority,
    productionMaintenanceGroupIsTrusted,
    productionReleaseProvisionerTestSupport,
    provisionProductionRelease,
} from "./productionReleaseProvisioner.ts";
import { verifyReleaseArtifactIdentity } from "./releaseIdentity.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

afterEach(() => removeProductionDeliveryFixtures(temporaryDirectories));

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function response(bytes: Uint8Array, status = 200): Response {
    return new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
        status,
    });
}

function commandResult(stdout: string | Uint8Array = new Uint8Array(), exitCode = 0) {
    return Object.freeze({
        exitCode,
        stderr: new Uint8Array(),
        stdout: typeof stdout === "string" ? encoder.encode(stdout) : stdout,
    });
}

function trustedStatus(isFile: boolean) {
    return {
        gid: 0,
        isDirectory: () => !isFile,
        isFile: () => isFile,
        isSymbolicLink: () => false,
        mode: isFile ? 33_088 : 16_877,
        mtimeMs: 0,
        uid: 0,
    };
}

async function expectProvisioningFailure(promise: Promise<unknown>): Promise<void> {
    try {
        await promise;
        throw new Error("Expected provisioning to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Production release provisioning failed");
    }
}

async function restoreOwnerWrite(target: string): Promise<void> {
    const status = await lstat(target).catch(() => null);
    if (!status) return;
    if (status.isDirectory()) {
        await chmod(target, 0o700);
        for (const entry of await readdir(target)) {
            await restoreOwnerWrite(path.join(target, entry));
        }
    } else if (status.isFile()) {
        await chmod(target, 0o600);
    }
}

describe("production release root provisioner", () => {
    test("parses only exact local and semantic release authorities", () => {
        const releaseId = "a".repeat(40);
        expect(parseProductionProvisioningAuthority(`${releaseId}--local`)).toEqual({
            releaseId,
            settled: false,
            source: "local",
        });
        expect(
            parseProductionProvisioningAuthority(`${releaseId}--local--settled`)
        ).toEqual({ releaseId, settled: true, source: "local" });
        expect(
            parseProductionProvisioningAuthority(
                `${releaseId}--v1.2.3--${"b".repeat(64)}--${"c".repeat(64)}`
            )
        ).toEqual({
            archiveSha256: "c".repeat(64),
            receiptSha256: "b".repeat(64),
            releaseId,
            settled: false,
            source: "v1.2.3",
        });
        for (const authority of [
            `${releaseId}--v1.2.3`,
            `${releaseId}--v1.2.3/service`,
            `${releaseId}--../local`,
            `-${releaseId}--local`,
            `${releaseId}--v1.2.3--${"b".repeat(64)}--${"c".repeat(64)}--settled`,
        ]) {
            expect(() => parseProductionProvisioningAuthority(authority)).toThrow(
                "Production release provisioning failed"
            );
        }
    });

    test("rejects privileged, aliased, and unexpected maintenance groups", () => {
        const trusted = "mira-dashboard-log-maintenance:x:986:ubuntu";
        expect(productionMaintenanceGroupIsTrusted(trusted, trusted)).toBe(true);
        expect(
            productionMaintenanceGroupIsTrusted(
                "mira-dashboard-log-maintenance:x:0:ubuntu",
                "mira-dashboard-log-maintenance:x:0:ubuntu"
            )
        ).toBe(false);
        expect(
            productionMaintenanceGroupIsTrusted(
                trusted,
                `${trusted}\nprivileged-alias:x:986:`
            )
        ).toBe(false);
        expect(
            productionMaintenanceGroupIsTrusted(
                "mira-dashboard-log-maintenance:x:986:root",
                "mira-dashboard-log-maintenance:x:986:root"
            )
        ).toBe(false);
    });

    test("reads only one bounded owner-private activation record", async () => {
        const userId = process.getuid?.();
        if (userId === undefined) throw new Error("Linux user identity is unavailable");
        const root = await mkdtemp(path.join(tmpdir(), "mira-activation-record-"));
        temporaryDirectories.push(root);
        const statePath = path.join(root, "activation.json");
        const aliasPath = path.join(root, "activation-alias.json");
        const record: ProductionActivationRecord = Object.freeze({
            current: Object.freeze({
                releaseId: "c".repeat(40),
                runtimeRevision: "d".repeat(40),
            }),
            formatVersion: 1,
            previous: null,
            transitionId: "0198dbef-13cd-7b5e-a09b-1a7b09cf8e5b",
        });
        await writeFile(statePath, serializeProductionActivationRecord(record), {
            mode: 0o600,
        });
        await symlink(statePath, aliasPath);

        expect(
            await productionReleaseProvisionerTestSupport.readProductionActivationRecord(
                userId,
                statePath
            )
        ).toEqual(record);
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.readProductionActivationRecord(
                userId,
                aliasPath
            )
        );
        await chmod(statePath, 0o640);
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.readProductionActivationRecord(
                userId,
                statePath
            )
        );
    });

    test("bounds response and subprocess bytes", async () => {
        expect(
            await productionReleaseProvisionerTestSupport.boundedBytes(
                response(encoder.encode("ok")),
                2
            )
        ).toEqual(encoder.encode("ok"));
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.boundedBytes(
                response(encoder.encode("large")),
                2
            )
        );
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.boundedBytes(
                response(encoder.encode("error"), 500),
                16
            )
        );
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.boundedBytes(
                new Response(encoder.encode("size"), {
                    headers: { "content-length": "2" },
                }),
                8
            )
        );
        let canceled = false;
        let chunk = 0;
        const oversizedStream = new ReadableStream<Uint8Array>({
            cancel: () => {
                canceled = true;
            },
            pull: (controller) => {
                chunk += 1;
                controller.enqueue(encoder.encode(chunk === 1 ? "ok" : "x"));
            },
        });
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.boundedBytes(
                new Response(oversizedStream),
                2
            )
        );
        expect(canceled).toBe(true);

        const result = await productionReleaseProvisionerTestSupport.run(
            "/usr/bin/tee",
            [],
            encoder.encode("root-owned-input")
        );
        expect(result.exitCode).toBe(0);
        expect(new TextDecoder().decode(result.stdout)).toBe("root-owned-input");
    });

    test("retains the candidate when selector publication does not settle", async () => {
        const releaseId = "c".repeat(40);
        const retained: Array<Readonly<{ releaseId: string; settled: boolean }>> = [];
        let selectorPublished = false;

        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.publishProvisioningPairSelection(
                releaseId,
                true,
                () => {
                    selectorPublished = true;
                    return Promise.reject(new Error("selector sync failed"));
                },
                (candidateReleaseId, requireSettled) => {
                    retained.push(
                        Object.freeze({
                            releaseId: candidateReleaseId,
                            settled: requireSettled,
                        })
                    );
                    return Promise.resolve();
                }
            )
        );

        expect(selectorPublished).toBe(true);
        expect(retained).toEqual([{ releaseId, settled: false }]);
    });

    test("downloads, digest-admits, stages, and installs one published release", async () => {
        const releaseId = "c".repeat(40);
        const runtime = { revision: "d".repeat(40), version: Bun.version };
        const sourceReleaseRoot = await createLocalReleaseFixture(
            sourceProjectRoot,
            releaseId,
            runtime,
            temporaryDirectories
        );
        const provisioningRoot = await mkdtemp(
            path.join(tmpdir(), "mira-root-provisioning-")
        );
        temporaryDirectories.push(provisioningRoot);
        const releasesRoot = path.join(provisioningRoot, "releases");
        await mkdir(releasesRoot);
        await Promise.all([
            cp(sourceReleaseRoot, path.join(releasesRoot, releaseId), {
                recursive: true,
            }),
            mkdir(path.join(releasesRoot, "a".repeat(40))),
            mkdir(path.join(releasesRoot, "b".repeat(40))),
        ]);
        await Promise.all([chmod(provisioningRoot, 0o700), chmod(releasesRoot, 0o700)]);
        const activationRecord: ProductionActivationRecord = Object.freeze({
            current: Object.freeze({
                releaseId,
                runtimeRevision: runtime.revision,
            }),
            formatVersion: 1,
            previous: Object.freeze({
                databaseSnapshotTransitionId: "0198dbef-13cd-7b5e-a09b-1a7b09cf8e5b",
                releaseId: "a".repeat(40),
                runtimeRevision: runtime.revision,
            }),
            transitionId: "0198dbef-13cd-7b5e-a09b-1a7b09cf8e5c",
        });
        const manifestBytes = await readFile(
            path.join(sourceReleaseRoot, "release-manifest.json")
        );
        const archiveBytes = encoder.encode("verified archive fixture");
        const receiptBytes = encoder.encode(
            JSON.stringify({
                archive: {
                    bytes: archiveBytes.byteLength,
                    name: "release.tar",
                    sha256: sha256(archiveBytes),
                },
                formatVersion: 1,
                releaseId,
                releaseManifestSha256: sha256(manifestBytes),
                runtime,
            })
        );
        const tagName = "v1.2.3";
        const commands: string[] = [];
        const syncedPaths: string[] = [];
        let assetDownloads = 0;
        let releaseRootPublications = 0;
        const provisioningPairsRoot = path.join(provisioningRoot, "pairs");
        const previousPair = path.join(provisioningPairsRoot, "b".repeat(40));
        const provisioningPairSelector = path.join(provisioningRoot, "current");
        const runtimeExecutable = path.join(provisioningPairSelector, "bun");
        const installedEntrypoint = path.join(
            provisioningPairSelector,
            "productionProvisioning.js"
        );
        await mkdir(previousPair, { recursive: true });
        await cp(
            path.join(sourceReleaseRoot, "runtime/bun"),
            path.join(previousPair, "bun")
        );
        await writeFile(
            path.join(previousPair, "productionProvisioning.js"),
            "installed provisioning entrypoint"
        );
        await symlink(previousPair, provisioningPairSelector, "dir");
        const environment = productionReleaseProvisionerTestSupport.createEnvironment({
            executablePath: runtimeExecutable,
            fetch: (url, init) => {
                expect(new Headers(init.headers).get("authorization")).toBe(
                    "Bearer github-token-sentinel"
                );
                if (url.endsWith(`/releases/tags/${tagName}`)) {
                    return Promise.resolve(
                        response(
                            encoder.encode(
                                JSON.stringify({
                                    assets: [
                                        {
                                            digest: `sha256:${sha256(receiptBytes)}`,
                                            id: 1,
                                            name: "receipt.json",
                                            size: receiptBytes.byteLength,
                                            url: "https://api.github.test/assets/1",
                                        },
                                        {
                                            digest: `sha256:${sha256(archiveBytes)}`,
                                            id: 2,
                                            name: "release.tar",
                                            size: archiveBytes.byteLength,
                                            url: "https://api.github.test/assets/2",
                                        },
                                    ],
                                    draft: false,
                                    id: 123,
                                    prerelease: false,
                                    tag_name: tagName,
                                    url: "https://api.github.test/releases/123",
                                })
                            )
                        )
                    );
                }
                if (url.endsWith(`/git/ref/tags/${tagName}`)) {
                    return Promise.resolve(
                        response(
                            encoder.encode(
                                JSON.stringify({
                                    object: { sha: releaseId, type: "commit" },
                                })
                            )
                        )
                    );
                }
                if (url.endsWith("/releases/assets/1")) {
                    assetDownloads += 1;
                    return Promise.resolve(response(receiptBytes));
                }
                if (url.endsWith("/releases/assets/2")) {
                    assetDownloads += 1;
                    return Promise.resolve(response(archiveBytes));
                }
                return Promise.resolve(response(encoder.encode("missing"), 404));
            },
            getUid: () => 0,
            installedEntrypoint,
            lstat: async (target) => {
                const status = await lstat(target);
                const trusted = trustedStatus(status.isFile());
                return {
                    ...trusted,
                    isDirectory: () => status.isDirectory(),
                    isFile: () => status.isFile(),
                    isSymbolicLink: () => status.isSymbolicLink(),
                    mode: status.isSymbolicLink()
                        ? constants.S_IFLNK | 0o777
                        : trusted.mode,
                };
            },
            modulePath: installedEntrypoint,
            provisioningRoot,
            provisioningPairSelector,
            provisioningPairsRoot,
            readActivationRecord: () => Promise.resolve(activationRecord),
            readGithubToken: () => "github-token-sentinel",
            rename: async (source, destination) => {
                if (destination === path.join(releasesRoot, releaseId)) {
                    releaseRootPublications += 1;
                }
                await rename(source, destination);
            },
            remove: async (target) => {
                await restoreOwnerWrite(target);
                await rm(target, { force: true, recursive: true });
            },
            releasesRoot,
            runCommand: async (executable, arguments_, stdin) => {
                commands.push(`${executable} ${arguments_.join(" ")}`);
                if (executable === "/usr/bin/install") {
                    await cp(arguments_[6]!, arguments_[7]!);
                    return commandResult();
                }
                if (executable === "/usr/bin/sha256sum") {
                    const target = arguments_[0]!;
                    return commandResult(
                        `${sha256(await readFile(target))}  ${target}\n`
                    );
                }
                if (arguments_[0] === "-e" && executable.endsWith("/bun")) {
                    return commandResult(JSON.stringify(runtime));
                }
                if (executable === "/usr/bin/tar" && arguments_[0] === "-tf") {
                    expect(stdin).toBeUndefined();
                    expect(await readFile(arguments_[1]!)).toEqual(archiveBytes);
                    return commandResult(
                        `${releaseId}/\n${releaseId}/release-manifest.json\n`
                    );
                }
                if (executable === "/usr/bin/tar" && arguments_[0] === "-xf") {
                    expect(stdin).toBeUndefined();
                    expect(await readFile(arguments_[1]!)).toEqual(archiveBytes);
                    expect(arguments_).toContain("--no-same-owner");
                    await cp(sourceReleaseRoot, path.join(arguments_[4]!, releaseId), {
                        recursive: true,
                    });
                    return commandResult();
                }
                if (executable === "/usr/bin/id") return commandResult("1000\n");
                if (executable === "/usr/bin/getent") {
                    return commandResult("mira-dashboard-log-maintenance:x:986:ubuntu\n");
                }
                return commandResult();
            },
            runtimeExecutable,
            syncPath: (target) => {
                syncedPaths.push(target);
                return Promise.resolve();
            },
            verifyReleaseArtifactIdentity,
        });

        await expectProvisioningFailure(
            provisionProductionRelease(
                `${releaseId}--${tagName}--${"0".repeat(64)}--${sha256(archiveBytes)}`,
                environment
            )
        );
        expect(
            JSON.parse(
                await readFile(
                    path.join(releasesRoot, releaseId, "release-manifest.json"),
                    "utf8"
                )
            )
        ).toMatchObject({ source: { commitSha: releaseId } });
        const retainedAfterRejectedDownload = await readdir(releasesRoot);
        expect(retainedAfterRejectedDownload.toSorted()).toEqual(
            ["a".repeat(40), "b".repeat(40), releaseId].toSorted()
        );

        const cachedReleaseRoot = path.join(releasesRoot, releaseId);
        await restoreOwnerWrite(cachedReleaseRoot);
        const mismatchedManifest = JSON.parse(manifestBytes.toString("utf8")) as {
            runtime: { revision: string };
        };
        mismatchedManifest.runtime.revision = "e".repeat(40);
        await writeFile(
            path.join(cachedReleaseRoot, "release-manifest.json"),
            `${JSON.stringify(mismatchedManifest)}\n`
        );
        await expectProvisioningFailure(
            productionReleaseProvisionerTestSupport.verifyReceiptBackedRelease(
                releaseId,
                cachedReleaseRoot,
                JSON.parse(new TextDecoder().decode(receiptBytes)) as unknown,
                environment
            )
        );
        await writeFile(
            path.join(cachedReleaseRoot, "release-manifest.json"),
            manifestBytes
        );

        await provisionProductionRelease(
            `${releaseId}--${tagName}--${sha256(receiptBytes)}--${sha256(archiveBytes)}`,
            environment
        );

        expect(
            await verifyReleaseArtifactIdentity(path.join(releasesRoot, releaseId))
        ).toMatchObject({ source: { commitSha: releaseId }, runtime });
        expect(commands).toContain("/usr/bin/systemctl daemon-reload");
        expect(assetDownloads).toBe(2);
        expect(
            syncedPaths.some((target) =>
                target.endsWith(`/${releaseId}/release-manifest.json`)
            )
        ).toBe(true);
        expect(syncedPaths).toContain(releasesRoot);
        expect(syncedPaths.some((target) => target.includes("/.pair-stage-"))).toBe(true);
        expect(syncedPaths).toContain(provisioningPairsRoot);
        const retainedAfterPublishedInstall = await readdir(releasesRoot);
        expect(retainedAfterPublishedInstall.toSorted()).toEqual(
            ["a".repeat(40), releaseId].toSorted()
        );
        expect(releaseRootPublications).toBe(0);
        const runtimeInstallIndex = commands.findIndex((command) =>
            command.startsWith("/usr/bin/install -o root -g root -m 0555")
        );
        const authorityInstallIndex = commands.findIndex((command) =>
            command.includes("installHostOperationsProvisioning.ts")
        );
        expect(runtimeInstallIndex).toBeGreaterThanOrEqual(0);
        expect(authorityInstallIndex).toBeGreaterThan(runtimeInstallIndex);
        expect(await readlink(provisioningPairSelector)).toBe(
            path.join(provisioningPairsRoot, releaseId)
        );
    });
});
