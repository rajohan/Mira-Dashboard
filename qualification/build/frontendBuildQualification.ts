import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import tailwindPlugin from "bun-plugin-tailwind";

import {
    assertFrontendBundleBudgets,
    initialFrontendOutputKeys,
    measureFrontendBundle,
    type FrontendBundleMetrics,
    writeFrontendHtmlAppEntrypoint,
    writePrecompressedFrontendAssets,
} from "../../scripts/frontendBuildArtifacts";
import reactCompilerPlugin from "../../scripts/reactCompilerPlugin";

export type QualificationFrontendBuildMode = "development" | "production";

export interface QualificationFrontendBuildEvidence {
    compressedFileCount: number;
    initialOutputPaths: string[];
    metafile: Bun.BuildMetafile;
    metrics?: FrontendBundleMetrics;
    outputPaths: string[];
}

const qualificationFrontendEntrypoint = path.resolve(
    "qualification/build/fixtures/frontend/index.html"
);

export const qualificationFrontendPluginOrder = [
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
export async function buildQualificationFrontend(
    mode: QualificationFrontendBuildMode,
    outdir: string
): Promise<QualificationFrontendBuildEvidence> {
    const resolvedOutdir = path.resolve(outdir);
    const isProduction = mode === "production";

    await rm(resolvedOutdir, { force: true, recursive: true });
    await mkdir(resolvedOutdir, { recursive: true });

    const result = await Bun.build({
        define: {
            "process.env.NODE_ENV": JSON.stringify(mode),
        },
        entrypoints: [qualificationFrontendEntrypoint],
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
        throw new AggregateError(result.logs, "Qualification frontend build failed");
    }
    if (!result.metafile) {
        throw new Error("Qualification frontend build did not produce metadata");
    }

    await writeFrontendHtmlAppEntrypoint(result.metafile, resolvedOutdir);
    const initialOutputPaths = [...initialFrontendOutputKeys(result.metafile)].map(
        (outputPath) => normalizedOutputPath(outputPath, resolvedOutdir)
    );
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

    const metrics = await measureFrontendBundle(result.metafile, resolvedOutdir);
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

/**
 * Fails when generated HTML would require inline or third-party script/style CSP.
 * @param indexPath Generated HTML entrypoint.
 * @returns Promise that resolves when the entrypoint is self-hosted.
 */
export async function assertSelfHostedFrontendHtml(indexPath: string): Promise<void> {
    const html = await readFile(indexPath, "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
    const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu)];
    if (scripts.length !== 1 || styles.length > 0) {
        throw new Error(
            "Frontend HTML must contain one external script and no inline styles"
        );
    }

    const scriptAttributes = scripts[0]?.[1] ?? "";
    const scriptBody = scripts[0]?.[2] ?? "";
    const source = scriptAttributes.match(/\bsrc=(['"])([^'"]+)\1/iu)?.[2];
    if (
        !/\btype=(['"])module\1/iu.test(scriptAttributes) ||
        !source?.startsWith("/assets/") ||
        scriptBody.trim().length > 0
    ) {
        throw new Error("Frontend HTML module script must be external and self-hosted");
    }

    const nonSelfHostedResource = html.match(
        /\b(?:href|src)=(['"])(?:[a-z][a-z\d+.-]*:|\/\/)[^'"]*\1/iu
    );
    if (nonSelfHostedResource) {
        throw new Error("Frontend HTML cannot depend on a third-party CSP origin");
    }
}

function normalizedOutputPath(outputPath: string, outdir: string): string {
    return path.relative(outdir, path.resolve(outputPath)).replaceAll("\\", "/");
}
