import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const COMPRESSIBLE_EXTENSIONS = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".svg",
    ".txt",
    ".webmanifest",
    ".xml",
]);
const MINIMUM_COMPRESSION_BYTES = 512;
const SCRIPT_TAG_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script(?:\s[^>]*)?>/giu;
const SCRIPT_SOURCE_ATTRIBUTE_PATTERN = /\bsrc=(["'])([^"']+)\1/iu;
const MODULE_SCRIPT_TYPE_PATTERN = /\btype=(["'])module\1/iu;
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

export interface FrontendBundleMeasurements {
    initialJavaScriptGzipBytes: number;
    initialJavaScriptRawBytes: number;
    initialStylesheetGzipBytes: number;
    initialStylesheetRawBytes: number;
    largestJavaScriptGzipBytes: number;
    totalJavaScriptGzipBytes: number;
    totalJavaScriptRawBytes: number;
}

type FrontendBundleBudget = keyof Pick<
    FrontendBundleMeasurements,
    | "initialJavaScriptGzipBytes"
    | "initialStylesheetGzipBytes"
    | "largestJavaScriptGzipBytes"
    | "totalJavaScriptGzipBytes"
>;

export const FRONTEND_BUNDLE_BUDGETS: Readonly<Record<FrontendBundleBudget, number>> = {
    initialJavaScriptGzipBytes: 402 * 1024,
    initialStylesheetGzipBytes: 25 * 1024,
    largestJavaScriptGzipBytes: 200 * 1024,
    totalJavaScriptGzipBytes: 1280 * 1024,
};

interface MeasuredOutput {
    gzipBytes: number;
    outputPath: string;
    rawBytes: number;
}

export interface FrontendBundleMetrics {
    budgets: Readonly<Record<FrontendBundleBudget, number>>;
    formatVersion: 1;
    initialFiles: MeasuredOutput[];
    measurements: FrontendBundleMeasurements;
}

function normalizedOutputKey(outputKey: string): string {
    return outputKey.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isPathWithin(directory: string, candidate: string): boolean {
    return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function resolvedOutput(outdir: string, outputKey: string) {
    const resolvedOutdir = path.resolve(outdir);
    const normalizedKey = normalizedOutputKey(outputKey);
    const cwdRelativePath = path.resolve(normalizedKey);
    const resolvedPath = isPathWithin(resolvedOutdir, cwdRelativePath)
        ? cwdRelativePath
        : path.resolve(resolvedOutdir, normalizedKey);
    if (resolvedPath === resolvedOutdir || !isPathWithin(resolvedOutdir, resolvedPath)) {
        throw new Error(`Frontend build output escaped its directory: ${outputKey}`);
    }
    return {
        filePath: resolvedPath,
        relativePath: path.relative(resolvedOutdir, resolvedPath).replaceAll("\\", "/"),
    };
}

function isFrontendAppInput(inputKey: string, expectedAppInput: string): boolean {
    const normalized = normalizedOutputKey(inputKey);
    const normalizedExpectedInput = normalizedOutputKey(expectedAppInput);
    return (
        normalized === normalizedExpectedInput ||
        normalized.endsWith(`/${normalizedExpectedInput}`)
    );
}

/**
 * Resolves the single JavaScript output that owns the application bootstrap.
 * @param metafile Bun build metadata for the completed browser build.
 * @param expectedAppInput Repository-relative application entrypoint.
 * @returns Resolved the single JavaScript output that owns the application bootstrap.
 */
export function frontendAppOutputKey(
    metafile: Bun.BuildMetafile,
    expectedAppInput: string
): string {
    const candidates = Object.entries(metafile.outputs)
        .filter(
            ([outputKey, output]) =>
                path.extname(outputKey) === ".js" &&
                Object.keys(output.inputs).some((inputKey) =>
                    isFrontendAppInput(inputKey, expectedAppInput)
                )
        )
        .map(([outputKey]) => outputKey);
    if (candidates.length !== 1) {
        throw new Error(
            `Frontend build metadata must contain exactly one ${expectedAppInput} output; found ${candidates.length}`
        );
    }
    return candidates[0]!;
}

/**
 * Works around Bun selecting an unrelated split chunk for the generated HTML
 * module script when metafile output is enabled.
 * @param metafile Bun build metadata for the completed browser build.
 * @param outdir Build output directory containing the generated HTML.
 * @param expectedAppInput Repository-relative application entrypoint.
 * @returns Promise resolving to the write frontend html app entrypoint result.
 */
export async function writeFrontendHtmlAppEntrypoint(
    metafile: Bun.BuildMetafile,
    outdir: string,
    expectedAppInput: string
): Promise<string> {
    const appOutput = resolvedOutput(
        outdir,
        frontendAppOutputKey(metafile, expectedAppInput)
    );
    const publicPath = `/${appOutput.relativePath}`;
    const indexPath = path.join(path.resolve(outdir), "index.html");
    const html = await Bun.file(indexPath).text();
    const moduleScripts = html
        .matchAll(SCRIPT_TAG_PATTERN)
        .filter(
            ([script]) =>
                MODULE_SCRIPT_TYPE_PATTERN.test(script) &&
                SCRIPT_SOURCE_ATTRIBUTE_PATTERN.test(script)
        )
        .toArray();
    if (moduleScripts.length !== 1) {
        throw new Error(
            `Frontend index must contain exactly one module script with a source; found ${moduleScripts.length}`
        );
    }
    const [script] = moduleScripts[0]!;
    const source = script.match(SCRIPT_SOURCE_ATTRIBUTE_PATTERN)?.[2];
    if (!source) {
        throw new Error("Frontend index module script has no source");
    }
    if (source !== publicPath) {
        const correctedScript = script.replace(
            SCRIPT_SOURCE_ATTRIBUTE_PATTERN,
            () => `src="${publicPath}"`
        );
        const scriptIndex = moduleScripts[0]!.index;
        const correctedHtml =
            html.slice(0, scriptIndex) +
            correctedScript +
            html.slice(scriptIndex + script.length);
        await Bun.write(indexPath, correctedHtml);
    }
    return publicPath;
}

/**
 * Resolves the static startup graph while excluding route and feature
 * `dynamic-import` edges.
 * @param metafile Bun build metadata for the completed browser build.
 * @param expectedAppInput Repository-relative application entrypoint.
 * @returns Resolved the static startup graph while excluding route and feature `dynamic-import` edges.
 */
export function initialFrontendOutputKeys(
    metafile: Bun.BuildMetafile,
    expectedAppInput: string
): Set<string> {
    const outputs = metafile.outputs;
    const keyByNormalizedPath = new Map(
        Object.keys(outputs).map((outputKey) => [
            normalizedOutputKey(outputKey),
            outputKey,
        ])
    );
    const resolveOutputKey = (candidate: string): string | undefined =>
        Object.hasOwn(outputs, candidate)
            ? candidate
            : keyByNormalizedPath.get(normalizedOutputKey(candidate));
    const pending = [frontendAppOutputKey(metafile, expectedAppInput)];
    const initialOutputKeys = new Set<string>();

    while (pending.length > 0) {
        const outputKey = pending.pop();
        if (!outputKey || initialOutputKeys.has(outputKey)) continue;
        const output = outputs[outputKey];
        if (!output) continue;
        initialOutputKeys.add(outputKey);

        if (output.cssBundle) {
            const cssOutputKey = resolveOutputKey(output.cssBundle);
            if (cssOutputKey) pending.push(cssOutputKey);
        }
        const staticImports = output.imports.filter(
            ({ kind }) => kind !== "dynamic-import"
        );
        for (const imported of staticImports) {
            const importedOutputKey = resolveOutputKey(imported.path);
            if (importedOutputKey) pending.push(importedOutputKey);
        }
    }

    return initialOutputKeys;
}

function sumOutputs(
    outputs: Iterable<MeasuredOutput>,
    field: "gzipBytes" | "rawBytes"
): number {
    let total = 0;
    for (const output of outputs) total += output[field];
    return total;
}

/**
 * Measures the complete and initial production JavaScript/CSS graphs.
 * @param metafile Bun build metadata for the completed browser build.
 * @param outdir Build output directory containing emitted assets.
 * @param expectedAppInput Repository-relative application entrypoint.
 * @returns Promise resolving to the measure frontend bundle result.
 */
export async function measureFrontendBundle(
    metafile: Bun.BuildMetafile,
    outdir: string,
    expectedAppInput: string
): Promise<FrontendBundleMetrics> {
    const measuredOutputs = new Map<string, MeasuredOutput>();
    for (const outputKey of Object.keys(metafile.outputs)) {
        const extension = path.extname(outputKey);
        if (extension !== ".css" && extension !== ".js") continue;
        const output = resolvedOutput(outdir, outputKey);
        const contents = await Bun.file(output.filePath).bytes();
        measuredOutputs.set(outputKey, {
            gzipBytes: Bun.gzipSync(contents, { level: 9 }).byteLength,
            outputPath: output.relativePath,
            rawBytes: contents.byteLength,
        });
    }

    const initialOutputKeys = initialFrontendOutputKeys(metafile, expectedAppInput);
    const initialFiles = [...initialOutputKeys]
        .map((outputKey) => measuredOutputs.get(outputKey))
        .filter((output): output is MeasuredOutput => output !== undefined)
        .toSorted((left, right) => left.outputPath.localeCompare(right.outputPath));
    const initialJavaScript = initialFiles.filter(({ outputPath }) =>
        outputPath.endsWith(".js")
    );
    const initialStylesheets = initialFiles.filter(({ outputPath }) =>
        outputPath.endsWith(".css")
    );
    const allJavaScript: MeasuredOutput[] = [];
    for (const output of measuredOutputs.values()) {
        if (output.outputPath.endsWith(".js")) allJavaScript.push(output);
    }
    if (initialJavaScript.length === 0) {
        throw new Error(
            "Frontend bundle metadata did not contain an initial JavaScript graph"
        );
    }

    return {
        budgets: FRONTEND_BUNDLE_BUDGETS,
        formatVersion: 1,
        initialFiles,
        measurements: {
            initialJavaScriptGzipBytes: sumOutputs(initialJavaScript, "gzipBytes"),
            initialJavaScriptRawBytes: sumOutputs(initialJavaScript, "rawBytes"),
            initialStylesheetGzipBytes: sumOutputs(initialStylesheets, "gzipBytes"),
            initialStylesheetRawBytes: sumOutputs(initialStylesheets, "rawBytes"),
            largestJavaScriptGzipBytes: Math.max(
                0,
                ...allJavaScript.map(({ gzipBytes }) => gzipBytes)
            ),
            totalJavaScriptGzipBytes: sumOutputs(allJavaScript, "gzipBytes"),
            totalJavaScriptRawBytes: sumOutputs(allJavaScript, "rawBytes"),
        },
    };
}

/**
 * Fails production builds that exceed the checked-in network-size budgets.
 * @param measurements Measured browser bundle sizes.
 */
export function assertFrontendBundleBudgets(
    measurements: FrontendBundleMeasurements
): void {
    const exceeded = Object.entries(FRONTEND_BUNDLE_BUDGETS).filter(
        ([budget, limit]) => measurements[budget as FrontendBundleBudget] > limit
    );
    if (exceeded.length === 0) return;

    throw new Error(
        [
            "Frontend bundle budget exceeded:",
            ...exceeded.map(([budget, limit]) => {
                const actual = measurements[budget as FrontendBundleBudget];
                return `- ${budget}: ${actual} bytes (limit ${limit})`;
            }),
        ].join("\n")
    );
}

/**
 * Writes deterministic Brotli and gzip sidecars for compressible build outputs.
 * @param outputPaths Emitted build assets to inspect and compress.
 * @returns Promise resolving to the write precompressed frontend assets result.
 */
export async function writePrecompressedFrontendAssets(
    outputPaths: Iterable<string>
): Promise<number> {
    let compressedFileCount = 0;

    for (const outputPath of outputPaths) {
        if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(outputPath))) continue;
        const contents = await Bun.file(outputPath).bytes();
        if (contents.byteLength < MINIMUM_COMPRESSION_BYTES) continue;

        const brotliContents = brotliCompressSync(contents, {
            params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
            },
        });
        if (brotliContents.byteLength < contents.byteLength) {
            await Bun.write(`${outputPath}.br`, brotliContents);
            compressedFileCount += 1;
        }

        const gzipContents = Bun.gzipSync(contents, { level: 9 });
        if (gzipContents.byteLength < contents.byteLength) {
            await Bun.write(`${outputPath}.gz`, gzipContents);
            compressedFileCount += 1;
        }
    }

    return compressedFileCount;
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
        const base = new URL("https://build.invalid/");
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

/**
 * Fails when generated HTML would require inline or third-party script/style CSP.
 * @param indexPath Generated HTML entrypoint.
 * @returns Promise that resolves when the entrypoint is self-hosted.
 */
export async function assertSelfHostedFrontendHtml(indexPath: string): Promise<void> {
    const html = await Bun.file(indexPath).text();
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
