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
    import.meta.dir,
    "fixtures/frontend/index.html"
);

export const qualificationFrontendPluginOrder = [
    reactCompilerPlugin.name,
    tailwindPlugin.name,
] as const;

const frontendHtmlResourceAttributes = new Set([
    "action",
    "background",
    "cite",
    "data",
    "formaction",
    "href",
    "manifest",
    "poster",
    "src",
    "xlink:href",
]);
const frontendHtmlSourceSetAttributes = new Set(["imagesrcset", "srcset"]);

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
    const scripts: Array<{ body: string; source: string | null; type: string | null }> =
        [];
    let styleCount = 0;
    let hasInlineEventHandler = false;
    let hasInlineSourceDocument = false;
    let hasInlineStyle = false;
    let hasNonSelfHostedResource = false;
    let hasBaseElement = false;
    const rewriter = new HTMLRewriter()
        .on("*", {
            element(element) {
                for (const [name, value] of element.attributes) {
                    const normalizedName = name.toLowerCase();
                    if (normalizedName.startsWith("on")) {
                        hasInlineEventHandler = true;
                    } else if (normalizedName === "srcdoc") {
                        hasInlineSourceDocument = true;
                    } else if (normalizedName === "style") {
                        hasInlineStyle = true;
                    } else if (
                        frontendHtmlResourceAttributes.has(normalizedName) &&
                        !isSelfHostedResourceReference(value)
                    ) {
                        hasNonSelfHostedResource = true;
                    } else if (
                        frontendHtmlSourceSetAttributes.has(normalizedName) &&
                        !isSelfHostedSourceSet(value)
                    ) {
                        hasNonSelfHostedResource = true;
                    }
                }
            },
        })
        .on("base", {
            element() {
                hasBaseElement = true;
            },
        })
        .on("script", {
            element(element) {
                scripts.push({
                    body: "",
                    source: element.getAttribute("src"),
                    type: element.getAttribute("type"),
                });
            },
            text(text) {
                const script = scripts.at(-1);
                if (script) script.body += text.text;
            },
        })
        .on("style", {
            element() {
                styleCount += 1;
            },
        });
    rewriter.transform(html);

    if (
        scripts.length !== 1 ||
        styleCount > 0 ||
        hasInlineEventHandler ||
        hasInlineSourceDocument ||
        hasInlineStyle ||
        hasBaseElement
    ) {
        throw new Error(
            "Frontend HTML must contain one external script and no inline code"
        );
    }

    const script = scripts[0]!;
    if (
        script.type !== "module" ||
        !script.source?.startsWith("/assets/") ||
        script.body.trim().length > 0
    ) {
        throw new Error("Frontend HTML module script must be external and self-hosted");
    }

    if (hasNonSelfHostedResource) {
        throw new Error("Frontend HTML cannot depend on a third-party CSP origin");
    }
}

function isSelfHostedResourceReference(value: string): boolean {
    const reference = value.trim();
    if (reference.length === 0 || reference.includes("&") || reference.includes("\\")) {
        return false;
    }
    if (/^[a-z][a-z\d+.-]*:/iu.test(reference) || reference.startsWith("//")) {
        return false;
    }
    try {
        const base = new URL("https://qualification.invalid/");
        const resolved = new URL(reference, base);
        return (
            resolved.origin === base.origin && resolved.pathname.startsWith("/assets/")
        );
    } catch {
        return false;
    }
}

function isSelfHostedSourceSet(value: string): boolean {
    const candidates = value.split(",");
    return (
        candidates.length > 0 &&
        candidates.every((candidate) => {
            const tokens = candidate.trim().split(/\s+/u);
            if (
                tokens.length === 0 ||
                tokens.length > 2 ||
                !isSelfHostedResourceReference(tokens[0] ?? "")
            ) {
                return false;
            }
            const descriptor = tokens[1];
            return (
                descriptor === undefined ||
                /^\d+w$/u.test(descriptor) ||
                /^(?:\d+|\d*\.\d+)x$/u.test(descriptor)
            );
        })
    );
}

function normalizedOutputPath(outputPath: string, outdir: string): string {
    return path.relative(outdir, path.resolve(outputPath)).replaceAll("\\", "/");
}
