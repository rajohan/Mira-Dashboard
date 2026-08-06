import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import tailwindPlugin from "bun-plugin-tailwind";

import {
    assertFrontendBundleBudgets,
    assertSelfHostedFrontendHtml,
    measureFrontendBundle,
    type FrontendBundleMetrics,
    writeFrontendHtmlAppEntrypoint,
    writePrecompressedFrontendAssets,
} from "../frontendBuildArtifacts.ts";
import reactCompilerPlugin from "../reactCompilerPlugin.ts";
import { withBunBuildAdmission } from "./buildAdmission.ts";
import { parseBuildOutputArgument } from "./buildCli.ts";
import { resolveRepositoryBuildPath } from "./buildPaths.ts";

const browserAppInput = "src/browser/main.tsx";
const browserHtmlEntrypoint = "src/browser/index.html";
const browserMetricsFileName = "bundle-metrics.json";

/** Deterministic browser artifact evidence returned to release orchestration. */
export interface BrowserBuildResult {
    readonly compressedFileCount: number;
    readonly metrics: FrontendBundleMetrics;
    readonly outputDirectory: string;
}

function validatedBuildOutputDirectory(
    repositoryRoot: string,
    outputDirectory: string
): string {
    return resolveRepositoryBuildPath(
        repositoryRoot,
        outputDirectory,
        "Browser build paths are invalid"
    ).output;
}

/**
 * Builds the actual Dashboard browser entry with the compiler-first production pipeline.
 * The output path must be a strict child of this repository's ignored `dist` directory.
 * @param repositoryRoot Canonical future-root checkout.
 * @param outputDirectory Explicit contained output directory.
 * @returns Browser artifact metrics and compression evidence.
 */
export async function buildBrowserArtifact(
    repositoryRoot: string,
    outputDirectory: string
): Promise<BrowserBuildResult> {
    const output = validatedBuildOutputDirectory(repositoryRoot, outputDirectory);
    const entrypoint = path.join(repositoryRoot, browserHtmlEntrypoint);

    return withBunBuildAdmission(repositoryRoot, async () => {
        await rm(output, { force: true, recursive: true });
        await mkdir(output, { recursive: true });

        const result = await Bun.build({
            define: { "process.env.NODE_ENV": JSON.stringify("production") },
            entrypoints: [entrypoint],
            metafile: true,
            minify: true,
            naming: {
                asset: "assets/[name]-[hash].[ext]",
                chunk: "assets/[name]-[hash].[ext]",
            },
            outdir: output,
            plugins: [reactCompilerPlugin, tailwindPlugin],
            publicPath: "/",
            sourcemap: "none",
            splitting: true,
            target: "browser",
        });
        if (!result.success) {
            throw new AggregateError(result.logs, "Dashboard browser build failed");
        }
        if (!result.metafile) {
            throw new Error("Dashboard browser build did not produce metadata");
        }

        await writeFrontendHtmlAppEntrypoint(result.metafile, output, browserAppInput);
        await assertSelfHostedFrontendHtml(path.join(output, "index.html"));
        const metrics = await measureFrontendBundle(
            result.metafile,
            output,
            browserAppInput
        );
        assertFrontendBundleBudgets(metrics.measurements);
        const compressedFileCount = await writePrecompressedFrontendAssets(
            result.outputs.map(({ path: outputPath }) => outputPath)
        );
        await writeFile(
            path.join(output, browserMetricsFileName),
            `${JSON.stringify(metrics, null, 2)}\n`,
            { encoding: "utf8", flag: "wx" }
        );

        return Object.freeze({
            compressedFileCount,
            metrics: Object.freeze(metrics),
            outputDirectory: output,
        });
    });
}

if (import.meta.main) {
    try {
        const repositoryRoot = path.resolve(import.meta.dir, "../..");
        const result = await buildBrowserArtifact(
            repositoryRoot,
            parseBuildOutputArgument(
                process.argv.slice(2),
                path.join(repositoryRoot, "dist/browser")
            )
        );
        process.stdout.write(
            `${JSON.stringify({
                compressedFileCount: result.compressedFileCount,
                outputDirectory: result.outputDirectory,
                status: "BUILT",
            })}\n`
        );
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Dashboard browser build failed";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
