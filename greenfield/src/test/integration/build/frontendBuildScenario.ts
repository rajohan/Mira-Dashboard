import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import tailwindPlugin from "bun-plugin-tailwind";

import {
    assertSelfHostedFrontendHtml,
    assertFrontendBundleBudgets,
    initialFrontendOutputKeys,
    measureFrontendBundle,
    type FrontendBundleMetrics,
    writeFrontendHtmlAppEntrypoint,
    writePrecompressedFrontendAssets,
} from "../../../../scripts/frontendBuildArtifacts.ts";
import reactCompilerPlugin from "../../../../scripts/reactCompilerPlugin.ts";

export type FrontendBuildScenarioMode = "development" | "production";

export interface FrontendBuildScenarioEvidence {
    compressedFileCount: number;
    initialOutputPaths: string[];
    metafile: Bun.BuildMetafile;
    metrics?: FrontendBundleMetrics;
    outputPaths: string[];
}

const frontendBuildFixtureEntrypoint = path.resolve(
    import.meta.dir,
    "../../../browser/test/fixtures/frontendBuild/index.html"
);
const frontendBuildFixtureAppInput =
    "src/browser/test/fixtures/frontendBuild/src/main.tsx";

export const frontendBuildPluginOrder = [
    reactCompilerPlugin.name,
    tailwindPlugin.name,
] as const;

/**
 * Builds a minimal HTML-entry frontend with the target compiler-first pipeline.
 * The fixture intentionally shares the production artifact policy helpers.
 * @param mode Build policy to qualify.
 * @param outdir Disposable build output directory.
 * @returns Build metadata and delivery evidence.
 */
export async function buildFrontendScenario(
    mode: FrontendBuildScenarioMode,
    outdir: string
): Promise<FrontendBuildScenarioEvidence> {
    const resolvedOutdir = path.resolve(outdir);
    const isProduction = mode === "production";

    await rm(resolvedOutdir, { force: true, recursive: true });
    await mkdir(resolvedOutdir, { recursive: true });

    const result = await Bun.build({
        define: {
            "process.env.NODE_ENV": JSON.stringify(mode),
        },
        entrypoints: [frontendBuildFixtureEntrypoint],
        minify: isProduction,
        metafile: true,
        naming: {
            asset: "assets/[name]-[hash].[ext]",
            chunk: "assets/[name]-[hash].[ext]",
        },
        outdir: resolvedOutdir,
        plugins: [reactCompilerPlugin, tailwindPlugin],
        publicPath: "/",
        sourcemap: isProduction ? "none" : "linked",
        splitting: true,
        target: "browser",
    });

    if (!result.success) {
        throw new AggregateError(result.logs, "Frontend build scenario failed");
    }
    if (!result.metafile) {
        throw new Error("Frontend build scenario did not produce metadata");
    }

    await writeFrontendHtmlAppEntrypoint(
        result.metafile,
        resolvedOutdir,
        frontendBuildFixtureAppInput
    );
    await assertSelfHostedFrontendHtml(path.join(resolvedOutdir, "index.html"));
    const initialOutputPaths = [
        ...initialFrontendOutputKeys(result.metafile, frontendBuildFixtureAppInput),
    ].map((outputPath) => normalizedOutputPath(outputPath, resolvedOutdir));
    const outputPaths = result.outputs.map(({ path: outputPath }) =>
        normalizedOutputPath(outputPath, resolvedOutdir)
    );

    if (!isProduction) {
        return {
            compressedFileCount: 0,
            initialOutputPaths,
            metafile: result.metafile,
            outputPaths,
        };
    }

    const metrics = await measureFrontendBundle(
        result.metafile,
        resolvedOutdir,
        frontendBuildFixtureAppInput
    );
    assertFrontendBundleBudgets(metrics.measurements);
    const compressedFileCount = await writePrecompressedFrontendAssets(
        result.outputs.map(({ path: outputPath }) => outputPath)
    );

    return {
        compressedFileCount,
        initialOutputPaths,
        metafile: result.metafile,
        metrics,
        outputPaths,
    };
}

function normalizedOutputPath(outputPath: string, outdir: string): string {
    return path.relative(outdir, path.resolve(outputPath)).replaceAll("\\", "/");
}
