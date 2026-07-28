import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

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
    initialJavaScriptGzipBytes: 350 * 1024,
    initialStylesheetGzipBytes: 25 * 1024,
    largestJavaScriptGzipBytes: 75 * 1024,
    totalJavaScriptGzipBytes: 850 * 1024,
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

function outputFilePath(outdir: string, outputKey: string): string {
    const resolvedOutdir = path.resolve(outdir);
    const resolvedPath = path.resolve(resolvedOutdir, normalizedOutputKey(outputKey));
    if (
        resolvedPath !== resolvedOutdir &&
        !resolvedPath.startsWith(`${resolvedOutdir}${path.sep}`)
    ) {
        throw new Error(`Frontend build output escaped its directory: ${outputKey}`);
    }
    return resolvedPath;
}

function isIndexEntryPoint(entryPoint?: string): boolean {
    if (!entryPoint) return false;
    const normalized = entryPoint.replaceAll("\\", "/").replace(/^\.\//u, "");
    return normalized === "index.html" || normalized.endsWith("/index.html");
}

/**
 * Resolves the static startup graph while excluding route and feature
 * `dynamic-import` edges.
 */
export function initialFrontendOutputKeys(metafile: Bun.BuildMetafile): Set<string> {
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
    const pending = Object.entries(outputs)
        .filter(([, output]) => isIndexEntryPoint(output.entryPoint))
        .map(([outputKey]) => outputKey);
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

/** Measures the complete and initial production JavaScript/CSS graphs. */
export async function measureFrontendBundle(
    metafile: Bun.BuildMetafile,
    outdir: string
): Promise<FrontendBundleMetrics> {
    const measuredOutputs = new Map<string, MeasuredOutput>();
    for (const outputKey of Object.keys(metafile.outputs)) {
        const extension = path.extname(outputKey);
        if (extension !== ".css" && extension !== ".js") continue;
        const contents = await readFile(outputFilePath(outdir, outputKey));
        measuredOutputs.set(outputKey, {
            gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
            outputPath: normalizedOutputKey(outputKey),
            rawBytes: contents.byteLength,
        });
    }

    const initialOutputKeys = initialFrontendOutputKeys(metafile);
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

/** Fails production builds that exceed the checked-in network-size budgets. */
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

/** Writes deterministic Brotli and gzip sidecars for compressible build outputs. */
export async function writePrecompressedFrontendAssets(
    outputPaths: Iterable<string>
): Promise<number> {
    let compressedFileCount = 0;

    for (const outputPath of outputPaths) {
        if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(outputPath))) continue;
        const contents = await readFile(outputPath);
        if (contents.byteLength < MINIMUM_COMPRESSION_BYTES) continue;

        const brotliContents = brotliCompressSync(contents, {
            params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
            },
        });
        if (brotliContents.byteLength < contents.byteLength) {
            await writeFile(`${outputPath}.br`, brotliContents);
            compressedFileCount += 1;
        }

        const gzipContents = gzipSync(contents, { level: 9 });
        if (gzipContents.byteLength < contents.byteLength) {
            await writeFile(`${outputPath}.gz`, gzipContents);
            compressedFileCount += 1;
        }
    }

    return compressedFileCount;
}
