import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildFrontendScenario } from "./frontendBuildScenario.ts";

/** Resource-budget evidence emitted by the isolated frontend build fixture. */
export interface FrontendBuildEvidence {
    compressedSidecarCount: number;
    formatVersion: 1;
    initialAssetCount: number;
    outputFileCount: number;
    sourceMapsIncluded: false;
}

/**
 * Runs the self-contained production-shaped frontend build scenario.
 * @param outdir Disposable build output directory.
 * @returns Bounded build and delivery evidence.
 */
export async function runFrontendBuildEvidence(
    outdir: string
): Promise<FrontendBuildEvidence> {
    const evidence = await buildFrontendScenario("production", outdir);
    const sourceMapsIncluded = evidence.outputPaths.some((file) => file.endsWith(".map"));
    if (sourceMapsIncluded || !evidence.metrics) {
        throw new Error("Production frontend scenario emitted invalid evidence");
    }
    return {
        compressedSidecarCount: evidence.compressedFileCount,
        formatVersion: evidence.metrics.formatVersion,
        initialAssetCount: evidence.initialOutputPaths.length,
        outputFileCount: evidence.outputPaths.length,
        sourceMapsIncluded: false,
    };
}

if (import.meta.main) {
    const outdir = await mkdtemp(path.join(tmpdir(), "mira-frontend-build-evidence-"));
    try {
        console.log(JSON.stringify(await runFrontendBuildEvidence(outdir), undefined, 2));
    } finally {
        await rm(outdir, { force: true, recursive: true });
    }
}
