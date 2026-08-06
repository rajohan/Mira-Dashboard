import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildFrontend } from "../../scripts/frontendBuild";
import { assertSelfHostedFrontendHtml } from "./frontendBuildQualification";

const hashedAssetPattern = /^assets\/.+-[a-z\d]{8}\.(?:css|js)$/u;

export interface ActualFrontendBuildEvidence {
    compressedSidecarCount: number;
    formatVersion: 1;
    hashedAssetCount: number;
    outputFileCount: number;
    sourceMapsIncluded: false;
}

/**
 * Runs the selected existing production build in a separate qualification process.
 * @param outdir Disposable build output directory.
 * @returns Actual frontend build evidence.
 */
export async function runActualFrontendBuildQualification(
    outdir: string
): Promise<ActualFrontendBuildEvidence> {
    await buildFrontend({ mode: "production", outdir });
    const files = await listRelativeFiles(outdir);
    const hashedAssetCount = files.filter((file) => hashedAssetPattern.test(file)).length;
    const compressedSidecarCount = files.filter(
        (file) => file.endsWith(".br") || file.endsWith(".gz")
    ).length;
    const sourceMapsIncluded = files.some((file) => file.endsWith(".map"));
    const metrics = await readFile(
        path.join(outdir, "frontend-bundle-metrics.json"),
        "utf8"
    );

    if (hashedAssetCount < 10) {
        throw new Error("Existing frontend build did not emit hashed route assets");
    }
    if (compressedSidecarCount === 0) {
        throw new Error("Existing frontend build did not emit compressed sidecars");
    }
    if (sourceMapsIncluded) {
        throw new Error("Production frontend build emitted source maps");
    }
    if (!metrics.includes('"formatVersion": 1')) {
        throw new Error("Existing frontend build emitted an unknown metrics format");
    }
    await assertSelfHostedFrontendHtml(path.join(outdir, "index.html"));

    return {
        compressedSidecarCount,
        formatVersion: 1,
        hashedAssetCount,
        outputFileCount: files.length,
        sourceMapsIncluded: false,
    };
}

async function listRelativeFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) continue;
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            } else if (entry.isFile()) {
                files.push(path.relative(directory, entryPath).replaceAll("\\", "/"));
            }
        }
    }
    return files.toSorted();
}

if (import.meta.main) {
    const outdir = await mkdtemp(path.join(tmpdir(), "mira-frontend-build-evidence-"));
    try {
        // eslint-disable-next-line no-console -- The manual runner emits its evidence artifact.
        console.log(
            JSON.stringify(
                await runActualFrontendBuildQualification(outdir),
                undefined,
                2
            )
        );
    } finally {
        await rm(outdir, { force: true, recursive: true });
    }
}
