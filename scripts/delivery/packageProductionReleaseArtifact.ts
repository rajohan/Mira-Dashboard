import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    productionReleaseArtifactReceiptSchema as receiptSchema,
    type ProductionReleaseArtifactReceipt,
} from "../../src/shared/productionReleaseArtifactReceipt.ts";
import { releaseManifestSchema } from "../../src/shared/releaseManifest.ts";

export { productionReleaseArtifactReceiptSchema } from "../../src/shared/productionReleaseArtifactReceipt.ts";

const failureMessage = "Production release artifact packaging failed";
const projectRoot = path.resolve(import.meta.dir, "../..");
const archiveName = "release.tar";
const receiptName = "receipt.json";

export interface PackageProductionReleaseArtifactOptions {
    readonly projectRoot?: string;
    readonly releaseId?: string;
    readonly requireProductionArchitecture?: boolean;
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function resolveReleaseId(repositoryRoot: string): Promise<string> {
    const child = Bun.spawn(["/usr/bin/git", "rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        stderr: "ignore",
        stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
    ]);
    const releaseId = stdout.trim();
    if (exitCode !== 0 || !/^[a-f\d]{40}$/u.test(releaseId)) {
        throw new Error(failureMessage);
    }
    return releaseId;
}

async function runTar(
    repositoryRoot: string,
    outputRoot: string,
    releaseId: string
): Promise<void> {
    const child = Bun.spawn(
        [
            "/usr/bin/tar",
            "--format=posix",
            "--sort=name",
            "--mtime=@0",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "-cf",
            path.join(outputRoot, archiveName),
            "-C",
            path.join(repositoryRoot, "dist/releases"),
            releaseId,
        ],
        { cwd: repositoryRoot, stderr: "inherit", stdout: "inherit" }
    );
    if ((await child.exited) !== 0) throw new Error(failureMessage);
}

/**
 * Packages one verified immutable release with a digest-bound machine receipt.
 * @param options Optional deterministic repository and source identity for tests.
 * @returns The validated receipt written beside the release archive.
 */
export async function packageProductionReleaseArtifact(
    options: PackageProductionReleaseArtifactOptions = {}
): Promise<ProductionReleaseArtifactReceipt> {
    if (
        options.requireProductionArchitecture === true &&
        (process.platform !== "linux" || process.arch !== "arm64")
    ) {
        throw new Error(failureMessage);
    }
    const repositoryRoot = options.projectRoot ?? projectRoot;
    const outputRoot = path.join(repositoryRoot, "dist/production-release-artifact");
    const releaseId = options.releaseId ?? (await resolveReleaseId(repositoryRoot));
    if (!/^[a-f\d]{40}$/u.test(releaseId)) throw new Error(failureMessage);
    const releaseRoot = path.join(repositoryRoot, "dist/releases", releaseId);
    const selectedRuntimeVersionFile = await readFile(
        path.join(repositoryRoot, ".bun-version"),
        "utf8"
    );
    const selectedRuntimeVersion = selectedRuntimeVersionFile.trim();
    const manifestBytes = await readFile(path.join(releaseRoot, "release-manifest.json"));
    const manifest = v.parse(
        releaseManifestSchema,
        JSON.parse(manifestBytes.toString("utf8"))
    );
    if (
        manifest.source.commitSha !== releaseId ||
        manifest.runtime.version !== selectedRuntimeVersion
    ) {
        throw new Error(failureMessage);
    }
    await rm(outputRoot, { force: true, recursive: true });
    await mkdir(outputRoot, { mode: 0o700, recursive: false });
    await runTar(repositoryRoot, outputRoot, releaseId);
    const archiveBytes = await readFile(path.join(outputRoot, archiveName));
    const receipt = Object.freeze(
        v.parse(receiptSchema, {
            archive: {
                bytes: archiveBytes.byteLength,
                name: archiveName,
                sha256: sha256(archiveBytes),
            },
            formatVersion: 1,
            releaseId,
            releaseManifestSha256: sha256(manifestBytes),
            runtime: {
                revision: manifest.runtime.revision,
                version: manifest.runtime.version,
            },
        })
    );
    await writeFile(
        path.join(outputRoot, receiptName),
        `${JSON.stringify(receipt, undefined, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    return receipt;
}

if (import.meta.main) {
    try {
        const receipt = await packageProductionReleaseArtifact({
            requireProductionArchitecture: true,
        });
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } catch {
        process.stderr.write(`${failureMessage}\n`);
        process.exitCode = 1;
    }
}
