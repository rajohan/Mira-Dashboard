import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";

import {
    assertFrontendBundleBudgets,
    FRONTEND_BUNDLE_BUDGETS,
    initialFrontendOutputKeys,
    measureFrontendBundle,
    writePrecompressedFrontendAssets,
} from "../../scripts/frontendBuildArtifacts";

const temporaryRoots = new Set<string>();

async function temporaryOutputRoot(): Promise<string> {
    const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "mira-frontend-build-test-")
    );
    temporaryRoots.add(temporaryRoot);
    await fs.mkdir(path.join(temporaryRoot, "assets"), { recursive: true });
    return temporaryRoot;
}

afterEach(async () => {
    for (const temporaryRoot of temporaryRoots) {
        await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
    temporaryRoots.clear();
});

describe("frontend build artifacts", () => {
    it("measures only static imports in the initial bundle graph", async () => {
        const outdir = await temporaryOutputRoot();
        const entryContents = "export const entry = true;\n";
        const sharedContents = "export const shared = true;\n";
        const lazyContents = "export const lazy = true;\n";
        const stylesheetContents = "body { color: white; }\n";
        await Promise.all([
            fs.writeFile(path.join(outdir, "assets", "entry.js"), entryContents),
            fs.writeFile(path.join(outdir, "assets", "shared.js"), sharedContents),
            fs.writeFile(path.join(outdir, "assets", "lazy.js"), lazyContents),
            fs.writeFile(path.join(outdir, "assets", "styles.css"), stylesheetContents),
        ]);
        const metafile = {
            inputs: {},
            outputs: {
                "./assets/entry.js": {
                    bytes: entryContents.length,
                    cssBundle: "./assets/styles.css",
                    entryPoint: "index.html",
                    exports: [],
                    imports: [
                        {
                            kind: "import-statement",
                            path: "./assets/shared.js",
                        },
                        {
                            kind: "dynamic-import",
                            path: "./assets/lazy.js",
                        },
                    ],
                    inputs: {},
                },
                "./assets/lazy.js": {
                    bytes: lazyContents.length,
                    exports: [],
                    imports: [],
                    inputs: {},
                },
                "./assets/shared.js": {
                    bytes: sharedContents.length,
                    exports: [],
                    imports: [],
                    inputs: {},
                },
                "./assets/styles.css": {
                    bytes: stylesheetContents.length,
                    exports: [],
                    imports: [],
                    inputs: {},
                },
                "./index.html": {
                    bytes: 0,
                    entryPoint: "index.html",
                    exports: [],
                    imports: [],
                    inputs: {},
                },
            },
        } satisfies Bun.BuildMetafile;

        expect(initialFrontendOutputKeys(metafile)).toEqual(
            new Set([
                "./assets/entry.js",
                "./assets/shared.js",
                "./assets/styles.css",
                "./index.html",
            ])
        );

        const metrics = await measureFrontendBundle(metafile, outdir);
        expect(metrics.initialFiles.map(({ outputPath }) => outputPath)).toEqual([
            "assets/entry.js",
            "assets/shared.js",
            "assets/styles.css",
        ]);
        expect(metrics.measurements.initialJavaScriptRawBytes).toBe(
            Buffer.byteLength(entryContents) + Buffer.byteLength(sharedContents)
        );
        expect(metrics.measurements.initialStylesheetRawBytes).toBe(
            Buffer.byteLength(stylesheetContents)
        );
        expect(metrics.measurements.totalJavaScriptRawBytes).toBe(
            Buffer.byteLength(entryContents) +
                Buffer.byteLength(sharedContents) +
                Buffer.byteLength(lazyContents)
        );
    });

    it("writes valid Brotli and gzip sidecars for compressible outputs", async () => {
        const outdir = await temporaryOutputRoot();
        const outputPath = path.join(outdir, "assets", "entry.js");
        const contents = "export const repeated = true;\n".repeat(64);
        await fs.writeFile(outputPath, contents);

        expect(await writePrecompressedFrontendAssets([outputPath])).toBe(2);
        expect(
            brotliDecompressSync(await fs.readFile(`${outputPath}.br`)).toString()
        ).toBe(contents);
        expect(gunzipSync(await fs.readFile(`${outputPath}.gz`)).toString()).toBe(
            contents
        );
    });

    it("fails closed when build metadata has no initial JavaScript graph", async () => {
        const outdir = await temporaryOutputRoot();
        const metafile = {
            inputs: {},
            outputs: {
                "./index.html": {
                    bytes: 0,
                    entryPoint: "index.html",
                    exports: [],
                    imports: [],
                    inputs: {},
                },
            },
        } satisfies Bun.BuildMetafile;

        await expect(measureFrontendBundle(metafile, outdir)).rejects.toThrow(
            "initial JavaScript graph"
        );
    });

    it("reports the specific production budget that was exceeded", () => {
        expect(() =>
            assertFrontendBundleBudgets({
                initialJavaScriptGzipBytes:
                    FRONTEND_BUNDLE_BUDGETS.initialJavaScriptGzipBytes + 1,
                initialJavaScriptRawBytes: 0,
                initialStylesheetGzipBytes: 0,
                initialStylesheetRawBytes: 0,
                largestJavaScriptGzipBytes: 0,
                totalJavaScriptGzipBytes: 0,
                totalJavaScriptRawBytes: 0,
            })
        ).toThrow("initialJavaScriptGzipBytes");
    });
});
